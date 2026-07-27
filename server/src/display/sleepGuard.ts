// 遠隔監視中にホスト側がスリープ・アイドル状態にならないようにする仕組み。OS別に方式が異なる:
// - Linux: マウスの微小移動を定期送信し続け、GNOME側のアイドル判定自体を起こさせない
// - macOS: OS標準のcaffeinateを常駐させ、ディスプレイ・システムのスリープを直接抑止する
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { IS_MAC } from "../config";

const HEARTBEAT_INTERVAL_MS = 15000;

let enabled = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null; // Linux(xdotool)用
let caffeinateProcess: ChildProcess | null = null; // macOS用

function runXdotool(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("xdotool", args, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

// 1px動かしてすぐ戻すことで、カーソル位置や操作中の他アプリへの影響を残さない
async function jiggleMouse(): Promise<void> {
  await runXdotool(["mousemove_relative", "--", "1", "0"]);
  await runXdotool(["mousemove_relative", "--", "-1", "0"]);
}

// -d: ディスプレイ, -i: システムアイドル, -m: ディスク, -s: システム(AC接続時)のスリープを抑止
function startCaffeinate(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("caffeinate", ["-dims"], { stdio: "ignore" });
    child.once("error", (err) => {
      if (caffeinateProcess === child) caffeinateProcess = null;
      reject(err);
    });
    child.once("spawn", () => {
      caffeinateProcess = child;
      resolve();
    });
    child.on("exit", (code, signal) => {
      // stopCaffeinate()による意図的な終了(その時点でnull化済み)以外は異常なので状態をOFFに戻す
      if (caffeinateProcess !== child) return;
      caffeinateProcess = null;
      enabled = false;
      console.error(
        `[sleepGuard] caffeinate exited unexpectedly (code=${code}, signal=${signal})`,
      );
    });
  });
}

function stopCaffeinate(): void {
  const child = caffeinateProcess;
  caffeinateProcess = null;
  if (!child) return;
  try {
    child.kill();
  } catch {
    // 既に終了済みのプロセスへのkillはESRCH等で例外になりうるため無視する
  }
}

export function getSleepGuardEnabled(): boolean {
  return enabled;
}

export async function setSleepGuardEnabled(next: boolean): Promise<void> {
  if (next === enabled) return;

  if (IS_MAC) {
    if (next) {
      await startCaffeinate();
    } else {
      stopCaffeinate();
    }
  } else if (next) {
    // ONにした瞬間から効果を出すため即座に1回実行してからハートビートを開始する
    await jiggleMouse();
    heartbeatTimer = setInterval(() => {
      jiggleMouse().catch((err) => {
        console.error("[sleepGuard] jiggleMouse failed:", (err as Error).message);
      });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();
  } else if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  enabled = next;
}

// SIGTERM等でのgraceful shutdown用。caffeinateは親プロセスが死んでも自動では終了しないため明示的に殺す
export function shutdownSleepGuard(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  stopCaffeinate();
  enabled = false;
}
