import { useEffect, useRef, useState } from "react";
import type {
  WindowStreamActiveMessage,
  WindowStreamEndedMessage,
  WindowStreamEndReason,
} from "remote-console-shared";
import { subscribeSharedWs, type SharedWsHandle } from "../sharedWs";
import { reportUnstableClose } from "../authWatchdog";
import { wsUrl } from "../wsUrl";
import { CONN_STATUS_LABEL } from "../connectionLabels";

type Status = "connecting" | "streaming" | "reconnecting" | "ended";

// キーの型はshared/protocol.tsのWindowStreamEndReasonなので、サーバー側にreasonを
// 追加すればここが型エラーになり追従漏れをコンパイラが検知する(not_listedのみサーバー由来
// ではなくクライアントローカルな理由: 復帰時に/ws/windowsの一覧から消えていた場合)
type ClientEndReason = WindowStreamEndReason | "not_listed";
const END_REASON_LABEL: Record<ClientEndReason, string> = {
  superseded: "別の接続に置き換えられました",
  spawn_failed: "配信の開始に失敗しました",
  stream_limit: "同時配信数の上限に達しています",
  invalid_window_id: "不正なウィンドウIDです",
  window_not_found: "ウィンドウが見つかりません",
  window_closed: "ウィンドウが閉じられました",
  ffmpeg_exit: "配信プロセスが終了しました",
  timeout: "映像を取得できませんでした",
  server_shutdown: "サーバーが再起動しています",
  client_closed: "接続が終了しました",
  not_listed: "ウィンドウが見つからないため再接続できませんでした",
};

function isClientEndReason(reason: string): reason is ClientEndReason {
  return reason in END_REASON_LABEL;
}

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

function WindowStream({
  id,
  title,
  active,
  windowStillListed,
  pageHidden,
  onActivate,
  onClose,
  onEnded,
}: WindowStreamProps) {
  const [status, setStatus] = useState<Status>("connecting");
  const [endReason, setEndReason] = useState<ClientEndReason | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsHandleRef = useRef<SharedWsHandle | null>(null);
  const statusRef = useRef<Status>("connecting");
  const activeRef = useRef(active);
  const onEndedRef = useRef(onEnded);

  activeRef.current = active;
  onEndedRef.current = onEnded;

  // state/refの対を1箇所にまとめ、片方だけ更新し忘れるミスを防ぐ
  function transition(next: Status) {
    statusRef.current = next;
    setStatus(next);
  }

  function markEnded(reason: string) {
    if (statusRef.current === "ended") return;
    transition("ended");
    setEndReason(isClientEndReason(reason) ? reason : null);
    // 終了確定後は再接続しない、サーバー側closeを待たずこちらから止めても問題ない
    wsHandleRef.current?.stop();
    onEndedRef.current();
  }

  // rawなWebSocket(onOpen経由)・SharedWsHandleのどちらもsend(string)を持つため共通化できる
  function sendActive(target: { send(data: string): void }, value: boolean) {
    const msg: WindowStreamActiveMessage = { type: "active", value };
    target.send(JSON.stringify(msg));
  }

  function handleFrame(data: ArrayBuffer) {
    if (statusRef.current === "connecting") {
      transition("streaming");
    }
    // 送信間引き(帯域節約モード)はサーバー側で行うため届いたフレームは常に描画する
    createImageBitmap(new Blob([data], { type: "image/jpeg" }))
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
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      })
      .catch(() => {});
  }

  useEffect(() => {
    const wsHandle = subscribeSharedWs({
      url: wsUrl(`/ws/window/${encodeURIComponent(id)}`),
      binaryType: "arraybuffer",
      onConnecting: () => {
        transition("connecting");
        setEndReason(null);
      },
      // 帯域節約モードの実体はサーバー側の送信間引きなので現在のactive状態を伝える
      onOpen: (ws) => sendActive(ws, activeRef.current),
      onMessage: (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data) as Partial<WindowStreamEndedMessage>;
            if (msg.type === "ended") {
              markEnded(
                typeof msg.reason === "string" ? msg.reason : "client_closed",
              );
            }
          } catch {
            // 不正なJSONは無視
          }
          return;
        }
        handleFrame(ev.data as ArrayBuffer);
      },
      // endedを伴う切断はmarkEnded()が既にstop()済みでここに来ないため、ここは異常切断のみ扱う
      onClose: () => statusRef.current !== "ended",
      onRetryScheduled: () => transition("reconnecting"),
      onRepeatedFailure: reportUnstableClose,
    });
    wsHandleRef.current = wsHandle;

    return () => {
      wsHandle.stop();
      wsHandleRef.current = null;
    };
    // idが変わる場合はApp側がkey={id:seq}でコンポーネントごと作り直すため、
    // このeffectはマウント毎に1回だけ接続すればよく[]で正しい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初回マウント時もこのeffectは走るが、接続試行中のretryNow()は何もしないので二重接続にはならない
  useEffect(() => {
    const wsHandle = wsHandleRef.current;
    if (!wsHandle || statusRef.current === "ended") return;
    if (pageHidden) {
      wsHandle.suspend();
      return;
    }
    if (!windowStillListed) {
      markEnded("not_listed");
      return;
    }
    wsHandle.retryNow();
    // windowStillListedはpageHidden復帰時の判定にのみ使い、それ単独の変化では再接続を
    // 試みたくないため依存に含めない(タブ非表示中に一覧から消えても即座には反応しない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageHidden]);

  // 接続直後の初期値はopenハンドラが送るため、ここは切替時のみ伝える
  useEffect(() => {
    const wsHandle = wsHandleRef.current;
    if (wsHandle) sendActive(wsHandle, active);
  }, [active]);

  const statusLabel: Record<Status, string> = {
    connecting: CONN_STATUS_LABEL.connecting,
    streaming: active ? "配信中" : "配信中(省電力)",
    reconnecting: CONN_STATUS_LABEL.reconnecting,
    ended: endReason ? END_REASON_LABEL[endReason] : "配信が終了しました",
  };

  return (
    <div
      className={`window-stream${active ? " window-stream-active" : ""}`}
      onClick={() => status !== "ended" && onActivate()}
    >
      <div className="window-stream-header">
        <span className="window-stream-title">{title || "(無題)"}</span>
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
        {status === "ended" && (
          <div className="window-stream-overlay">{statusLabel.ended}</div>
        )}
        {status === "connecting" && (
          <div className="window-stream-overlay">接続中…</div>
        )}
        {status === "reconnecting" && (
          <div className="window-stream-overlay">{statusLabel.reconnecting}</div>
        )}
      </div>
    </div>
  );
}

export default WindowStream;
