import type { WebSocket, WebSocketServer } from "ws";

// 死活監視の設定値、および各エンドポイント共通の切断ポリシーの詳細はserver/README.md参照
const PING_INTERVAL_MS = 30_000;
const MAX_MISSED_PONGS = 2;

export function enableHeartbeat(wss: WebSocketServer): void {
  // 接続ごとのエントリなのでMapではなくWeakMapにしてclose時の消し忘れを防ぐ
  const missedPongs = new WeakMap<WebSocket, number>();

  wss.on("connection", (ws: WebSocket) => {
    missedPongs.set(ws, 0);
    ws.on("pong", () => missedPongs.set(ws, 0));
  });

  setInterval(() => {
    for (const ws of wss.clients) {
      // OPEN以外へのping()はCONNECTING時は例外、CLOSING/CLOSED時は無意味なので対象外にする
      if (ws.readyState !== ws.OPEN) continue;
      const missed = missedPongs.get(ws) ?? 0;
      if (missed >= MAX_MISSED_PONGS) {
        ws.terminate();
        continue;
      }
      missedPongs.set(ws, missed + 1);
      ws.ping();
    }
  }, PING_INTERVAL_MS);
}
