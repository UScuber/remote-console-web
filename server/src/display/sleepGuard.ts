import { execFile } from "node:child_process";

// マウスの微小移動を定期送信し続け、
// GNOME側のアイドル判定自体を起こさせないようにする
const HEARTBEAT_INTERVAL_MS = 15000;

let enabled = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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

export function getSleepGuardEnabled(): boolean {
  return enabled;
}

export async function setSleepGuardEnabled(next: boolean): Promise<void> {
  if (next === enabled) return;

  if (next) {
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
