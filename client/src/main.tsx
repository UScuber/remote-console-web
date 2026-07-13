import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// iOS Safariはソフトウェアキーボード表示時にレイアウトビューポート(height: 100%の基準)を
// 縮めず、visualViewportだけが縮む。これを追従させないとターミナル下部・キーバーが
// キーボードの裏に隠れて見えなくなるため、実際に見えている高さをCSS変数として反映する。
function syncAppHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${height}px`);
}
syncAppHeight();
window.visualViewport?.addEventListener('resize', syncAppHeight);
window.visualViewport?.addEventListener('scroll', syncAppHeight);
window.addEventListener('resize', syncAppHeight);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
