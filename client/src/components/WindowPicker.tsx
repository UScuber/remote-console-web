import { useEffect, useRef, useState } from "react";
import type { WindowInfo } from "remote-console-shared";
import type { WindowListStatus } from "../useWindowList";
import { CONN_STATUS_LABEL } from "../connectionLabels";
import SleepGuardToggle from "./SleepGuardToggle";

const CAP_WARNING_MS = 3000;

interface WindowPickerProps {
  windows: WindowInfo[];
  status: WindowListStatus;
  onRetry: () => void;
  openIds: Set<string>;
  atCap: boolean;
  maxActiveStreams: number;
  onToggle: (id: string, title: string) => void;
  csrfToken: string;
}

// /ws/windowsの購読はuseWindowList(App側)が持ち、ここは表示専用(一覧の所有者は常にApp)
function WindowPicker({
  windows,
  status,
  onRetry,
  openIds,
  atCap,
  maxActiveStreams,
  onToggle,
  csrfToken,
}: WindowPickerProps) {
  const [capWarning, setCapWarning] = useState(false);
  const capWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (capWarningTimerRef.current) clearTimeout(capWarningTimerRef.current);
    };
  }, []);

  function handleTap(win: WindowInfo) {
    if (atCap && !openIds.has(win.id)) {
      setCapWarning(true);
      if (capWarningTimerRef.current) clearTimeout(capWarningTimerRef.current);
      capWarningTimerRef.current = setTimeout(
        () => setCapWarning(false),
        CAP_WARNING_MS,
      );
      return;
    }
    onToggle(win.id, win.title);
  }

  return (
    <div className="window-picker">
      <div className="window-picker-header">
        <span className={`status-dot status-${status}`} />
        <span>{CONN_STATUS_LABEL[status]}</span>
        <span className="window-picker-count">
          配信中 {openIds.size}/{maxActiveStreams}
        </span>
        <SleepGuardToggle csrfToken={csrfToken} />
        {status === "reconnecting" && (
          <button type="button" className="statusbar-btn" onClick={onRetry}>
            再接続
          </button>
        )}
      </div>
      {capWarning && (
        <div className="window-picker-warning">
          上限({maxActiveStreams})に達しています。閉じてから選び直してください。
        </div>
      )}
      {windows.length === 0 ? (
        <div className="window-picker-empty">起動中のウィンドウがありません</div>
      ) : (
        <ul className="window-picker-list">
          {windows.map((win) => {
            const isOpen = openIds.has(win.id);
            const disabled = atCap && !isOpen;
            return (
              <li key={win.id}>
                <button
                  type="button"
                  className={`window-picker-item${isOpen ? " window-picker-item-open" : ""}${disabled ? " window-picker-item-disabled" : ""}`}
                  onClick={() => handleTap(win)}
                >
                  {win.title || "(無題)"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default WindowPicker;
