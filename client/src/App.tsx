import { useEffect, useRef, useState } from "react";
import { TERMINAL_IDS } from "remote-console-shared";
import LoginForm from "./components/LoginForm";
import TerminalPanel from "./components/TerminalPanel";
import WindowPicker from "./components/WindowPicker";
import WindowStream from "./components/WindowStream";
import { onAuthLost } from "./authWatchdog";
import { apiFetch } from "./apiFetch";
import { useWindowList } from "./useWindowList";
import { useTerminalPrefs, MIN_FONT_SIZE, MAX_FONT_SIZE } from "./useTerminalPrefs";
import "./App.css";

type AuthState = "loading" | "anonymous" | "authenticated";
type Tab = "terminal" | "video";

interface Panel {
  id: string;
  title: string;
  seq: number;
  ended: boolean;
}

function App() {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [csrfToken, setCsrfToken] = useState("");
  const [tab, setTab] = useState<Tab>("terminal");
  const {
    activeTerminalId,
    setActiveTerminalId,
    fontSize,
    increaseFontSize,
    decreaseFontSize,
  } = useTerminalPrefs();
  const {
    windows,
    status: windowListStatus,
    retryNow: retryWindowList,
  } = useWindowList();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [pageHidden, setPageHidden] = useState(false);
  const nextSeqRef = useRef(0);

  useEffect(() => {
    async function loadSession() {
      try {
        const res = await apiFetch("api/session");
        const data: {
          authenticated: boolean;
          csrfToken: string;
        } = await res.json();
        setCsrfToken(data.csrfToken);
        setAuthState(data.authenticated ? "authenticated" : "anonymous");
      } catch {
        setAuthState("anonymous");
      }
    }
    loadSession();
  }, []);

  // authWatchdogがセッション失効を検知したらログイン画面へ戻す(詳細はauthWatchdog.ts参照)
  useEffect(() => {
    return onAuthLost((freshCsrfToken) => {
      setCsrfToken(freshCsrfToken);
      setAuthState("anonymous");
    });
  }, []);

  // 映像用ソケットだけpageHidden経由で明示的に切断・再接続する(他は繋いだままにする)
  useEffect(() => {
    function handleVisibility() {
      setPageHidden(document.hidden);
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  function handleSelectWindow(id: string) {
    if (!id) {
      setPanel(null);
      return;
    }
    const windowInfo = windows.find((w) => w.id === id);
    if (!windowInfo) return;
    setPanel({
      id,
      title: windowInfo.title,
      seq: nextSeqRef.current++,
      ended: false,
    });
  }

  function handlePanelEnded(seq: number) {
    setPanel((prev) => (prev?.seq === seq ? { ...prev, ended: true } : prev));
  }

  if (authState === "loading") {
    return (
      <div id="root-loading">
        <p>読み込み中…</p>
      </div>
    );
  }

  if (authState === "anonymous") {
    return (
      <LoginForm
        csrfToken={csrfToken}
        onLoginSuccess={(token) => {
          setCsrfToken(token);
          setAuthState("authenticated");
        }}
        onCsrfRefresh={setCsrfToken}
      />
    );
  }

  return (
    <div id="app-layout">
      <div className="tab-bar">
        <button
          type="button"
          className={`tab-btn${tab === "terminal" ? " tab-btn-active" : ""}`}
          onClick={() => setTab("terminal")}
        >
          ターミナル
        </button>
        <button
          type="button"
          className={`tab-btn${tab === "video" ? " tab-btn-active" : ""}`}
          onClick={() => setTab("video")}
        >
          映像
        </button>
      </div>
      <div
        className="tab-content"
        style={{ display: tab === "terminal" ? "flex" : "none" }}
      >
        <div className="terminal-slot-bar">
          {TERMINAL_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={`terminal-slot-btn${activeTerminalId === id ? " terminal-slot-btn-active" : ""}`}
              onClick={() => setActiveTerminalId(id)}
            >
              {id}
            </button>
          ))}
          <div className="terminal-fontsize-controls">
            <button
              type="button"
              className="terminal-fontsize-btn"
              onClick={decreaseFontSize}
              disabled={fontSize <= MIN_FONT_SIZE}
            >
              −
            </button>
            <span className="terminal-fontsize-label">{fontSize}</span>
            <button
              type="button"
              className="terminal-fontsize-btn"
              onClick={increaseFontSize}
              disabled={fontSize >= MAX_FONT_SIZE}
            >
              +
            </button>
          </div>
        </div>
        <div className="terminal-slot-list">
          {TERMINAL_IDS.map((id) => (
            <div
              key={id}
              className="terminal-slot-item"
              style={{ display: activeTerminalId === id ? "flex" : "none" }}
            >
              <TerminalPanel id={id} fontSize={fontSize} />
            </div>
          ))}
        </div>
      </div>
      <div
        className="tab-content video-content"
        style={{ display: tab === "video" ? "flex" : "none" }}
      >
        <WindowPicker
          windows={windows}
          status={windowListStatus}
          onRetry={retryWindowList}
          selectedId={panel?.id ?? ""}
          onSelect={handleSelectWindow}
          csrfToken={csrfToken}
        />
        <div className="video-stage">
          {!panel ? (
            <div className="video-stage-empty">
              上のメニューからウィンドウを選んでください
            </div>
          ) : (
            <WindowStream
              key={`${panel.id}:${panel.seq}`}
              id={panel.id}
              title={windows.find((w) => w.id === panel.id)?.title ?? panel.title}
              active={!panel.ended && tab === "video"}
              windowStillListed={windows.some((w) => w.id === panel.id)}
              pageHidden={pageHidden}
              onClose={() => setPanel(null)}
              onEnded={() => handlePanelEnded(panel.seq)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
