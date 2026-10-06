import type { WindowInfo } from "remote-console-shared";
import type { WindowListStatus } from "../useWindowList";
import { CONN_STATUS_LABEL } from "../connectionLabels";
import SleepGuardToggle from "./SleepGuardToggle";

interface WindowPickerProps {
  windows: WindowInfo[];
  status: WindowListStatus;
  onRetry: () => void;
  selectedId: string;
  onSelect: (id: string) => void;
  csrfToken: string;
}

function WindowPicker({
  windows,
  status,
  onRetry,
  selectedId,
  onSelect,
  csrfToken,
}: WindowPickerProps) {
  return (
    <div className="window-picker">
      <div className="window-picker-select-row">
        <label htmlFor="window-select">ウィンドウ</label>
        <select
          id="window-select"
          className="window-picker-select"
          value={selectedId}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">
            {windows.length ? "選択してください" : "起動中のウィンドウがありません"}
          </option>
          {selectedId && !windows.some((win) => win.id === selectedId) && (
            <option value={selectedId}>
              選択したウィンドウ（一覧にありません）
            </option>
          )}
          {windows.map((win) => (
            <option key={win.id} value={win.id}>
              {win.title || "(無題)"}
            </option>
          ))}
        </select>
      </div>
      <div className="window-picker-header">
        <span className={`status-dot status-${status}`} />
        <span>{CONN_STATUS_LABEL[status]}</span>
        <span className="window-picker-actions">
          <SleepGuardToggle csrfToken={csrfToken} />
          {status === "reconnecting" && (
            <button type="button" className="statusbar-btn" onClick={onRetry}>
              再接続
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

export default WindowPicker;
