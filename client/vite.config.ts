import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  // 本番はTailscale Serveの--set-path=/remote-console配下で公開される。Tailscaleは転送時に
  // このプレフィックスを剥がすためサーバー(Express)側は"/"基準のままでよいが、ブラウザが発行する
  // URL(アセット参照・fetch・WebSocket)はプレフィックス付きである必要があるため、クライアント側
  // だけbaseを設定する。fetch/WS側はimport.meta.env.BASE_URL経由でこの値を参照する。
  base: "/remote-console/",
  plugins: [react()],
  optimizeDeps: {
    include: ["remote-console-shared"],
  },
  server: {
    // Tailnet内の別端末(iPhone等)からdevサーバーへ到達できるようにする
    host: true,
    proxy: {
      // 開発時はバックエンド(server/, ポート8443)へ委譲する。本番はExpressが単一オリジンで配信する。
      // バックエンドはプレフィックス無しの"/"基準なので、Tailscale Serveと同様にここで剥がして渡す。
      "/remote-console/api": {
        target: "http://127.0.0.1:8443",
        rewrite: (path) => path.replace(/^\/remote-console/, ""),
      },
      "/remote-console/ws": {
        target: "ws://127.0.0.1:8443",
        ws: true,
        rewrite: (path) => path.replace(/^\/remote-console/, ""),
      },
    },
  },
});
