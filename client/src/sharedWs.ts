// URLごとに接続を1本だけ共有する参照カウント方式のラッパー、詳細はclient/README.md参照

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

interface SharedEntry {
  handle: ReconnectingWsHandle;
  /** 最新の購読者のコールバック集合 */
  box: { current: ReconnectingWsOptions };
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
  let entry = registry.get(url);

  if (!entry) {
    // connect()は同期発火するのでboxをcreateReconnectingWsの呼び出し前に用意しておく
    const box: { current: ReconnectingWsOptions } = { current: options };
    const self: { current: SharedEntry | null } = { current: null };
    const handle = createReconnectingWs({
      url,
      binaryType: options.binaryType,
      onConnecting: () => {
        if (self.current) self.current.lastEvent = { kind: "connecting" };
        box.current.onConnecting?.();
      },
      onOpen: (ws) => {
        if (self.current) self.current.lastEvent = { kind: "open", ws };
        box.current.onOpen?.(ws);
      },
      onMessage: (ev) => box.current.onMessage?.(ev),
      onClose: (ev) => box.current.onClose(ev),
      onRetryScheduled: (delayMs) => {
        if (self.current)
          self.current.lastEvent = { kind: "retryScheduled", delayMs };
        box.current.onRetryScheduled?.(delayMs);
      },
      onRepeatedFailure: (n) => box.current.onRepeatedFailure?.(n),
    });
    entry = { handle, box, pendingClose: false, lastEvent: { kind: "connecting" } };
    self.current = entry;
    registry.set(url, entry);
  } else {
    entry.box.current = options;
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
      if (myEntry.box.current !== options) return;
      myEntry.pendingClose = true;
      Promise.resolve().then(() => {
        if (!myEntry.pendingClose) return; // 同一ティック内で再購読済み
        myEntry.handle.stop();
        if (registry.get(url) === myEntry) registry.delete(url);
      });
    },
  };
}
