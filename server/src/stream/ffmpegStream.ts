import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { getCurrentWindows, onWindowsChange } from './windowDetector';

type FfmpegProcess = ChildProcessByStdio<null, Readable, Readable>;

// 解像度縮小(帯域・エンコード負荷を面積比で約1/4に)。後から調整できるよう定数化。
const SCALE_WIDTH = 960;
const FRAME_RATE = 15;

// 送信前にws.bufferedAmountを確認し、これを超えていたら最新フレームのみ送る方針でそのフレームを破棄する。
const BACKPRESSURE_THRESHOLD_BYTES = 1 * 1024 * 1024;

// 最初のフレームがこの時間内に届かない場合は異常とみなして配信を終了する
// (Step 0検証1で最小化・画面外配置時の挙動が未確定だったための一律検知)。
const FIRST_FRAME_TIMEOUT_MS = 5000;

const MAX_ACTIVE_STREAMS = Number(process.env.MAX_ACTIVE_STREAMS) || 3;

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

// クライアントへの通知理由とWebSocket close codeの対応表。
// 配信終了系・拒否系のいずれも必ずこの表を通して{type:'ended', reason}を送ってからcloseするため、
// クライアント側はcloseコードを見なくてもendedメッセージのreasonだけ見ればよい。
const CLOSE_CODES = {
  superseded: 4000,
  spawn_failed: 4001,
  stream_limit: 4003,
  invalid_window_id: 4004,
  window_not_found: 4005,
  window_closed: 4006,
  ffmpeg_exit: 4007,
  timeout: 4008,
  client_closed: 1000,
} as const;

type EndReason = keyof typeof CLOSE_CODES;

interface StreamEntry {
  ffmpeg: FfmpegProcess;
  ws: WebSocket;
  unsubscribeWindowChange: () => void;
  firstFrameTimer: ReturnType<typeof setTimeout>;
}

// windowIdごとに最大1つのffmpegプロセス(同一idへの接続は後勝ち)
const activeStreams = new Map<string, StreamEntry>();

function endConnection(ws: WebSocket, reason: EndReason): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'ended', reason }));
  }
  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
    ws.close(CLOSE_CODES[reason], reason);
  }
}

function closeStream(windowId: string, reason: EndReason): void {
  const entry = activeStreams.get(windowId);
  if (!entry) return;
  activeStreams.delete(windowId);
  clearTimeout(entry.firstFrameTimer);
  entry.unsubscribeWindowChange();
  try {
    entry.ffmpeg.kill();
  } catch {
    // 既に終了済みのプロセスへのkill()はESRCH等でthrowすることがある。
  }
  endConnection(entry.ws, reason);
}

function spawnFfmpeg(windowId: string): FfmpegProcess {
  return spawn(
    'ffmpeg',
    [
      '-f', 'x11grab',
      '-window_id', windowId,
      '-i', process.env.DISPLAY || ':0',
      '-vf', `scale=${SCALE_WIDTH}:-1`,
      '-r', String(FRAME_RATE),
      '-f', 'mjpeg',
      '-q:v', '5',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

export function registerWindowStreamWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // モバイル回線切断等で'error'が発生し得る。リスナーが無いとNodeプロセスごと落ちるため必須。
    ws.on('error', () => {});

    const { pathname } = new URL(req.url ?? '', 'http://localhost');
    const match = pathname.match(/^\/ws\/window\/(.+)$/);
    let windowId: string | undefined;
    try {
      windowId = match?.[1] ? decodeURIComponent(match[1]) : undefined;
    } catch {
      windowId = undefined; // 不正なパーセントエンコーディング(例: %zz)によるURIError
    }
    if (!windowId) {
      endConnection(ws, 'invalid_window_id');
      return;
    }

    if (!getCurrentWindows().some((w) => w.id === windowId)) {
      endConnection(ws, 'window_not_found');
      return;
    }

    // 同一idへの接続は後勝ち。既存があれば置き換える(新規接続とは別枠なのでMAX_ACTIVE_STREAMSは消費しない)。
    if (activeStreams.has(windowId)) {
      closeStream(windowId, 'superseded');
    } else if (activeStreams.size >= MAX_ACTIVE_STREAMS) {
      endConnection(ws, 'stream_limit');
      return;
    }

    let ffmpeg: FfmpegProcess;
    try {
      ffmpeg = spawnFfmpeg(windowId);
    } catch {
      endConnection(ws, 'spawn_failed');
      return;
    }

    // ffmpegバイナリ不在(ENOENT)等はここで非同期に通知される。spawn()自体は同期throwしないため
    // このリスナーが無いとuncaught exceptionでNodeプロセスごと落ちる(wsの'error'と同じ理由)。
    ffmpeg.on('error', (err) => {
      if (activeStreams.get(windowId)?.ffmpeg !== ffmpeg) return;
      console.error(`[ffmpegStream] window ${windowId}: failed to spawn ffmpeg: ${err.message}`);
      closeStream(windowId, 'spawn_failed');
    });

    let buffer = Buffer.alloc(0);
    let firstFrameReceived = false;

    const firstFrameTimer = setTimeout(() => {
      if (!firstFrameReceived) {
        closeStream(windowId, 'timeout');
      }
    }, FIRST_FRAME_TIMEOUT_MS);

    const unsubscribeWindowChange = onWindowsChange((windows) => {
      if (!windows.some((w) => w.id === windowId)) {
        closeStream(windowId, 'window_closed');
      }
    });

    activeStreams.set(windowId, { ffmpeg, ws, unsubscribeWindowChange, firstFrameTimer });

    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      // ffmpeg標準出力はフレーム境界の通知がない連続バイト列なので、SOI〜EOIで1フレームずつ切り出す。
      for (;;) {
        const start = buffer.indexOf(JPEG_SOI);
        if (start === -1) {
          // 末尾1バイトがSOIの前半(0xFF)でチャンク境界が割れている可能性があるため、その場合だけ残す。
          buffer = buffer.length > 0 && buffer[buffer.length - 1] === 0xff ? buffer.subarray(buffer.length - 1) : Buffer.alloc(0);
          break;
        }
        const end = buffer.indexOf(JPEG_EOI, start + 2);
        if (end === -1) {
          if (start > 0) buffer = buffer.subarray(start);
          break;
        }
        const frame = buffer.subarray(start, end + 2);
        buffer = buffer.subarray(end + 2);

        if (!firstFrameReceived) {
          firstFrameReceived = true;
          clearTimeout(firstFrameTimer);
        }

        if (ws.readyState === ws.OPEN && ws.bufferedAmount <= BACKPRESSURE_THRESHOLD_BYTES) {
          ws.send(frame);
        }
      }
    });

    let ffmpegStderrTail = '';
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      ffmpegStderrTail = (ffmpegStderrTail + chunk.toString()).slice(-4000);
    });

    ffmpeg.on('exit', (exitCode, signal) => {
      // 既にsupersede/close済みでこのffmpegが現行エントリでなければ何もしない。
      if (activeStreams.get(windowId)?.ffmpeg !== ffmpeg) return;

      const killedByUs = signal === 'SIGTERM' || signal === 'SIGKILL';
      if (!killedByUs && exitCode !== 0) {
        console.error(`[ffmpegStream] window ${windowId}: ffmpeg exited abnormally (code=${exitCode}, signal=${signal})\n${ffmpegStderrTail}`);
      }
      closeStream(windowId, 'ffmpeg_exit');
    });

    ws.on('close', () => {
      if (activeStreams.get(windowId)?.ws === ws) {
        closeStream(windowId, 'client_closed');
      }
    });
  });
}
