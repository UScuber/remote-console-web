// TerminalPanel/WindowPicker/WindowStreamで3重に書かれていたプロトコル判定+URL組み立てを1箇所に集約
export function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // BASE_URL(vite.config.tsのbase、末尾スラッシュ付き)を挟む。プレフィックスは
  // Tailscale Serve(本番)/viteのproxy rewrite(開発)が剥がすため、サーバーには"/ws/..."で届く
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${proto}//${location.host}${base}${path}`;
}
