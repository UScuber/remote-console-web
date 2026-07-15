const SPECIAL_KEYS: { label: string; seq: string }[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  // normal cursor mode固定、アプリがDECCKMを有効化していても追随しない既知の制限
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
  { label: "Ctrl+C", seq: "\x03" },
];

interface TerminalKeyBarProps {
  ctrlArmed: boolean;
  onPressCtrl: () => void;
  onPressKey: (seq: string) => void;
}

// iOS Safariのソフトウェアキーボードに無いEsc/Ctrl/Tab/矢印キーを補うための固定ボタン列
function TerminalKeyBar({
  ctrlArmed,
  onPressCtrl,
  onPressKey,
}: TerminalKeyBarProps) {
  return (
    <div className="key-bar">
      <button
        type="button"
        className={`key-btn${ctrlArmed ? " key-btn-armed" : ""}`}
        onPointerDown={(e) => {
          e.preventDefault();
          onPressCtrl();
        }}
      >
        Ctrl
      </button>
      {SPECIAL_KEYS.map(({ label, seq }) => (
        <button
          key={label}
          type="button"
          className="key-btn"
          onPointerDown={(e) => {
            e.preventDefault();
            onPressKey(seq);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default TerminalKeyBar;
