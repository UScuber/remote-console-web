// 各WebSocket(ターミナル・ウィンドウ一覧・映像)が安定接続に至らないまま再接続を繰り返した際、
// セッション失効を疑って /api/session を確認するための共有ウォッチドッグ(Step 7レビュー対応)。
//
// サーバー再起動(systemdのRestart=always)でメモリ上のセッションストアは全消失するが、その後の
// 再接続はWebSocketアップグレード要求が401で拒否され続ける。ブラウザのWebSocket APIは
// ハンドシェイク失敗のHTTPステータスを見られないため、クライアント側はこれを通常の回線断と
// 区別できず、reconnectingWs側は永久にリトライし続けてしまう。ここで能動的にセッション状態を
// 確認し、失効していればApp.tsxへ通知してログイン画面に戻す。

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
  fetch('/api/session', { credentials: 'same-origin' })
    .then((res) => res.json())
    .then((data: { authenticated?: boolean; csrfToken?: string }) => {
      if (!data.authenticated) {
        listeners.forEach((fn) => fn(data.csrfToken ?? ''));
      }
    })
    .catch(() => {
      // オフライン等でセッション確認自体ができない場合は何もしない(回線復旧後の再試行に委ねる)。
    })
    .finally(() => {
      checking = false;
    });
}
