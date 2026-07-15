import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";
import { getCurrentWindows, onWindowsChange } from "./windowDetector";
import { suppressSocketErrors } from "../wsSafety";
import { MAX_ACTIVE_STREAMS as MAX_ACTIVE_STREAMS_CONFIG, DISPLAY } from "../config";
import {
  WINDOW_STREAM_CLOSE_CODES as CLOSE_CODES,
  type WindowStreamEndReason as EndReason,
  type WindowStreamActiveMessage,
  type WindowStreamEndedMessage,
} from "remote-console-shared";

type FfmpegProcess = ChildProcessByStdio<null, Readable, Readable>;

const SCALE_WIDTH = 960;
const FRAME_RATE = 15;

// これを超えるフレームは古い順ではなく丸ごと破棄し、常に最新映像を優先する
const BACKPRESSURE_THRESHOLD_BYTES = 1 * 1024 * 1024;

// 最小化・画面外配置時のx11grab挙動が機種依存で不定なため、一律タイムアウトで異常を検知する
const FIRST_FRAME_TIMEOUT_MS = 5000;

// 非アクティブなストリームはここで送信自体を間引く(クライアント側の受信後破棄では帯域が減らない)
const STATIC_STREAM_INTERVAL_MS = 3000;

// クライアント側の二重防御(WindowPicker)でも同じ値を使うため export する
export const MAX_ACTIVE_STREAMS = MAX_ACTIVE_STREAMS_CONFIG;

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

// reasonの型・close codeの対応はshared/protocol.tsのWindowStreamEndReason/WINDOW_STREAM_CLOSE_CODES。
// client側のWindowStream.tsxのEND_REASON_LABELはこの型を使い網羅性をコンパイラに保証させている。

interface StreamEntry {
  ffmpeg: FfmpegProcess;
  ws: WebSocket;
  unsubscribeWindowChange: () => void;
  firstFrameTimer: ReturnType<typeof setTimeout>;
  active: boolean;
  lastSentAt: number;
}

// windowIdごとに最大1つのffmpegプロセス、同一idへの接続は後勝ち
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
  try {
    entry.ffmpeg.kill();
  } catch {
    // 既に終了済みのプロセスへのkillはESRCH等で例外になりうるため無視する
  }
  endConnection(entry.ws, reason);
}

// SIGTERM等でのgraceful shutdown用
export function shutdownStreams(): void {
  for (const windowId of [...activeStreams.keys()]) {
    closeStream(windowId, "server_shutdown");
  }
}

function spawnFfmpeg(windowId: string): FfmpegProcess {
  return spawn(
    "ffmpeg",
    [
      "-f",
      "x11grab",
      "-window_id",
      windowId,
      "-i",
      DISPLAY,
      "-vf",
      `scale=${SCALE_WIDTH}:-1`,
      "-r",
      String(FRAME_RATE),
      "-f",
      "mjpeg",
      "-q:v",
      "5",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

// ffmpegのstdoutは連続バイト列でフレーム境界の通知が無いため、SOI(0xFFD8)〜EOI(0xFFD9)の
// マーカーで1フレームずつ切り出す。チャンク境界でマーカーが割れるケースがあるため、
// 未確定分はrestとして呼び出し側に返し次のチャンクと結合させる。
export function extractJpegFrames(buffer: Buffer): {
  frames: Buffer[];
  rest: Buffer;
} {
  const frames: Buffer[] = [];
  let rest = buffer;
  for (;;) {
    const start = rest.indexOf(JPEG_SOI);
    if (start === -1) {
      // 末尾がSOIの前半(0xFF)だけの場合はチャンク境界で割れている可能性があるので残す
      rest =
        rest.length > 0 && rest[rest.length - 1] === 0xff
          ? rest.subarray(rest.length - 1)
          : Buffer.alloc(0);
      break;
    }
    const end = rest.indexOf(JPEG_EOI, start + 2);
    if (end === -1) {
      if (start > 0) rest = rest.subarray(start);
      break;
    }
    frames.push(rest.subarray(start, end + 2));
    rest = rest.subarray(end + 2);
  }
  return { frames, rest };
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

    let ffmpeg: FfmpegProcess;
    try {
      ffmpeg = spawnFfmpeg(windowId);
    } catch {
      endConnection(ws, "spawn_failed");
      return;
    }
    console.log(
      `[ffmpegStream] window ${windowId}: stream starting (pid=${ffmpeg.pid})`,
    );

    // ffmpegバイナリ不在(ENOENT)等はspawn()の同期throwではなくここで非同期に通知される
    ffmpeg.on("error", (err) => {
      if (activeStreams.get(windowId)?.ffmpeg !== ffmpeg) return;
      console.error(
        `[ffmpegStream] window ${windowId}: failed to spawn ffmpeg: ${err.message}`,
      );
      closeStream(windowId, "spawn_failed");
    });

    // Buffer.alloc()はBuffer<ArrayBuffer>を返しBuffer.concat()由来の値と型引数が食い違うため、
    // extractJpegFramesが返すBuffer(Buffer<ArrayBufferLike>)と揃うよう明示的に型注釈する
    let buffer: Buffer = Buffer.alloc(0);
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
      ffmpeg,
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

    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      const { frames, rest } = extractJpegFrames(Buffer.concat([buffer, chunk]));
      buffer = rest;

      for (const frame of frames) {
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
      }
    });

    let ffmpegStderrTail = "";
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      ffmpegStderrTail = (ffmpegStderrTail + chunk.toString()).slice(-4000);
    });

    ffmpeg.on("exit", (exitCode, signal) => {
      // 既にsuperseded等で置き換わっていれば何もしない
      if (activeStreams.get(windowId)?.ffmpeg !== ffmpeg) return;

      const killedByUs = signal === "SIGTERM" || signal === "SIGKILL";
      if (!killedByUs && exitCode !== 0) {
        console.error(
          `[ffmpegStream] window ${windowId}: ffmpeg exited abnormally (code=${exitCode}, signal=${signal})\n${ffmpegStderrTail}`,
        );
      }
      closeStream(windowId, "ffmpeg_exit");
    });

    ws.on("close", () => {
      if (activeStreams.get(windowId)?.ws === ws) {
        closeStream(windowId, "client_closed");
      }
    });
  });
}
