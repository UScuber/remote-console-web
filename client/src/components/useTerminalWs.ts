import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { TERMINAL_CLOSE_CODES } from "remote-console-shared";
import { subscribeSharedWs, type SharedWsHandle } from "../sharedWs";
import { reportUnstableClose } from "../authWatchdog";
import { wsUrl } from "../wsUrl";

export type TerminalConnStatus =
  "connecting" | "connected" | "reconnecting" | "superseded";

export interface TerminalWs {
  status: TerminalConnStatus;
  sendMessage: (msg: Record<string, unknown>) => void;
  sendInput: (data: string) => void;
  retryNow: () => void;
}

// /ws/terminalの接続・再接続・状態管理、およびterm<->WS間のresize/出力の配線を担う。
// term.onData(入力)だけはCtrl修飾トグルというUI固有の変換を挟むため、こちらではなく
// コンポーネント側(TerminalPanel)が配線する。
export function useTerminalWs(
  termRef: RefObject<Terminal | null>,
  fit: () => void,
): TerminalWs {
  const wsHandleRef = useRef<SharedWsHandle | null>(null);
  const [status, setStatus] = useState<TerminalConnStatus>("connecting");

  function sendMessage(msg: Record<string, unknown>) {
    wsHandleRef.current?.send(JSON.stringify(msg));
  }
  function sendInput(data: string) {
    sendMessage({ type: "input", data });
  }

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      sendMessage({ type: "resize", cols, rows });
    });

    // 再接続してもTerminalインスタンス自体は作り直さないためスクロールバックが保持される
    const wsHandle = subscribeSharedWs({
      url: wsUrl("/ws/terminal"),
      onConnecting: () => setStatus("connecting"),
      onOpen: (ws) => {
        setStatus("connected");
        fit();
        // fit()はcols/rows不変ならonResizeを発火しないため、80x24固定を避け明示的に送る
        ws.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
        );
        term.focus();
      },
      onMessage: (ev) => {
        if (typeof ev.data === "string") {
          term.write(ev.data);
        }
      },
      onClose: (ev) => {
        if (ev.code === TERMINAL_CLOSE_CODES.superseded) {
          // 自動再接続すると後勝ちのクライアント同士が奪い合うため手動の再接続ボタンのみにする
          setStatus("superseded");
          return false;
        }
        return true;
      },
      onRetryScheduled: () => setStatus("reconnecting"),
      onRepeatedFailure: reportUnstableClose,
    });
    wsHandleRef.current = wsHandle;

    return () => {
      resizeDisposable.dispose();
      wsHandle.stop();
      wsHandleRef.current = null;
    };
    // termRef.currentはuseXtermTerminal側のマウント時に1度だけ生成されるため[]で正しい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    status,
    sendMessage,
    sendInput,
    retryNow: () => wsHandleRef.current?.retryNow(),
  };
}
