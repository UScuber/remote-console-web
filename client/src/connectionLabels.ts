// TerminalPanel/WindowPicker(useWindowList)/WindowStreamで重複していた接続状態文言を集約。
// 各コンポーネント固有の状態(superseded, streaming, ended等)はこれを展開した上で追加する。
export const CONN_STATUS_LABEL = {
  connecting: "接続中…",
  connected: "接続済み",
  reconnecting: "切断されました(自動再接続待ち)",
} as const;
