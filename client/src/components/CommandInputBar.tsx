import { useEffect, useRef, useState } from 'react';

interface CommandInputBarProps {
  onSubmit: (text: string) => void;
}

const MAX_TEXTAREA_HEIGHT_PX = 160;

/**
 * ターミナル最下部に固定表示する行入力欄。履歴をスクロールして読みながらでも、常に見える位置から
 * コマンドを組み立てて送れる。素のシェルコマンド用(全画面TUIは従来どおりターミナルへ直接入力)。
 */
function CommandInputBar({ onSubmit }: CommandInputBarProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [text]);

  function submit() {
    if (text.length === 0) return;
    onSubmit(text);
    setText('');
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Ctrl+Enterで送信。素のEnterは改行(既定動作のまま)。IME変換確定のEnterでは送信しない。
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
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
        autoCorrect="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="command-send-btn"
        // pointerdownで送信し既定動作を止めることで、フォーカス(キーボード)を維持する。
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
