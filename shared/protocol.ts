// client/serverで共有するWebSocketプロトコルの型・定数。
// ここを直せば両側に反映されるため、追加・変更のたびに文字列一致をコメントで揃える必要がない。

export interface WindowInfo {
  id: string;
  title: string;
}

// WS /ws/windows: サーバー→クライアント
export interface WindowsListMessage {
  type: "windows";
  windows: WindowInfo[];
}

// WS /ws/terminal: クライアント→サーバー
export interface TerminalInputMessage {
  type: "input";
  data: string;
}
export interface TerminalResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}
export type TerminalClientMessage = TerminalInputMessage | TerminalResizeMessage;

// WS /ws/terminal: サーバーがclose()に渡すcode。理由付き終了はこの経路のみ(それ以外は生の切断)
export const TERMINAL_CLOSE_CODES = {
  superseded: 4000,
  spawn_failed: 4001,
  server_shutdown: 4002,
} as const;
export type TerminalCloseReason = keyof typeof TERMINAL_CLOSE_CODES;

// WS /ws/window/:id: クライアント→サーバー(帯域節約モードの切り替え)
export interface WindowStreamActiveMessage {
  type: "active";
  value: boolean;
}

// WS /ws/window/:id: サーバー→クライアント(終了理由の通知、close codeと対にして送る)
export interface WindowStreamEndedMessage {
  type: "ended";
  reason: WindowStreamEndReason;
}

// reason名とWebSocket close codeを1つの表に統一する
export const WINDOW_STREAM_CLOSE_CODES = {
  superseded: 4000,
  spawn_failed: 4001,
  stream_limit: 4003,
  invalid_window_id: 4004,
  window_not_found: 4005,
  window_closed: 4006,
  ffmpeg_exit: 4007,
  timeout: 4008,
  server_shutdown: 4009,
  client_closed: 1000,
} as const;
export type WindowStreamEndReason = keyof typeof WINDOW_STREAM_CLOSE_CODES;
