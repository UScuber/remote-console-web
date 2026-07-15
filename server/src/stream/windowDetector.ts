import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import type { WebSocket, WebSocketServer } from "ws";
import { suppressSocketErrors } from "../wsSafety";
import { WINDOW_TITLE_EXCLUDE } from "../config";
import type { WindowInfo, WindowsListMessage } from "remote-console-shared";

const POLL_INTERVAL_MS = 2000;

// 出力はid desktop host titleの空白区切りだが、titleは残りの空白・タブも含めそのまま扱う
const WMCTRL_LINE_RE = /^(\S+)\s+\S+\s+\S+\s+(.*)$/;

const emitter = new EventEmitter();
let current: WindowInfo[] = [];
// 状態遷移時のみログを出す(起動直後のXセッション確立待ちで失敗が続いてもログを埋めない)
let consecutiveFailures = 0;

export function parseWmctrlOutput(stdout: string): WindowInfo[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const m = line.match(WMCTRL_LINE_RE);
      return { id: m?.[1] ?? "", title: m?.[2] ?? "" };
    })
    .filter((w) => w.id.length > 0)
    .filter((w) => !WINDOW_TITLE_EXCLUDE.some((sub) => w.title.includes(sub)));
}

function sameList(a: WindowInfo[], b: WindowInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((w, i) => w.id === b[i].id && w.title === b[i].title);
}

function poll(): void {
  execFile("wmctrl", ["-l"], (err, stdout) => {
    if (err) {
      consecutiveFailures += 1;
      if (consecutiveFailures === 1) {
        console.debug(
          "[windowDetector] wmctrl -l failed (will keep retrying):",
          err.message,
        );
      }
      return;
    }
    if (consecutiveFailures > 0) {
      console.debug("[windowDetector] wmctrl -l recovered");
    }
    consecutiveFailures = 0;

    const next = parseWmctrlOutput(stdout);
    if (!sameList(current, next)) {
      current = next;
      emitter.emit("change", current);
    }
  });
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
