import type { WebSocket } from "ws";

// 'error'リスナーが無いWebSocketは、回線断等の非同期エラーでプロセスごとクラッシュする
export function suppressSocketErrors(ws: WebSocket): void {
  ws.on("error", () => {});
}
