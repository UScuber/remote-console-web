import { useEffect, useRef, useState } from "react";

interface CommandInputBarProps {
  onSubmit: (text: string) => void;
}

const MAX_TEXTAREA_HEIGHT_PX = 160;

// 素のシェルコマンド用の行入力欄、全画面TUIは従来どおりターミナルへ直接入力する
function CommandInputBar({ onSubmit }: CommandInputBarProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [text]);

  function submit() {
    if (text.length === 0) return;
    onSubmit(text);
    setText("");
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // 素のEnterは改行に譲り、IME変換確定のEnterは除外してCtrl+Enterのみ送信する
    if (
      e.key === "Enter" &&
      (e.ctrlKey || e.metaKey) &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="command-input-bar">
      <textarea
        ref={textareaRef}
        className="command-input"
        value={text}
        rows={1}
        placeholder="コマンド入力(Ctrl+Enterで送信 / Enterで改行)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="on"
        spellCheck={true}
      />
      <button
        type="button"
        className="command-send-btn"
        // pointerdownの既定動作を止めてtextareaのフォーカス(ソフトキーボード)を維持する
        onPointerDown={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        送信
      </button>
    </div>
  );
}

export default CommandInputBar;
