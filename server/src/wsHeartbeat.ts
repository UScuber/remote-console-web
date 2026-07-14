import type { WebSocket, WebSocketServer } from 'ws';

// 全WebSocket(/ws/terminal・/ws/windows・/ws/window/:id)共通の死活監視。
// 30秒間隔でpingを送り、pongが2回連続で返らない接続はterminate()で切断する。
// terminate()でも'close'イベントは発火するため、各ハンドラ側のリソース解放
// (ptyのkill・ffmpegのkill・リスナー解除等)はそのまま流用される。
// ブラウザのWebSocket実装はpingに対して自動でpongを返すため、クライアント側の対応は不要。
const PING_INTERVAL_MS = 30_000;
const MAX_MISSED_PONGS = 2;

export function enableHeartbeat(wss: WebSocketServer): void {
  // 接続が閉じてGCされればエントリも自動で消えるようWeakMapで持つ。
  const missedPongs = new WeakMap<WebSocket, number>();

  wss.on('connection', (ws: WebSocket) => {
    missedPongs.set(ws, 0);
    ws.on('pong', () => missedPongs.set(ws, 0));
  });

  // サーバープロセスと同寿命のためclearIntervalは不要(windowDetectorのポーリングと同様)。
  setInterval(() => {
    for (const ws of wss.clients) {
      // OPEN以外への ping() は無駄になる(CONNECTINGなら例外、CLOSING/CLOSEDなら
      // コールバックエラー扱いで無視される)。ここではOPENの接続だけを対象にする。
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
