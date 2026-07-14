import { useEffect, useRef, useState } from 'react';
import LoginForm from './components/LoginForm';
import TerminalPanel from './components/TerminalPanel';
import WindowPicker, { type WindowInfo } from './components/WindowPicker';
import WindowStream from './components/WindowStream';
import { onAuthLost } from './authWatchdog';
import './App.css';

type AuthState = 'loading' | 'anonymous' | 'authenticated';
type Tab = 'terminal' | 'video';

const DEFAULT_MAX_ACTIVE_STREAMS = 3;

interface Panel {
  id: string;
  title: string;
  seq: number;
  // 配信終了後もパネル自体は残し(理由メッセージを表示するため)、Picker側のハイライト・
  // MAX_ACTIVE_STREAMSのカウントからだけ除外する。liveIdsのような別集合を持たず、ここから導出する。
  ended: boolean;
}

// 指定id以外で、まだ配信が終わっていない先頭のパネルを返す(アクティブパネルの自動昇格に使う)。
function pickNextActive(panels: Panel[], excludeId: string): string | null {
  return panels.find((p) => p.id !== excludeId && !p.ended)?.id ?? null;
}

function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [csrfToken, setCsrfToken] = useState('');
  const [maxActiveStreams, setMaxActiveStreams] = useState(DEFAULT_MAX_ACTIVE_STREAMS);

  const [tab, setTab] = useState<Tab>('terminal');
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pageHidden, setPageHidden] = useState(false);
  const nextSeqRef = useRef(0);

  const liveIds = new Set(panels.filter((p) => !p.ended).map((p) => p.id));

  useEffect(() => {
    async function loadSession() {
      try {
        const res = await fetch('/api/session', { credentials: 'same-origin' });
        const data: { authenticated: boolean; csrfToken: string; maxActiveStreams?: number } = await res.json();
        setCsrfToken(data.csrfToken);
        if (typeof data.maxActiveStreams === 'number') setMaxActiveStreams(data.maxActiveStreams);
        setAuthState(data.authenticated ? 'authenticated' : 'anonymous');
      } catch {
        setAuthState('anonymous');
      }
    }
    loadSession();
  }, []);

  // 各WebSocketが再接続に繰り返し失敗した際(サーバー再起動によるセッション失効等)、
  // authWatchdogが/api/sessionで失効を確認したらログイン画面へ戻す(Step 7レビュー対応)。
  // 新しい匿名セッション用のCSRFトークンも併せて受け取り、ログインフォームに引き継ぐ。
  useEffect(() => {
    return onAuthLost((freshCsrfToken) => {
      setCsrfToken(freshCsrfToken);
      setAuthState('anonymous');
    });
  }, []);

  // 映像用WebSocketのみ、ページ非表示化(バックグラウンド化)で明示的に切断・復帰時に再接続する
  // (Step 6要件)。ターミナル・ウィンドウ一覧のWebSocketは非表示時も切断せず、切断された場合の
  // 復帰時即時再接続はreconnectingWs側のvisibilitychange処理が担う(Step 7)。
  useEffect(() => {
    function handleVisibility() {
      setPageHidden(document.hidden);
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  function handleClosePanel(id: string) {
    setPanels((prev) => prev.filter((p) => p.id !== id));
    setActiveId((prev) => (prev === id ? pickNextActive(panels, id) : prev));
  }

  function handleToggleWindow(id: string, title: string) {
    if (liveIds.has(id)) {
      handleClosePanel(id);
      return;
    }
    if (liveIds.size >= maxActiveStreams) return;
    const seq = nextSeqRef.current++;
    setPanels((prev) => [...prev.filter((p) => p.id !== id), { id, title, seq, ended: false }]);
    setActiveId((prev) => prev ?? id);
  }

  function handlePanelEnded(id: string) {
    setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, ended: true } : p)));
    setActiveId((prev) => (prev === id ? pickNextActive(panels, id) : prev));
  }

  if (authState === 'loading') {
    return (
      <div id="root-loading">
        <p>読み込み中…</p>
      </div>
    );
  }

  if (authState === 'anonymous') {
    return (
      <LoginForm
        csrfToken={csrfToken}
        onLoginSuccess={(token) => {
          setCsrfToken(token);
          setAuthState('authenticated');
        }}
      />
    );
  }

  return (
    <div id="app-layout">
      <div className="tab-bar">
        <button type="button" className={`tab-btn${tab === 'terminal' ? ' tab-btn-active' : ''}`} onClick={() => setTab('terminal')}>
          ターミナル
        </button>
        <button type="button" className={`tab-btn${tab === 'video' ? ' tab-btn-active' : ''}`} onClick={() => setTab('video')}>
          映像
        </button>
      </div>
      <div className="tab-content" style={{ display: tab === 'terminal' ? 'flex' : 'none' }}>
        <TerminalPanel />
      </div>
      <div className="tab-content" style={{ display: tab === 'video' ? 'flex' : 'none' }}>
        <WindowPicker
          openIds={liveIds}
          atCap={liveIds.size >= maxActiveStreams}
          maxActiveStreams={maxActiveStreams}
          onToggle={handleToggleWindow}
          onWindowsChange={setWindows}
        />
        <div className="window-stream-list">
          {panels.length === 0 && <div className="window-stream-list-empty">上の一覧からウィンドウを選んでください</div>}
          {panels.map((p) => (
            <WindowStream
              key={`${p.id}:${p.seq}`}
              id={p.id}
              title={windows.find((w) => w.id === p.id)?.title ?? p.title}
              // tab!=='video'の間は全パネルを非アクティブ扱いにする。WindowStreamがこれをサーバーへ
              // {type:'active',value:false}として伝えるため、ターミナルタブ表示中は実際に送信自体が
              // 間引かれ帯域も節約される(ソケットは繋いだままなので、映像タブに戻った際の再接続待ちは発生しない)。
              active={activeId === p.id && tab === 'video'}
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
