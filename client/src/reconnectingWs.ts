// 自動再接続ヘルパー、バックオフ・ゾンビ接続対策・iOS固着対策の詳細はclient/README.md参照

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// 接続直後に即切断が続くケースでバックオフが伸びたまま高頻度リトライしないようここでリセットする
const STABLE_CONNECTION_MS = 5000;
const FORCE_RECONNECT_HIDDEN_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

export interface ReconnectingWsOptions {
  url: string;
  binaryType?: BinaryType;
  /** 初回・再接続とも接続試行の開始時に呼ばれる(UI表示用) */
  onConnecting?: () => void;
  onOpen?: (ws: WebSocket) => void;
  onMessage?: (ev: MessageEvent) => void;
  /** trueで自動再接続をスケジュール、falseは待機のみ(superseded等、retryNow()は引き続き可能) */
  onClose: (ev: CloseEvent) => boolean;
  /** 再接続のバックオフ待ちに入った際に呼ばれる(UI表示用) */
  onRetryScheduled?: (delayMs: number) => void;
  /** 安定接続に至らないまま再接続をスケジュールした連続回数、authWatchdogのトリガー用 */
  onRepeatedFailure?: (consecutiveFailures: number) => void;
}

export interface ReconnectingWsHandle {
  /** OPENな接続がある場合のみ送信する(未接続時は黙って捨てる) */
  send(data: string): void;
  /** バックオフ待ちを無視して即時再接続する、接続中(試行中含む)なら何もしない */
  retryNow(): void;
  /** 切断して再接続タイマーも止める、ページ非表示時用でretryNow()により再開できる */
  suspend(): void;
  /** 完全に停止する(アンマウント時)、以後いっさい再接続しない */
  stop(): void;
}

export function createReconnectingWs(
  opts: ReconnectingWsOptions,
): ReconnectingWsHandle {
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  let stopped = false;
  let suspended = false;
  let openedAt = 0;
  let consecutiveFailures = 0;
  let hiddenAt = 0;

  function clearRetryTimer() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function connect() {
    clearRetryTimer();
    opts.onConnecting?.();
    const sock = new WebSocket(opts.url);
    if (opts.binaryType) sock.binaryType = opts.binaryType;
    ws = sock;
    openedAt = 0;

    // 固まったハンドシェイクを打ち切り通常のclose経路に乗せる
    const connectTimeout = setTimeout(() => {
      if (ws === sock && sock.readyState === WebSocket.CONNECTING) {
        sock.close();
      }
    }, CONNECT_TIMEOUT_MS);

    sock.addEventListener("open", () => {
      clearTimeout(connectTimeout);
      if (ws !== sock) return;
      openedAt = Date.now();
      opts.onOpen?.(sock);
    });

    sock.addEventListener("message", (ev) => {
      if (ws !== sock) return;
      opts.onMessage?.(ev);
    });

    // 'close'が必ず後続するため何もしない、リスナー自体はエラーログ抑制のため必要
    sock.addEventListener("error", () => {});

    sock.addEventListener("close", (ev) => {
      clearTimeout(connectTimeout);
      // suspend()/stop()/差し替えで自分から捨てた接続のcloseは無視する
      if (ws !== sock) return;
      ws = null;
      if (openedAt > 0 && Date.now() - openedAt >= STABLE_CONNECTION_MS) {
        backoffMs = INITIAL_BACKOFF_MS;
        consecutiveFailures = 0;
      }
      if (stopped || suspended) return;
      if (!opts.onClose(ev)) return;
      consecutiveFailures += 1;
      opts.onRepeatedFailure?.(consecutiveFailures);
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      opts.onRetryScheduled?.(delay);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    });
  }

  function handleVisibility() {
    if (document.visibilityState !== "visible") {
      hiddenAt = Date.now();
      return;
    }
    const wasHiddenLong =
      hiddenAt > 0 && Date.now() - hiddenAt >= FORCE_RECONNECT_HIDDEN_MS;
    hiddenAt = 0;
    if (stopped || suspended) return;
    // バックオフ待ち中にページが復帰したら待ちを無視して即時再接続する
    if (retryTimer !== null) {
      backoffMs = INITIAL_BACKOFF_MS;
      connect();
      return;
    }
    // 長時間hidden後はiOSサスペンド明けのゾンビ接続を疑い強制的に張り直して生存確認する
    if (wasHiddenLong && ws && ws.readyState === WebSocket.OPEN) {
      const sock = ws;
      ws = null;
      backoffMs = INITIAL_BACKOFF_MS;
      sock.close();
      connect();
    }
  }
  document.addEventListener("visibilitychange", handleVisibility);

  connect();

  return {
    send(data: string) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    },
    retryNow() {
      if (stopped) return;
      suspended = false;
      if (ws) return; // 接続中・接続試行中はそのまま
      backoffMs = INITIAL_BACKOFF_MS;
      connect();
    },
    suspend() {
      if (stopped) return;
      suspended = true;
      clearRetryTimer();
      const sock = ws;
      ws = null; // 先にnull化しこのcloseを自分から捨てた接続として無視させる
      sock?.close();
    },
    stop() {
      stopped = true;
      clearRetryTimer();
      document.removeEventListener("visibilitychange", handleVisibility);
      const sock = ws;
      ws = null;
      sock?.close();
    },
  };
}
