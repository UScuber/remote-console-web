import { useEffect, useRef, useState } from 'react';
import { createReconnectingWs, type ReconnectingWsHandle } from '../reconnectingWs';
import { reportUnstableClose } from '../authWatchdog';

type Status = 'connecting' | 'streaming' | 'reconnecting' | 'ended';

// サーバー(server/src/stream/ffmpegStream.ts のCLOSE_CODES)から送られてくるreasonの日本語表示。
// キーはサーバー側のキーと文字列一致させる必要があるため、サーバー側にreasonを追加したらここも直すこと。
// not_listedだけはサーバー由来ではなくクライアントローカルな理由(ページ復帰時に一覧から消えていた)。
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
 * Canvasへ逐次描画する。サーバーから「配信終了」(endedメッセージ)を受けた場合は再接続せず
 * 終了状態にする(一覧から選び直す設計)。endedを伴わない異常切断は自動再接続する(Step 7)。
 * ページ非表示時(pageHidden)はWebSocketを切断し、復帰時にwindowStillListedがtrueであれば
 * 再接続、falseなら諦めて終了状態にする。
 */
function WindowStream({ id, title, active, windowStillListed, pageHidden, onActivate, onClose, onEnded }: WindowStreamProps) {
  const [status, setStatus] = useState<Status>('connecting');
  const [endReason, setEndReason] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsHandleRef = useRef<ReconnectingWsHandle | null>(null);
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
    // 終了確定後はいっさい再接続しない(サーバー側close前にこちらから止めても問題ない)。
    wsHandleRef.current?.stop();
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

  // マウント時(=新規オープン、または再オープンによる再マウント)に接続する。
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHandle = createReconnectingWs({
      url: `${proto}//${location.host}/ws/window/${encodeURIComponent(id)}`,
      binaryType: 'arraybuffer',
      onConnecting: () => {
        statusRef.current = 'connecting';
        setStatus('connecting');
        setEndReason(null);
      },
      // 現在のactive状態をサーバーへ伝える(帯域節約モードの実体はサーバー側の送信間引きにある)。
      onOpen: (ws) => {
        ws.send(JSON.stringify({ type: 'active', value: activeRef.current }));
      },
      onMessage: (ev) => {
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
      },
      // endedメッセージを伴う切断はmarkEnded()がstop()済みでここに来ない。ここに来るのは
      // 異常切断(サーバー再起動・回線断等)なので自動再接続する。再接続先のウィンドウが
      // 既に閉じられていた場合はサーバーがwindow_not_foundのendedを返すため、終了に収束する。
      onClose: () => statusRef.current !== 'ended',
      onRetryScheduled: () => {
        statusRef.current = 'reconnecting';
        setStatus('reconnecting');
      },
      onRepeatedFailure: reportUnstableClose,
    });
    wsHandleRef.current = wsHandle;

    return () => {
      wsHandle.stop();
      wsHandleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ページのバックグラウンド退避/復帰に応じて、映像用WebSocketだけを明示的に切断・再接続する
  // (Step 6要件。ターミナル・一覧のWebSocketは切断しない)。初回マウント時もこのeffectは
  // 走るが、接続試行中はretryNow()が何もしないため二重接続にはならない。
  useEffect(() => {
    const wsHandle = wsHandleRef.current;
    if (!wsHandle || statusRef.current === 'ended') return;
    if (pageHidden) {
      wsHandle.suspend();
      return;
    }
    if (!windowStillListed) {
      markEnded('not_listed');
      return;
    }
    wsHandle.retryNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageHidden]);

  // active切替を接続中のサーバーへ伝える(接続直後の初期値はopenハンドラが送る)。
  useEffect(() => {
    wsHandleRef.current?.send(JSON.stringify({ type: 'active', value: active }));
  }, [active]);

  const statusLabel: Record<Status, string> = {
    connecting: '接続中…',
    streaming: active ? '配信中' : '配信中(省電力)',
    reconnecting: '切断されました(自動再接続待ち)',
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
        {status === 'reconnecting' && <div className="window-stream-overlay">{statusLabel.reconnecting}</div>}
      </div>
    </div>
  );
}

export default WindowStream;
