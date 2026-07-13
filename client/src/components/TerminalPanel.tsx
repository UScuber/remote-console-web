import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

type Status = 'connecting' | 'connected' | 'disconnected' | 'superseded';

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
  const wsRef = useRef<WebSocket | null>(null);
  const ctrlArmedRef = useRef(false);
  const isComposingRef = useRef(false);
  const fitPendingRef = useRef(false);

  const [status, setStatus] = useState<Status>('connecting');
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [connectSeq, setConnectSeq] = useState(0);

  function sendMessage(msg: Record<string, unknown>) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function sendInput(data: string) {
    sendMessage({ type: 'input', data });
  }

  function pressCtrl() {
    ctrlArmedRef.current = !ctrlArmedRef.current;
    setCtrlArmed(ctrlArmedRef.current);
    termRef.current?.focus();
  }

  function pressKey(data: string) {
    sendInput(data);
    termRef.current?.focus();
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

    setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal`);
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      setStatus('connected');
      fitAddon.fit();
      // fit()はcols/rowsが直前から変化していない場合onResizeを発火しないため、
      // 接続直後のサイズを明示的に送る(送らないとpty側がspawn時のデフォルト80x24のまま固定される)。
      sendMessage({ type: 'resize', cols: term.cols, rows: term.rows });
      term.focus();
    });

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        term.write(ev.data);
      }
    });

    ws.addEventListener('close', (ev) => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      setStatus(ev.code === 4000 ? 'superseded' : 'disconnected');
    });

    // 'close'が後続するため、ここでは状態更新しない(二重更新防止)。
    ws.addEventListener('error', () => {});

    const resizeObserver = new ResizeObserver(() => scheduleFit());
    resizeObserver.observe(container);
    const handleWindowResize = () => scheduleFit();
    window.addEventListener('resize', handleWindowResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      textarea?.removeEventListener('compositionstart', handleCompositionStart);
      textarea?.removeEventListener('compositionend', handleCompositionEnd);
      ws.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
    };
    // 現状はconnectSeqの変化でTerminalごと作り直している(再接続のたびにスクロールバックが消える)。
    // Step 7で自動再接続ロジックを入れる際、Terminal生成とWebSocket接続のeffectを分離する。
  }, [connectSeq]);

  const statusLabel: Record<Status, string> = {
    connecting: '接続中…',
    connected: '接続済み',
    disconnected: '切断されました',
    superseded: '別の接続に置き換えられました',
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-statusbar">
        <span className={`status-dot status-${status}`} />
        <span>{statusLabel[status]}</span>
        {(status === 'disconnected' || status === 'superseded') && (
          <button type="button" className="reconnect-btn" onClick={() => setConnectSeq((n) => n + 1)}>
            再接続
          </button>
        )}
      </div>
      <div className="terminal-container" ref={containerRef} />
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
    </div>
  );
}

export default TerminalPanel;
