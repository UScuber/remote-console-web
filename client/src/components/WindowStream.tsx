import { useEffect, useRef, useState } from 'react';

type Status = 'connecting' | 'streaming' | 'ended';

// サーバー(server/src/stream/ffmpegStream.ts のCLOSE_CODES)から送られてくるreasonの日本語表示。
// キーはサーバー側のキーと文字列一致させる必要があるため、サーバー側にreasonを追加したらここも直すこと。
// disconnected/not_listedの2つだけはサーバー由来ではなくクライアントローカルな理由(異常切断/
// ページ復帰時に一覧から消えていた)。
const END_REASON_LABEL: Record<string, string> = {
  superseded: '別の接続に置き換えられました',
  spawn_failed: '配信の開始に失敗しました',
  stream_limit: '同時配信数の上限に達しています',
  invalid_window_id: '不正なウィンドウIDです',
  window_not_found: 'ウィンドウが見つかりません',
  window_closed: 'ウィンドウが閉じられました',
  ffmpeg_exit: '配信プロセスが終了しました',
  timeout: '映像を取得できませんでした',
  client_closed: '接続が終了しました',
  // ここから下はクライアントローカルな理由
  disconnected: '接続が切断されました',
  not_listed: 'ウィンドウが見つからないため再接続できませんでした',
};

interface WindowStreamProps {
  id: string;
  title: string;
  active: boolean;
  windowStillListed: boolean;
  pageHidden: boolean;
  onActivate: () => void;
  onClose: () => void;
  onEnded: () => void;
}

/**
 * 選択されたウィンドウ1枠分の映像パネル。/ws/window/:id へ接続し、受信したJPEGバイナリを
 * Canvasへ逐次描画する。自動再接続は行わない(サーバー側/ws/windowsの一覧から選び直す設計、Step7で
 * 汎用の自動再接続を追加する予定)。ページ非表示時(pageHidden)はWebSocketを切断し、復帰時に
 * windowStillListedがtrueであれば再接続、falseなら諦めて終了状態にする。
 */
function WindowStream({ id, title, active, windowStillListed, pageHidden, onActivate, onClose, onEnded }: WindowStreamProps) {
  const [status, setStatus] = useState<Status>('connecting');
  const [endReason, setEndReason] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<Status>('connecting');
  const activeRef = useRef(active);
  const onEndedRef = useRef(onEnded);

  activeRef.current = active;
  onEndedRef.current = onEnded;

  function markEnded(reason: string) {
    if (statusRef.current === 'ended') return;
    statusRef.current = 'ended';
    setStatus('ended');
    setEndReason(reason);
    onEndedRef.current();
  }

  function handleFrame(data: ArrayBuffer) {
    if (statusRef.current === 'connecting') {
      statusRef.current = 'streaming';
      setStatus('streaming');
    }
    // 帯域節約モードの間引きはサーバー側(送信元)で行っているため、届いたフレームは常に描画する。
    createImageBitmap(new Blob([data], { type: 'image/jpeg' }))
      .then((bitmap) => {
        const canvas = canvasRef.current;
        if (!canvas) {
          bitmap.close();
          return;
        }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        bitmap.close();
      })
      .catch(() => {});
  }

  function connect() {
    statusRef.current = 'connecting';
    setStatus('connecting');
    setEndReason(null);

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/window/${encodeURIComponent(id)}`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    // 現在のactive状態をサーバーへ伝える(帯域節約モードの実体はサーバー側の送信間引きにある)。
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'active', value: activeRef.current }));
    });

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'ended') {
            markEnded(typeof msg.reason === 'string' ? msg.reason : 'client_closed');
          }
        } catch {
          // 不正なJSONは無視
        }
        return;
      }
      handleFrame(ev.data as ArrayBuffer);
    });

    ws.addEventListener('close', () => {
      // wsRefが既に別の接続やnullに差し替わっている場合、この接続は自分たちで意図的に
      // 切断したもの(アンマウント/pageHidden)なので何もしない。
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      markEnded('disconnected');
    });

    ws.addEventListener('error', () => {}); // 'close'が後続するためここでは何もしない
  }

  // マウント時(=新規オープン、または再オープンによる再マウント)に接続する。
  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ページのバックグラウンド復帰/退避に応じて、映像用WebSocketだけを切断・再接続する。
  // マウント時の接続は上のeffectが既に行っている(wsRef.currentが立っている)ため、ここでは
  // 何もしない(wsRef.currentの有無で判定することで、React StrictModeの開発時二重実行でも
  // 余分なconnect()を呼ばない)。
  useEffect(() => {
    if (pageHidden) {
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }
    if (wsRef.current) return;
    if (statusRef.current === 'ended') return;
    if (!windowStillListed) {
      markEnded('not_listed');
      return;
    }
    connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageHidden]);

  // active切替を接続中のサーバーへ伝える(接続直後の初期値はconnect()内のopenハンドラが送る)。
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'active', value: active }));
    }
  }, [active]);

  const statusLabel: Record<Status, string> = {
    connecting: '接続中…',
    streaming: active ? '配信中' : '配信中(省電力)',
    ended: endReason ? (END_REASON_LABEL[endReason] ?? '配信が終了しました') : '配信が終了しました',
  };

  return (
    <div
      className={`window-stream${active ? ' window-stream-active' : ''}`}
      onClick={() => status !== 'ended' && onActivate()}
    >
      <div className="window-stream-header">
        <span className="window-stream-title">{title || '(無題)'}</span>
        <span className="window-stream-status">{statusLabel[status]}</span>
        <button
          type="button"
          className="window-stream-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          閉じる
        </button>
      </div>
      <div className="window-stream-body">
        <canvas ref={canvasRef} className="window-stream-canvas" />
        {status === 'ended' && <div className="window-stream-overlay">{statusLabel.ended}</div>}
        {status === 'connecting' && <div className="window-stream-overlay">接続中…</div>}
      </div>
    </div>
  );
}

export default WindowStream;
