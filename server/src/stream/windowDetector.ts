// デスクトップ上のウィンドウ一覧を定期取得し、変化があればWebSocketでクライアントへ配信する。
// 一覧の取得コマンドはOS別: Linuxはwmctrl、macOSはosascript(JXA)経由のCGWindowListCopyWindowInfo。

import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import type { WebSocket, WebSocketServer } from "ws";
import { suppressSocketErrors } from "../wsSafety";
import { WINDOW_TITLE_EXCLUDE, IS_MAC } from "../config";
import type { WindowInfo, WindowsListMessage } from "remote-console-shared";

const POLL_INTERVAL_MS = 2000;

// 出力はid desktop host titleの空白区切りだが、titleは残りの空白・タブも含めそのまま扱う
const WMCTRL_LINE_RE = /^(\S+)\s+\S+\s+\S+\s+(.*)$/;

// CGWindowListCopyWindowInfoで通常ウィンドウ(layer 0)を列挙する。idはCGWindowID。
// ウィンドウタイトル(kCGWindowName)は画面収録(Screen Recording)権限が無いと取得できず、
// その場合はアプリ名(kCGWindowOwnerName)のみになる。
// 注意: CFArrayRefはObjC.deepUnwrap単体・$.CFBridgingRelease経由では変換できない
// (後者はosascriptがクラッシュする)ため、ObjC.castRefToObjectを経由する。
const LIST_WINDOWS_JXA = `
ObjC.import("CoreGraphics");
const opts = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(opts, $.kCGNullWindowID))) || [];
const windows = list
  .filter(function (w) { return w.kCGWindowLayer === 0; })
  .map(function (w) {
    const owner = w.kCGWindowOwnerName || "";
    const name = w.kCGWindowName || "";
    return { id: String(w.kCGWindowNumber), title: name ? owner + " - " + name : owner };
  })
  .filter(function (w) { return w.title.length > 0; });
JSON.stringify(windows);
`;

const emitter = new EventEmitter();
let current: WindowInfo[] = [];
// 状態遷移時のみログを出す(起動直後のセッション確立待ちで失敗が続いてもログを埋めない)
let consecutiveFailures = 0;

function applyExcludeFilter(windows: WindowInfo[]): WindowInfo[] {
  return windows.filter(
    (w) => !WINDOW_TITLE_EXCLUDE.some((sub) => w.title.includes(sub)),
  );
}

export function parseWmctrlOutput(stdout: string): WindowInfo[] {
  return applyExcludeFilter(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const m = line.match(WMCTRL_LINE_RE);
        return { id: m?.[1] ?? "", title: m?.[2] ?? "" };
      })
      .filter((w) => w.id.length > 0),
  );
}

// osascriptの出力(JSON)をWindowInfo[]へ変換する。JSONが壊れていればthrowし、poll側で失敗扱いにする。
export function parseMacWindowList(stdout: string): WindowInfo[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("window list is not an array");
  }
  const windows = parsed
    .map((w): WindowInfo => {
      const { id, title } = w as Partial<WindowInfo>;
      return {
        id: typeof id === "string" ? id : "",
        title: typeof title === "string" ? title : "",
      };
    })
    .filter((w) => w.id.length > 0);
  // CGWindowListの並びは前面順でフォーカス移動のたびに入れ替わり、変化通知が無駄に発火するため
  // ID順(ほぼ生成順)に並べ替えて安定させる
  windows.sort((a, b) => Number(a.id) - Number(b.id));
  return applyExcludeFilter(windows);
}

function sameList(a: WindowInfo[], b: WindowInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((w, i) => w.id === b[i].id && w.title === b[i].title);
}

function handlePollResult(
  commandLabel: string,
  err: Error | null,
  parse: () => WindowInfo[],
): void {
  let next: WindowInfo[] | null = null;
  if (!err) {
    try {
      next = parse();
    } catch (parseErr) {
      err = parseErr as Error;
    }
  }

  if (err || next === null) {
    consecutiveFailures += 1;
    if (consecutiveFailures === 1) {
      console.debug(
        `[windowDetector] ${commandLabel} failed (will keep retrying):`,
        err?.message,
      );
    }
    return;
  }
  if (consecutiveFailures > 0) {
    console.debug(`[windowDetector] ${commandLabel} recovered`);
  }
  consecutiveFailures = 0;

  if (!sameList(current, next)) {
    current = next;
    emitter.emit("change", current);
  }
}

function poll(): void {
  if (IS_MAC) {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", LIST_WINDOWS_JXA],
      (err, stdout) => {
        handlePollResult("osascript window list", err, () =>
          parseMacWindowList(stdout),
        );
      },
    );
  } else {
    execFile("wmctrl", ["-l"], (err, stdout) => {
      handlePollResult("wmctrl -l", err, () => parseWmctrlOutput(stdout));
    });
  }
}

let started = false;

export function startWindowDetector(): void {
  if (started) return;
  started = true;
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

export function getCurrentWindows(): WindowInfo[] {
  return current;
}

export function onWindowsChange(
  listener: (windows: WindowInfo[]) => void,
): () => void {
  emitter.on("change", listener);
  return () => emitter.off("change", listener);
}

function toWindowsListMessage(windows: WindowInfo[]): WindowsListMessage {
  return { type: "windows", windows };
}

export function registerWindowsWebSocket(wss: WebSocketServer): void {
  wss.on("connection", (ws: WebSocket) => {
    suppressSocketErrors(ws);

    ws.send(JSON.stringify(toWindowsListMessage(current)));

    const unsubscribe = onWindowsChange((windows) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(toWindowsListMessage(windows)));
      }
    });

    ws.on("close", () => {
      unsubscribe();
    });
  });
}
