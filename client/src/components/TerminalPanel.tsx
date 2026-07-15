import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { enableTerminalTouchScroll } from './terminalTouchScroll';
import CommandInputBar from './CommandInputBar';
import TerminalReviewSheet from './TerminalReviewSheet';
import { subscribeSharedWs, type SharedWsHandle } from '../sharedWs';
import { reportUnstableClose } from '../authWatchdog';

type Status = 'connecting' | 'connected' | 'reconnecting' | 'superseded';

// Ctrl修飾を1文字だけ適用する(例: "a" -> 0x01)。制御文字化できない入力はそのまま返す。
function applyCtrl(data: string): string {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) {
    return String.fromCharCode(code - 64);
  }
  return data;
}

const SPECIAL_KEYS: { label: string; seq: string }[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  // 矢印キーはnormal cursor mode固定。アプリがDECCKM(application cursor keys)を
  // 有効化している場合は追随しない(既知の制限、Step 4時点では許容)。
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: 'Ctrl+C', seq: '\x03' },
];

function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsHandleRef = useRef<SharedWsHandle | null>(null);
  const ctrlArmedRef = useRef(false);
  const isComposingRef = useRef(false);
  const fitPendingRef = useRef(false);

  const [status, setStatus] = useState<Status>('connecting');
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [showInputBar, setShowInputBar] = useState(false);
  const [showReview, setShowReview] = useState(false);

  function sendMessage(msg: Record<string, unknown>) {
    wsHandleRef.current?.send(JSON.stringify(msg));
  }

  function sendInput(data: string) {
    sendMessage({ type: 'input', data });
  }

  // copy-modeで履歴を見ている最中でも、ターミナルをクリックすればtmuxのbind(MouseDown1Pane→cancel)が
  // 最新表示へ戻す。クリックのマウス報告はPCのクリックと同じ経路でWebSocketへ流れる。
  function returnToLatest() {
    const term = termRef.current;
    if (!term || term.modes.mouseTrackingMode === 'none') return;
    const el = term.element;
    const screen = el?.querySelector<HTMLElement>('.xterm-screen');
    if (!el || !screen) return;
    const rect = screen.getBoundingClientRect();
    const opts: MouseEventInit = {
      clientX: rect.left + 2,
      clientY: rect.bottom - 2,
      button: 0,
      bubbles: true,
      cancelable: true,
    };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
  }

  // 改行区切りのテキストを、そのまま実行できる1コマンドに整える(改行=CR、末尾に確定のCR)。
  function toShellCommand(text: string): string {
    const body = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').replace(/\n/g, '\r');
    return `${body}\r`;
  }

  function submitCommand(text: string) {
    returnToLatest();
    sendInput(toShellCommand(text));
  }

  // フォーカスは触らない。ボタンのonPointerDownでpreventDefault済みなのでテキストエリアは
  // フォーカスを保ち、iOSのキーボードは出たまま(term.focus()を呼ぶと再フォーカスでちらつく)。
  function pressCtrl() {
    ctrlArmedRef.current = !ctrlArmedRef.current;
    setCtrlArmed(ctrlArmedRef.current);
  }

  function pressKey(data: string) {
    sendInput(data);
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: 'Menlo, Consolas, "Courier New", monospace',
      fontSize: 16,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    fitAddon.fit();

    termRef.current = term;

    // スマホでの指スクロール(tmuxコピーモード)を有効化する。PCのマウスホイールと同じ経路。
    const disposeTouchScroll = enableTerminalTouchScroll(term, container);

    // fitAddon.fit()はterm.resize()を経由してターミナルを再描画するため、日本語入力の変換中に
    // 呼ぶとIME確定前の文字が消えたり変換候補がずれたりする(iOS Safari)。ソフトウェアキーボード
    // の出現自体がリサイズを引き起こすため、変換中はリサイズを保留しcompositionend後に適用する。
    function scheduleFit() {
      if (isComposingRef.current) {
        fitPendingRef.current = true;
        return;
      }
      fitAddon.fit();
    }

    const textarea = term.textarea;
    const handleCompositionStart = () => {
      isComposingRef.current = true;
    };
    const handleCompositionEnd = () => {
      isComposingRef.current = false;
      if (fitPendingRef.current) {
        fitPendingRef.current = false;
        fitAddon.fit();
      }
    };
    textarea?.addEventListener('compositionstart', handleCompositionStart);
    textarea?.addEventListener('compositionend', handleCompositionEnd);

    // xterm.jsはpty側(tmux)がマウストラッキングを要求した時点で自動的にマウス/タッチ座標の
    // レポートを開始する。JS側で別途「有効化」する設定は不要(tmux.confのset -g mouse onと対)。
    //
    // 公式のws直結アドオン(@xterm/addon-attach)は使わず、onData/onResizeを自前で配線している。
    // このアプリはinput/resizeを1本のWebSocketにJSONフレームで多重化しており、
    // addon-attachは生バイト列の送受信のみでresizeを運べないため。
    term.onData((data) => {
      if (ctrlArmedRef.current) {
        ctrlArmedRef.current = false;
        setCtrlArmed(false);
        sendInput(applyCtrl(data));
        return;
      }
      sendInput(data);
    });

    term.onResize(({ cols, rows }) => {
      sendMessage({ type: 'resize', cols, rows });
    });

    // 自動再接続(Step 7)。Terminalインスタンスは作り直さないため、再接続しても
    // スクロールバックが保持される(画面はtmuxのattachが再描画する)。
    // 接続はURLごとにsharedWs.tsで共有(StrictMode対策、詳細はclient/README.md)
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHandle = subscribeSharedWs({
      url: `${proto}//${location.host}/ws/terminal`,
      onConnecting: () => setStatus('connecting'),
      onOpen: (ws) => {
        setStatus('connected');
        fitAddon.fit();
        // fit()はcols/rowsが直前から変化していない場合onResizeを発火しないため、
        // 接続直後のサイズを明示的に送る(送らないとpty側がspawn時のデフォルト80x24のまま固定される)。
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        term.focus();
      },
      onMessage: (ev) => {
        if (typeof ev.data === 'string') {
          term.write(ev.data);
        }
      },
      onClose: (ev) => {
        if (ev.code === 4000) {
          // 別クライアントに置き換えられた(後勝ちポリシー)。自動で再接続すると
          // クライアント同士が接続を奪い合い続けるため、手動の再接続ボタンのみとする。
          setStatus('superseded');
          return false;
        }
        return true;
      },
      onRetryScheduled: () => setStatus('reconnecting'),
      onRepeatedFailure: reportUnstableClose,
    });
    wsHandleRef.current = wsHandle;

    const resizeObserver = new ResizeObserver(() => scheduleFit());
    resizeObserver.observe(container);
    const handleWindowResize = () => scheduleFit();
    window.addEventListener('resize', handleWindowResize);

    return () => {
      disposeTouchScroll();
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      textarea?.removeEventListener('compositionstart', handleCompositionStart);
      textarea?.removeEventListener('compositionend', handleCompositionEnd);
      wsHandle.stop();
      wsHandleRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, []);

  const statusLabel: Record<Status, string> = {
    connecting: '接続中…',
    connected: '接続済み',
    reconnecting: '切断されました(自動再接続待ち)',
    superseded: '別の接続に置き換えられました',
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-statusbar">
        <span className={`status-dot status-${status}`} />
        <span>{statusLabel[status]}</span>
        <div className="statusbar-actions">
          <button
            type="button"
            className={`statusbar-btn${showReview ? ' statusbar-btn-active' : ''}`}
            onClick={() => setShowReview((v) => !v)}
          >
            テキスト表示
          </button>
          <button
            type="button"
            className={`statusbar-btn${showInputBar ? ' statusbar-btn-active' : ''}`}
            onClick={() => setShowInputBar((v) => !v)}
          >
            入力欄
          </button>
          {(status === 'reconnecting' || status === 'superseded') && (
            <button type="button" className="statusbar-btn" onClick={() => wsHandleRef.current?.retryNow()}>
              再接続
            </button>
          )}
        </div>
      </div>
      <div className="terminal-container" ref={containerRef} />
      {showInputBar && <CommandInputBar onSubmit={submitCommand} />}
      <div className="key-bar">
        <button
          type="button"
          className={`key-btn${ctrlArmed ? ' key-btn-armed' : ''}`}
          onPointerDown={(e) => { e.preventDefault(); pressCtrl(); }}
        >
          Ctrl
        </button>
        {SPECIAL_KEYS.map(({ label, seq }) => (
          <button
            key={label}
            type="button"
            className="key-btn"
            onPointerDown={(e) => { e.preventDefault(); pressKey(seq); }}
          >
            {label}
          </button>
        ))}
      </div>
      {showReview && <TerminalReviewSheet onClose={() => setShowReview(false)} />}
    </div>
  );
}

export default TerminalPanel;
