// TerminalPanel/WindowPicker/WindowStreamで3重に書かれていたプロトコル判定+URL組み立てを1箇所に集約
export function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}
