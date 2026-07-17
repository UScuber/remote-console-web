// WebSocketはハンドシェイク失敗のHTTPステータスを見られず401とただの回線断を区別できないため
// 再接続が繰り返し失敗した時点で能動的に/api/sessionを確認しセッション失効かどうかを判定する

import { apiFetch } from "./apiFetch";

const FAILURE_THRESHOLD = 3;

type Listener = (csrfToken: string) => void;

let listeners: Listener[] = [];
let checking = false;

export function onAuthLost(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((f) => f !== fn);
  };
}

export function reportUnstableClose(consecutiveFailures: number): void {
  if (consecutiveFailures < FAILURE_THRESHOLD || checking) return;
  checking = true;
  apiFetch("api/session")
    .then((res) => res.json())
    .then((data: { authenticated?: boolean; csrfToken?: string }) => {
      if (!data.authenticated) {
        listeners.forEach((fn) => fn(data.csrfToken ?? ""));
      }
    })
    .catch(() => {
      // オフライン等で確認自体ができない場合は何もせず回線復旧後の再試行に委ねる
    })
    .finally(() => {
      checking = false;
    });
}
