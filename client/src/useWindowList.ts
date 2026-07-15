import { useEffect, useRef, useState } from "react";
import type { WindowInfo } from "remote-console-shared";
import { subscribeSharedWs, type SharedWsHandle } from "./sharedWs";
import { reportUnstableClose } from "./authWatchdog";
import { wsUrl } from "./wsUrl";

export type { WindowInfo };

export type WindowListStatus = "connecting" | "connected" | "reconnecting";

export interface WindowListState {
  windows: WindowInfo[];
  status: WindowListStatus;
  retryNow: () => void;
}

// /ws/windowsの購読を1箇所に持ち、WindowPicker(表示専用)とApp(windowStillListed判定用)の
// 双方に同じ一覧を配る。以前はWindowPickerが購読しonWindowsChangeでAppへ吸い上げていたが、
// 一覧の所有者をApp側に一本化し子→親のサイドチャネルを無くすためのhook。
export function useWindowList(): WindowListState {
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [status, setStatus] = useState<WindowListStatus>("connecting");
  const wsHandleRef = useRef<SharedWsHandle | null>(null);

  useEffect(() => {
    // 一覧配信は常時受けたいのでどんな切断でも無条件に再接続する
    const wsHandle = subscribeSharedWs({
      url: wsUrl("/ws/windows"),
      onConnecting: () => setStatus("connecting"),
      onOpen: () => setStatus("connected"),
      onMessage: (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "windows" && Array.isArray(msg.windows)) {
            setWindows(msg.windows);
          }
        } catch {
          // 不正なJSONは無視
        }
      },
      onClose: () => true,
      onRetryScheduled: () => setStatus("reconnecting"),
      onRepeatedFailure: reportUnstableClose,
    });
    wsHandleRef.current = wsHandle;

    return () => {
      wsHandle.stop();
      wsHandleRef.current = null;
    };
  }, []);

  return {
    windows,
    status,
    retryNow: () => wsHandleRef.current?.retryNow(),
  };
}
