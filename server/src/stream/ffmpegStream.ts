// ウィンドウ映像配信のWebSocketハンドラ。フレームの取得方法はOS別にframeSource.tsへ分離しており、
// ここでは接続管理・帯域制御(バックプレッシャー/非アクティブ間引き)・異常検知だけを扱う。

import type { IncomingMessage } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import { getCurrentWindows, onWindowsChange } from "./windowDetector";
import {
  createFrameSource,
  type FrameSource,
  type FrameSourceEndEvent,
} from "./frameSource";
import { suppressSocketErrors } from "../wsSafety";
import { MAX_ACTIVE_STREAMS as MAX_ACTIVE_STREAMS_CONFIG } from "../config";
import {
  WINDOW_STREAM_CLOSE_CODES as CLOSE_CODES,
  type WindowStreamEndReason as EndReason,
  type WindowStreamActiveMessage,
  type WindowStreamEndedMessage,
} from "remote-console-shared";

// これを超えるフレームは古い順ではなく丸ごと破棄し、常に最新映像を優先する
const BACKPRESSURE_THRESHOLD_BYTES = 1 * 1024 * 1024;

// 最小化・画面外配置時のキャプチャ挙動が機種依存で不定なため、一律タイムアウトで異常を検知する
const FIRST_FRAME_TIMEOUT_MS = 5000;

// 非アクティブなストリームはここで送信自体を間引く(クライアント側の受信後破棄では帯域が減らない)
const STATIC_STREAM_INTERVAL_MS = 3000;

// クライアント側の二重防御(WindowPicker)でも同じ値を使うため export する
export const MAX_ACTIVE_STREAMS = MAX_ACTIVE_STREAMS_CONFIG;

// reasonの型・close codeの対応はshared/protocol.tsのWindowStreamEndReason/WINDOW_STREAM_CLOSE_CODES。
// client側のWindowStream.tsxのEND_REASON_LABELはこの型を使い網羅性をコンパイラに保証させている。

interface StreamEntry {
  source: FrameSource;
  ws: WebSocket;
  unsubscribeWindowChange: () => void;
  firstFrameTimer: ReturnType<typeof setTimeout>;
  active: boolean;
  lastSentAt: number;
}

// windowIdごとに最大1つのフレームソース、同一idへの接続は後勝ち
const activeStreams = new Map<string, StreamEntry>();

function endConnection(ws: WebSocket, reason: EndReason): void {
  if (ws.readyState === ws.OPEN) {
    const msg: WindowStreamEndedMessage = { type: "ended", reason };
    ws.send(JSON.stringify(msg));
  }
  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
    ws.close(CLOSE_CODES[reason], reason);
  }
}

function closeStream(windowId: string, reason: EndReason): void {
  const entry = activeStreams.get(windowId);
  if (!entry) return;
  activeStreams.delete(windowId);
  console.log(`[ffmpegStream] window ${windowId}: stream ended (reason=${reason})`);
  clearTimeout(entry.firstFrameTimer);
  entry.unsubscribeWindowChange();
  entry.source.stop();
  endConnection(entry.ws, reason);
}

// SIGTERM等でのgraceful shutdown用
export function shutdownStreams(): void {
  for (const windowId of [...activeStreams.keys()]) {
    closeStream(windowId, "server_shutdown");
  }
}

export function registerWindowStreamWebSocket(wss: WebSocketServer): void {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    suppressSocketErrors(ws);

    const { pathname } = new URL(req.url ?? "", "http://localhost");
    const match = pathname.match(/^\/ws\/window\/(.+)$/);
    let windowId: string | undefined;
    try {
      windowId = match?.[1] ? decodeURIComponent(match[1]) : undefined;
    } catch {
      windowId = undefined; // 不正なパーセントエンコーディング(例: %zz)によるURIError
    }
    if (!windowId) {
      endConnection(ws, "invalid_window_id");
      return;
    }

    if (!getCurrentWindows().some((w) => w.id === windowId)) {
      endConnection(ws, "window_not_found");
      return;
    }

    // 置き換えは新規接続の別枠なのでMAX_ACTIVE_STREAMSを消費しない
    if (activeStreams.has(windowId)) {
      closeStream(windowId, "superseded");
    } else if (activeStreams.size >= MAX_ACTIVE_STREAMS) {
      endConnection(ws, "stream_limit");
      return;
    }

    const source = createFrameSource(windowId);
    console.log(
      `[ffmpegStream] window ${windowId}: stream starting (${source.describe()})`,
    );

    let firstFrameReceived = false;

    const firstFrameTimer = setTimeout(() => {
      if (!firstFrameReceived) {
        closeStream(windowId, "timeout");
      }
    }, FIRST_FRAME_TIMEOUT_MS);

    const unsubscribeWindowChange = onWindowsChange((windows) => {
      if (!windows.some((w) => w.id === windowId)) {
        closeStream(windowId, "window_closed");
      }
    });

    // 最初の{type:active}到着まではフル解像度fps側に倒しておく(安全側のデフォルト)
    activeStreams.set(windowId, {
      source,
      ws,
      unsubscribeWindowChange,
      firstFrameTimer,
      active: true,
      lastSentAt: 0,
    });

    ws.on("message", (raw) => {
      const entry = activeStreams.get(windowId);
      if (!entry || entry.ws !== ws) return;
      try {
        const msg = JSON.parse(raw.toString()) as Partial<WindowStreamActiveMessage>;
        if (msg.type === "active" && typeof msg.value === "boolean") {
          entry.active = msg.value;
        }
      } catch {
        // 不正なJSONは無視
      }
    });

    source.on("frame", (frame: Buffer) => {
      if (!firstFrameReceived) {
        firstFrameReceived = true;
        clearTimeout(firstFrameTimer);
        console.log(`[ffmpegStream] window ${windowId}: first frame received`);
      }

      const entry = activeStreams.get(windowId);
      const now = Date.now();
      const dueForStaticUpdate =
        !entry ||
        entry.active ||
        now - entry.lastSentAt >= STATIC_STREAM_INTERVAL_MS;
      if (
        dueForStaticUpdate &&
        ws.readyState === ws.OPEN &&
        ws.bufferedAmount <= BACKPRESSURE_THRESHOLD_BYTES
      ) {
        if (entry) entry.lastSentAt = now;
        ws.send(frame);
      }
    });

    source.on("end", ({ reason, detail }: FrameSourceEndEvent) => {
      // 既にsuperseded等で置き換わっていれば何もしない
      if (activeStreams.get(windowId)?.source !== source) return;
      if (detail) {
        console.error(`[ffmpegStream] window ${windowId}: ${detail}`);
      }
      closeStream(windowId, reason);
    });

    ws.on("close", () => {
      if (activeStreams.get(windowId)?.ws === ws) {
        closeStream(windowId, "client_closed");
      }
    });
  });
}
