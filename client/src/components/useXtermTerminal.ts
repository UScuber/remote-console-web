import { useEffect, useRef, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { enableTerminalTouchScroll } from "./terminalTouchScroll";
import { enableIOSTerminalInput } from "./iosTerminalInput";

export interface XtermTerminal {
  containerRef: RefObject<HTMLDivElement | null>;
  termRef: RefObject<Terminal | null>;
  /** IME変換中かどうかに関わらず即座にfitさせる(WS接続直後など) */
  fit: () => void;
  /** 特殊キーや別の入力欄から送った後、iOS予測変換の文脈を切る */
  resetInputContext: () => void;
}

// xterm.jsインスタンスの生成・fit・タッチスクロール・IME変換中のリサイズ保留を担当する。
// WebSocket配線はuseTerminalWs側の責務であり、ここはterm自体のライフサイクルのみを見る。
export function useXtermTerminal(fontSize: number): XtermTerminal {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resetInputContextRef = useRef<() => void>(() => {});
  // 初期値だけrefで固定し、以後の変更は下の別effectで反映する
  const initialFontSizeRef = useRef(fontSize);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: 'Menlo, Consolas, "Courier New", monospace',
      fontSize: initialFontSizeRef.current,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // xterm.js既定のoffだと予測変換も無効化されるため上書き
    term.textarea?.setAttribute("autocorrect", "on");
    term.textarea?.setAttribute("spellcheck", "true");

    // fit()はterm.resize()経由で再描画するため、iOS Safariの変換中に呼ぶと確定前の文字が
    // 消えることがある、ソフトキーボード出現自体もリサイズを起こすため変換完了まで保留する
    let isComposing = false;
    let fitPending = false;
    function scheduleFit() {
      if (isComposing) {
        fitPending = true;
        return;
      }
      fitAddon.fit();
    }
    function setCompositionState(composing: boolean) {
      isComposing = composing;
      if (!composing && fitPending) {
        fitPending = false;
        fitAddon.fit();
      }
    }

    const iosInput = enableIOSTerminalInput(term, setCompositionState);
    resetInputContextRef.current = iosInput.reset;
    const disposeTouchScroll = enableTerminalTouchScroll(
      term,
      container,
      iosInput.moveCursorToTap,
    );

    const textarea = term.textarea;
    const handleCompositionStart = () => setCompositionState(true);
    const handleCompositionEnd = () => setCompositionState(false);
    textarea?.addEventListener("compositionstart", handleCompositionStart);
    textarea?.addEventListener("compositionend", handleCompositionEnd);

    const resizeObserver = new ResizeObserver(() => scheduleFit());
    resizeObserver.observe(container);
    const handleWindowResize = () => scheduleFit();
    window.addEventListener("resize", handleWindowResize);

    return () => {
      iosInput.dispose();
      resetInputContextRef.current = () => {};
      disposeTouchScroll();
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      textarea?.removeEventListener("compositionstart", handleCompositionStart);
      textarea?.removeEventListener("compositionend", handleCompositionEnd);
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // fontSize変更のたびにTerminalを作り直さず、options書き換え+fit()で反映する
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    fitAddonRef.current?.fit();
  }, [fontSize]);

  return {
    containerRef,
    termRef,
    fit: () => fitAddonRef.current?.fit(),
    resetInputContext: () => resetInputContextRef.current(),
  };
}
