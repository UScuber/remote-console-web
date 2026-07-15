import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// iOS Safariはキーボード表示時にvisualViewportだけ縮みheight:100%基準は縮まないため
// 実際に見えている高さをCSS変数として反映し、キーバーがキーボード裏に隠れないようにする
function syncAppHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight;
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
