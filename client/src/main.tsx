import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// iOS Safariはキーボード表示時にvisualViewportだけ縮みheight:100%基準は縮まないため
// 実際に見えている高さをCSS変数として反映し、キーバーがキーボード裏に隠れないようにする
function syncAppHeight() {
  const viewport = window.visualViewport;
  // ピンチ中のvisualViewport.heightは倍率に応じて縮む。
  // 反映すると映像領域も縮んで画像の位置が動くため、元の高さを維持する。
  if (viewport && viewport.scale > 1.01) return;
  const height = viewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
}
syncAppHeight();
window.visualViewport?.addEventListener("resize", syncAppHeight);
window.visualViewport?.addEventListener("scroll", syncAppHeight);
window.addEventListener("resize", syncAppHeight);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
