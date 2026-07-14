import { useEffect, useRef, useState } from 'react';

export interface WindowInfo {
  id: string;
  title: string;
}

type ConnStatus = 'connecting' | 'connected' | 'disconnected';

const CAP_WARNING_MS = 3000;

interface WindowPickerProps {
  openIds: Set<string>;
  atCap: boolean;
  maxActiveStreams: number;
  onToggle: (id: string, title: string) => void;
  onWindowsChange: (windows: WindowInfo[]) => void;
}

/**
 * /ws/windows に接続し、起動中のウィンドウ一覧を表示する。一覧の実体(最新スナップショット)は
 * onWindowsChange で親(App)へも伝え、映像パネル側のvisibilitychange復帰判定に使う。
 */
function WindowPicker({ openIds, atCap, maxActiveStreams, onToggle, onWindowsChange }: WindowPickerProps) {
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [capWarning, setCapWarning] = useState(false);
  const [connectSeq, setConnectSeq] = useState(0);
  const capWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onWindowsChangeRef = useRef(onWindowsChange);
  onWindowsChangeRef.current = onWindowsChange;
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/windows`);
    wsRef.current = ws;

    ws.addEventListener('open', () => setStatus('connected'));

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'windows' && Array.isArray(msg.windows)) {
          setWindows(msg.windows);
          onWindowsChangeRef.current(msg.windows);
        }
      } catch {
        // 不正なJSONは無視
      }
    });

    ws.addEventListener('close', () => {
      // effectのcleanupで閉じた旧接続のcloseイベントが、再接続後に非同期で届くことがある
      // (React StrictModeの開発時二重実行等)。wsRefが既に別の接続に差し替わっていれば無視する。
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      setStatus('disconnected');
    });
    ws.addEventListener('error', () => {});

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [connectSeq]);

  useEffect(() => {
    return () => {
      if (capWarningTimerRef.current) clearTimeout(capWarningTimerRef.current);
    };
  }, []);

  function handleTap(win: WindowInfo) {
    if (atCap && !openIds.has(win.id)) {
      setCapWarning(true);
      if (capWarningTimerRef.current) clearTimeout(capWarningTimerRef.current);
      capWarningTimerRef.current = setTimeout(() => setCapWarning(false), CAP_WARNING_MS);
      return;
    }
    onToggle(win.id, win.title);
  }

  const statusLabel: Record<ConnStatus, string> = {
    connecting: '接続中…',
    connected: '接続済み',
    disconnected: '切断されました',
  };

  return (
    <div className="window-picker">
      <div className="window-picker-header">
        <span className={`status-dot status-${status}`} />
        <span>{statusLabel[status]}</span>
        <span className="window-picker-count">
          配信中 {openIds.size}/{maxActiveStreams}
        </span>
        {status === 'disconnected' && (
          <button type="button" className="statusbar-btn" onClick={() => setConnectSeq((n) => n + 1)}>
            再接続
          </button>
        )}
      </div>
      {capWarning && <div className="window-picker-warning">上限({maxActiveStreams})に達しています。閉じてから選び直してください。</div>}
      {windows.length === 0 ? (
        <div className="window-picker-empty">起動中のウィンドウがありません</div>
      ) : (
        <ul className="window-picker-list">
          {windows.map((win) => {
            const isOpen = openIds.has(win.id);
            const disabled = atCap && !isOpen;
            return (
              <li key={win.id}>
                <button
                  type="button"
                  className={`window-picker-item${isOpen ? ' window-picker-item-open' : ''}${disabled ? ' window-picker-item-disabled' : ''}`}
                  onClick={() => handleTap(win)}
                >
                  {win.title || '(無題)'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default WindowPicker;
