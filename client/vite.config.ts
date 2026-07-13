import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Tailnet内の別端末(iPhone等)からdevサーバーへ到達できるようにする
    host: true,
    proxy: {
      // 開発時はバックエンド(server/, ポート8443)へ委譲する。本番はExpressが単一オリジンで配信する。
      '/api': 'http://127.0.0.1:8443',
      '/ws': {
        target: 'ws://127.0.0.1:8443',
        ws: true,
      },
    },
  },
})
