// 全WebSocket(ターミナル・ウィンドウ一覧・映像)共通の自動再接続ヘルパー(Step 7)。
// - 切断検知後、1秒から開始し上限30秒の指数バックオフで再接続を試みる。
// - ページがバックグラウンドから復帰した際(visibilitychangeでvisible)はバックオフ待ちを
//   無視して即時再接続する。
// - 再接続も通常のWebSocketアップグレード要求なので、サーバー側でセッションCookieの
//   認証検証が毎回行われる(server/src/index.tsのupgradeハンドラ)。
// サーバーからのping(死活監視)へのpong応答はブラウザが自動で行うため、ここでの対応は不要。

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// 接続がこの時間以上維持できていたら「安定していた」とみなし、次の切断時のバックオフを
// 初期値に戻す。接続直後に即切断されるケース(サーバー側の問題等)でバックオフが短いまま
// 高頻度リトライし続けるのを防ぐため、open直後ではなくここでリセットする。
const STABLE_CONNECTION_MS = 5000;
// ページがこの時間以上hidden状態だった場合、visible復帰時に「見かけ上OPENの接続」でも
// 生存確認のため強制的に張り直す(iOSの長時間サスペンド中に回線が切れてもFINが届かず、
// 復帰後もreadyStateがOPENのまま残る「ゾンビ接続」対策)。
const FORCE_RECONNECT_HIDDEN_MS = 10_000;

export interface ReconnectingWsOptions {
  url: string;
  binaryType?: BinaryType;
  /** 接続試行の開始時に呼ばれる(初回・再接続とも。UI表示用) */
  onConnecting?: () => void;
  onOpen?: (ws: WebSocket) => void;
  onMessage?: (ev: MessageEvent) => void;
  /**
   * 切断時に呼ばれる。trueを返すと指数バックオフで自動再接続をスケジュールする。
   * falseを返すと待機状態になる(superseded等、自動で再接続すべきでない切断。
   * その後もretryNow()による手動再接続は可能)。
   */
  onClose: (ev: CloseEvent) => boolean;
  /** 再接続のバックオフ待ちに入った際に呼ばれる(UI表示用) */
  onRetryScheduled?: (delayMs: number) => void;
  /**
   * 安定接続(STABLE_CONNECTION_MS以上維持)に一度も至らないまま切断・再試行が連続した回数を、
   * 再接続をスケジュールするたびに通知する(安定接続に至るとリセットされる)。UI表示用ではなく、
   * セッション失効検知(authWatchdog)のトリガー用。
   */
  onRepeatedFailure?: (consecutiveFailures: number) => void;
}

export interface ReconnectingWsHandle {
  /** OPENな接続がある場合のみ送信する(未接続時は黙って捨てる) */
  send(data: string): void;
  /** バックオフ待ちを無視して即時再接続する。接続中(試行中含む)なら何もしない */
  retryNow(): void;
  /** 切断して再接続タイマーも止める(ページ非表示時用)。retryNow()で再開できる */
  suspend(): void;
  /** 完全に停止する(アンマウント時)。以後いっさい再接続しない */
  stop(): void;
}

export function createReconnectingWs(opts: ReconnectingWsOptions): ReconnectingWsHandle {
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

    sock.addEventListener('open', () => {
      if (ws !== sock) return;
      openedAt = Date.now();
      opts.onOpen?.(sock);
    });

    sock.addEventListener('message', (ev) => {
      if (ws !== sock) return;
      opts.onMessage?.(ev);
    });

    // 'close'が必ず後続するためここでは何もしない(リスナー自体はエラーログ抑制のため必要)。
    sock.addEventListener('error', () => {});

    sock.addEventListener('close', (ev) => {
      // suspend()/stop()/新規接続への差し替えで自分から捨てた接続のcloseは無視する。
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
    if (document.visibilityState !== 'visible') {
      hiddenAt = Date.now();
      return;
    }
    const wasHiddenLong = hiddenAt > 0 && Date.now() - hiddenAt >= FORCE_RECONNECT_HIDDEN_MS;
    hiddenAt = 0;
    if (stopped || suspended) return;
    // バックオフ待ちの最中にページが復帰したら、待ちを無視して即時再接続する。
    // (suspend中は対象外。映像パネルは復帰時の判断を呼び出し側が行いretryNow()する)
    if (retryTimer !== null) {
      backoffMs = INITIAL_BACKOFF_MS;
      connect();
      return;
    }
    // 長時間hiddenだった後は、見かけ上OPENの接続でも実際には死んでいる「ゾンビ接続」の
    // おそれがある(iOSサスペンド中に回線が切れてもFINが届かないケース)。強制的に張り直して
    // 生存を確認する。
    if (wasHiddenLong && ws && ws.readyState === WebSocket.OPEN) {
      const sock = ws;
      ws = null;
      backoffMs = INITIAL_BACKOFF_MS;
      sock.close();
      connect();
    }
  }
  document.addEventListener('visibilitychange', handleVisibility);

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
      ws = null; // 先にnull化して、このcloseを「自分から捨てた接続」として無視させる
      sock?.close();
    },
    stop() {
      stopped = true;
      clearRetryTimer();
      document.removeEventListener('visibilitychange', handleVisibility);
      const sock = ws;
      ws = null;
      sock?.close();
    },
  };
}
