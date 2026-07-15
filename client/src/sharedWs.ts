// URLごとに接続を1本だけ共有する参照カウント方式のラッパー、詳細はclient/README.md参照
//
// 前提: 同一URLの「現在の購読者」は常に1人だけを想定している。subscribeSharedWsを呼ぶたびに
// currentSubscriberを無条件で上書きするため、2つの別コンポーネントが同じURLを同時に購読した
// 場合、後から呼んだ側が主導権を奪い、先に購読していた側はエラーも警告も無くコールバックを
// 受け取らなくなる。StrictModeの二重実行や同一コンポーネントの再マウントでの再購読は想定内だが、
// 異なる2箇所からの同時購読は想定外(そのようなURLの使い方をする場合はこの前提を見直すこと)。

import {
  createReconnectingWs,
  type ReconnectingWsHandle,
  type ReconnectingWsOptions,
} from "./reconnectingWs";

// 新しい購読者への直近状態の再生用
type LastEvent =
  | { kind: "connecting" }
  | { kind: "open"; ws: WebSocket }
  | { kind: "retryScheduled"; delayMs: number };

// 所有権判定にoptionsオブジェクトの参照同一性ではなく専用トークンを使い、意図を明示する
interface CurrentSubscriber {
  token: symbol;
  options: ReconnectingWsOptions;
}

interface SharedEntry {
  handle: ReconnectingWsHandle;
  /** 現在の購読者。subscribeSharedWsの呼び出しごとに丸ごと差し替わる */
  currentSubscriber: { current: CurrentSubscriber };
  pendingClose: boolean;
  lastEvent: LastEvent;
}

const registry = new Map<string, SharedEntry>();

function replay(opts: ReconnectingWsOptions, ev: LastEvent): void {
  if (ev.kind === "connecting") opts.onConnecting?.();
  else if (ev.kind === "open") opts.onOpen?.(ev.ws);
  else opts.onRetryScheduled?.(ev.delayMs);
}

export interface SharedWsHandle {
  send(data: string): void;
  retryNow(): void;
  suspend(): void;
  /** 購読解除、他に購読者がいなければマイクロタスクで実際に閉じる */
  stop(): void;
}

export function subscribeSharedWs(options: ReconnectingWsOptions): SharedWsHandle {
  const { url } = options;
  const token = Symbol("sharedWsSubscriber");
  let entry = registry.get(url);

  if (!entry) {
    // connect()は同期発火するのでcurrentSubscriberをcreateReconnectingWsの呼び出し前に用意しておく
    const currentSubscriber: { current: CurrentSubscriber } = {
      current: { token, options },
    };
    // lastEvent記録用。こちらは初回のconnect()同期発火時点ではまだnullで構わない
    // (その時点では他に購読者がおらず再生すべき直近状態も無いため)
    const entryRef: { current: SharedEntry | null } = { current: null };
    const handle = createReconnectingWs({
      url,
      binaryType: options.binaryType,
      onConnecting: () => {
        if (entryRef.current) entryRef.current.lastEvent = { kind: "connecting" };
        currentSubscriber.current.options.onConnecting?.();
      },
      onOpen: (ws) => {
        if (entryRef.current) entryRef.current.lastEvent = { kind: "open", ws };
        currentSubscriber.current.options.onOpen?.(ws);
      },
      onMessage: (ev) => currentSubscriber.current.options.onMessage?.(ev),
      onClose: (ev) => currentSubscriber.current.options.onClose(ev),
      onRetryScheduled: (delayMs) => {
        if (entryRef.current)
          entryRef.current.lastEvent = { kind: "retryScheduled", delayMs };
        currentSubscriber.current.options.onRetryScheduled?.(delayMs);
      },
      onRepeatedFailure: (n) =>
        currentSubscriber.current.options.onRepeatedFailure?.(n),
    });
    entry = {
      handle,
      currentSubscriber,
      pendingClose: false,
      lastEvent: { kind: "connecting" },
    };
    entryRef.current = entry;
    registry.set(url, entry);
  } else {
    entry.currentSubscriber.current = { token, options };
    entry.pendingClose = false;
    replay(options, entry.lastEvent);
  }

  const myEntry = entry;
  let unsubscribed = false;

  return {
    send: (data) => myEntry.handle.send(data),
    retryNow: () => myEntry.handle.retryNow(),
    suspend: () => myEntry.handle.suspend(),
    stop: () => {
      if (unsubscribed) return;
      unsubscribed = true;
      // 既に別の購読者に主導権が渡っていればクローズ判断には関与しない
      if (myEntry.currentSubscriber.current.token !== token) return;
      myEntry.pendingClose = true;
      Promise.resolve().then(() => {
        if (!myEntry.pendingClose) return; // 同一ティック内で再購読済み
        myEntry.handle.stop();
        if (registry.get(url) === myEntry) registry.delete(url);
      });
    },
  };
}
