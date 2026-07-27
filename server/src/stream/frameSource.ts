// ウィンドウ映像のフレーム供給をOS別に抽象化する。
// - Linux: ffmpeg(x11grab)を常駐させ、mjpegストリームからJPEGフレームを切り出す
// - macOS: ffmpegのavfoundationはウィンドウ単位のキャプチャに非対応のため、
//   OS標準のscreencapture(-l <CGWindowID>)+sips(縮小)を定期実行してフレームを作る
// 利用側(ffmpegStream.ts)は"frame"/"end"イベントとstop()だけを扱い、OS差を意識しない。

import { EventEmitter } from "node:events";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { DISPLAY, IS_MAC } from "../config";

export const SCALE_WIDTH = 960;
const FRAME_RATE = 15; // Linux(ffmpeg)のみ。macOSの実効fpsはMAC_CAPTURE_INTERVAL_MSで決まる

// screencaptureは1枚ごとにプロセス起動+ファイルI/Oのコストがあるため約2fpsに抑える
const MAC_CAPTURE_INTERVAL_MS = 500;
// 単発の失敗(一時的なウィンドウ状態等)は握りつぶし、連続失敗のみ異常として配信を終了する
const MAC_MAX_CONSECUTIVE_FAILURES = 3;

// 理由名はshared/protocol.tsのWindowStreamEndReasonの部分集合。
// "ffmpeg_exit"はmacOSではscreencaptureの連続失敗も表す(クライアント表示は汎用文言のため流用)
export type FrameSourceEndReason = "spawn_failed" | "ffmpeg_exit";

export interface FrameSourceEndEvent {
  reason: FrameSourceEndReason;
  detail?: string;
}

// イベント: "frame" (jpeg: Buffer) / "end" (FrameSourceEndEvent、最大1回、stop()後は発火しない)
export interface FrameSource extends EventEmitter {
  stop(): void;
  describe(): string; // ログ用の識別子(pid等)
}

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

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

type FfmpegProcess = ChildProcessByStdio<null, Readable, Readable>;

class FfmpegFrameSource extends EventEmitter implements FrameSource {
  private ffmpeg: FfmpegProcess | null = null;
  private finished = false;
  private stderrTail = "";
  // Buffer.alloc()はBuffer<ArrayBuffer>を返しBuffer.concat()由来の値と型引数が食い違うため、
  // extractJpegFramesが返すBuffer(Buffer<ArrayBufferLike>)と揃うよう明示的に型注釈する
  private buffer: Buffer = Buffer.alloc(0);

  constructor(windowId: string) {
    super();
    let ffmpeg: FfmpegProcess;
    try {
      ffmpeg = spawn(
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
    } catch {
      // 呼び出し側がリスナーを張る前に発火しないよう非同期化する
      process.nextTick(() => this.finish("spawn_failed"));
      return;
    }
    this.ffmpeg = ffmpeg;

    // ffmpegバイナリ不在(ENOENT)等はspawn()の同期throwではなくここで非同期に通知される
    ffmpeg.on("error", (err) => {
      this.finish("spawn_failed", err.message);
    });

    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      if (this.finished) return;
      const { frames, rest } = extractJpegFrames(
        Buffer.concat([this.buffer, chunk]),
      );
      this.buffer = rest;
      for (const frame of frames) {
        this.emit("frame", frame);
      }
    });

    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });

    ffmpeg.on("exit", (exitCode, signal) => {
      const killedByUs = signal === "SIGTERM" || signal === "SIGKILL";
      const detail =
        !killedByUs && exitCode !== 0
          ? `ffmpeg exited abnormally (code=${exitCode}, signal=${signal})\n${this.stderrTail}`
          : undefined;
      this.finish("ffmpeg_exit", detail);
    });
  }

  describe(): string {
    return `ffmpeg pid=${this.ffmpeg?.pid}`;
  }

  stop(): void {
    this.finished = true;
    this.killProcess();
  }

  private killProcess(): void {
    try {
      this.ffmpeg?.kill();
    } catch {
      // 既に終了済みのプロセスへのkillはESRCH等で例外になりうるため無視する
    }
  }

  private finish(reason: FrameSourceEndReason, detail?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.killProcess();
    const event: FrameSourceEndEvent = { reason, detail };
    this.emit("end", event);
  }
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
        return;
      }
      resolve();
    });
  });
}

class MacScreencaptureFrameSource extends EventEmitter implements FrameSource {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tmpDir: string | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly windowId: string) {
    super();
    void this.start();
  }

  describe(): string {
    return "screencapture loop";
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.cleanupTmpDir();
  }

  private cleanupTmpDir(): void {
    const dir = this.tmpDir;
    this.tmpDir = null;
    if (dir) {
      rm(dir, { recursive: true, force: true }).catch(() => {
        // 一時ディレクトリの削除失敗は実害がないため無視する
      });
    }
  }

  private finish(reason: FrameSourceEndReason, detail?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.cleanupTmpDir();
    const event: FrameSourceEndEvent = { reason, detail };
    this.emit("end", event);
  }

  private async start(): Promise<void> {
    try {
      this.tmpDir = await mkdtemp(path.join(os.tmpdir(), "remote-console-frame-"));
    } catch (err) {
      this.finish("spawn_failed", (err as Error).message);
      return;
    }
    // mkdtemp中にstop()された場合、stop()側はtmpDir未設定で削除できていないためここで消す
    if (this.stopped) {
      this.cleanupTmpDir();
      return;
    }
    void this.captureLoop();
  }

  private async captureLoop(): Promise<void> {
    const startedAt = Date.now();
    const filePath = path.join(this.tmpDir!, "frame.jpg");
    try {
      // 画面収録(Screen Recording)権限が無いと"could not create image from window"で失敗する
      await execFileAsync("screencapture", [
        "-x", // 無音
        "-o", // ウィンドウの影を含めない
        "-t",
        "jpg",
        "-l",
        this.windowId,
        filePath,
      ]);
      // Retinaの等倍キャプチャは巨大なため、Linux版のscale=960:-1と同じ幅に縮小して帯域を揃える
      await execFileAsync("sips", [
        "--resampleWidth",
        String(SCALE_WIDTH),
        filePath,
      ]);
      const jpeg = await readFile(filePath);
      if (this.stopped) return;
      this.consecutiveFailures = 0;
      this.emit("frame", jpeg);
    } catch (err) {
      if (this.stopped) return;
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= MAC_MAX_CONSECUTIVE_FAILURES) {
        this.finish(
          "ffmpeg_exit",
          `screencapture failed ${this.consecutiveFailures} times: ${(err as Error).message}`,
        );
        return;
      }
    }
    const elapsed = Date.now() - startedAt;
    this.timer = setTimeout(
      () => void this.captureLoop(),
      Math.max(0, MAC_CAPTURE_INTERVAL_MS - elapsed),
    );
  }
}

export function createFrameSource(windowId: string): FrameSource {
  return IS_MAC
    ? new MacScreencaptureFrameSource(windowId)
    : new FfmpegFrameSource(windowId);
}
