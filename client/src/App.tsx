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

const DEFAULT_MAX_ACTIVE_STREAMS = 3;

interface Panel {
  id: string;
  title: string;
  seq: number;
  // falseにするだけで終了メッセージを表示したまま残せるので、削除して別集合で管理しない
  ended: boolean;
}

function App() {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [csrfToken, setCsrfToken] = useState("");
  const [maxActiveStreams, setMaxActiveStreams] = useState(
    DEFAULT_MAX_ACTIVE_STREAMS,
  );

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
  const [panels, setPanels] = useState<Panel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pageHidden, setPageHidden] = useState(false);
  const nextSeqRef = useRef(0);

  const liveIds = new Set(panels.filter((p) => !p.ended).map((p) => p.id));

  useEffect(() => {
    async function loadSession() {
      try {
        const res = await apiFetch("api/session");
        const data: {
          authenticated: boolean;
          csrfToken: string;
          maxActiveStreams?: number;
        } = await res.json();
        setCsrfToken(data.csrfToken);
        if (typeof data.maxActiveStreams === "number")
          setMaxActiveStreams(data.maxActiveStreams);
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

  // activeIdはpanelsから導出する(setPanelsの外でpanelsを読むとstale closureになるため、
  // handleClosePanel/handlePanelEnded側では計算せずここで一元的に補正する)
  useEffect(() => {
    setActiveId((prev) => {
      if (prev !== null && panels.some((p) => p.id === prev && !p.ended)) {
        return prev;
      }
      return panels.find((p) => !p.ended)?.id ?? null;
    });
  }, [panels]);

  function handleClosePanel(id: string) {
    setPanels((prev) => prev.filter((p) => p.id !== id));
  }

  function handleToggleWindow(id: string, title: string) {
    if (liveIds.has(id)) {
      handleClosePanel(id);
      return;
    }
    if (liveIds.size >= maxActiveStreams) return;
    const seq = nextSeqRef.current++;
    setPanels((prev) => [
      ...prev.filter((p) => p.id !== id),
      { id, title, seq, ended: false },
    ]);
    setActiveId((prev) => prev ?? id);
  }

  function handlePanelEnded(id: string) {
    setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, ended: true } : p)));
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
        className="tab-content"
        style={{ display: tab === "video" ? "flex" : "none" }}
      >
        <WindowPicker
          windows={windows}
          status={windowListStatus}
          onRetry={retryWindowList}
          openIds={liveIds}
          atCap={liveIds.size >= maxActiveStreams}
          maxActiveStreams={maxActiveStreams}
          onToggle={handleToggleWindow}
          csrfToken={csrfToken}
        />
        <div className="window-stream-list">
          {panels.length === 0 && (
            <div className="window-stream-list-empty">
              上の一覧からウィンドウを選んでください
            </div>
          )}
          {panels.map((p) => (
            <WindowStream
              key={`${p.id}:${p.seq}`}
              id={p.id}
              title={windows.find((w) => w.id === p.id)?.title ?? p.title}
              // ターミナルタブ表示中は全パネルを非アクティブ扱いにしサーバー側送信も間引かせる
              active={activeId === p.id && tab === "video"}
              windowStillListed={windows.some((w) => w.id === p.id)}
              pageHidden={pageHidden}
              onActivate={() => setActiveId(p.id)}
              onClose={() => handleClosePanel(p.id)}
              onEnded={() => handlePanelEnded(p.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
