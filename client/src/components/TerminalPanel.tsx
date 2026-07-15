import { useEffect, useRef, useState } from "react";
import CommandInputBar from "./CommandInputBar";
import TerminalReviewSheet from "./TerminalReviewSheet";
import TerminalKeyBar from "./TerminalKeyBar";
import { useXtermTerminal } from "./useXtermTerminal";
import { useTerminalWs, type TerminalConnStatus } from "./useTerminalWs";
import { CONN_STATUS_LABEL } from "../connectionLabels";

// 0x40(@)〜0x5F(_)の範囲(A-Zはこの中の65-90)は-64するとASCII制御コードになる(例 "a" -> 0x01)
function applyCtrl(data: string): string {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) {
    return String.fromCharCode(code - 64);
  }
  return data;
}

function toShellCommand(text: string): string {
  const body = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").replace(/\n/g, "\r");
  return `${body}\r`;
}

function TerminalPanel() {
  const { containerRef, termRef, fit } = useXtermTerminal();
  const { status, sendInput, retryNow } = useTerminalWs(termRef, fit);

  const ctrlArmedRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [showInputBar, setShowInputBar] = useState(false);
  const [showReview, setShowReview] = useState(false);

  // 合成クリックでtmux.confのMouseDown1Pane→cancelを発火させcopy-modeから最新表示へ戻す
  function returnToLatest() {
    const term = termRef.current;
    if (!term || term.modes.mouseTrackingMode === "none") return;
    const el = term.element;
    const screen = el?.querySelector<HTMLElement>(".xterm-screen");
    if (!el || !screen) return;
    const rect = screen.getBoundingClientRect();
    const opts: MouseEventInit = {
      clientX: rect.left + 2,
      clientY: rect.bottom - 2,
      button: 0,
      bubbles: true,
      cancelable: true,
    };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
  }

  function submitCommand(text: string) {
    returnToLatest();
    sendInput(toShellCommand(text));
  }

  // term.focus()を呼ぶと再フォーカスでiOSキーボードがちらつくため触らない
  function pressCtrl() {
    ctrlArmedRef.current = !ctrlArmedRef.current;
    setCtrlArmed(ctrlArmedRef.current);
  }

  // 公式のaddon-attachは生バイト列のみでresizeを運べないため、input/resizeをJSONで
  // 多重化する自前配線にしている(resize側の配線はuseTerminalWs、ここはinput側のみ)。
  // マウス報告自体はtmux.confのmouse on側と対でxterm.jsが自動開始するためJS側の設定は不要
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const disposable = term.onData((data) => {
      if (ctrlArmedRef.current) {
        ctrlArmedRef.current = false;
        setCtrlArmed(false);
        sendInput(applyCtrl(data));
        return;
      }
      sendInput(data);
    });
    return () => disposable.dispose();
    // termRef.currentはuseXtermTerminal側のマウント時に1度だけ生成されるため[]で正しい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusLabel: Record<TerminalConnStatus, string> = {
    ...CONN_STATUS_LABEL,
    superseded: "別の接続に置き換えられました",
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-statusbar">
        <span className={`status-dot status-${status}`} />
        <span>{statusLabel[status]}</span>
        <div className="statusbar-actions">
          <button
            type="button"
            className={`statusbar-btn${showReview ? " statusbar-btn-active" : ""}`}
            onClick={() => setShowReview((v) => !v)}
          >
            テキスト表示
          </button>
          <button
            type="button"
            className={`statusbar-btn${showInputBar ? " statusbar-btn-active" : ""}`}
            onClick={() => setShowInputBar((v) => !v)}
          >
            入力欄
          </button>
          {(status === "reconnecting" || status === "superseded") && (
            <button type="button" className="statusbar-btn" onClick={retryNow}>
              再接続
            </button>
          )}
        </div>
      </div>
      <div className="terminal-container" ref={containerRef} />
      {showInputBar && <CommandInputBar onSubmit={submitCommand} />}
      <TerminalKeyBar
        ctrlArmed={ctrlArmed}
        onPressCtrl={pressCtrl}
        onPressKey={sendInput}
      />
      {showReview && <TerminalReviewSheet onClose={() => setShowReview(false)} />}
    </div>
  );
}

export default TerminalPanel;
