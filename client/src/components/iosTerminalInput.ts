import type { Terminal } from "@xterm/xterm";
import { caretAtTap } from "./terminalTapCaret.ts";

const DELETE = "\x7f";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

function moveCursor(from: number, to: number): string {
  return to < from ? LEFT.repeat(from - to) : RIGHT.repeat(to - from);
}

/** Convert native text and caret changes into terminal cursor operations. */
export function terminalEdit(
  previous: string,
  next: string,
  previousCursor?: number,
  nextCursor?: number,
): string {
  const oldCharacters = Array.from(previous);
  const newCharacters = Array.from(next);
  const oldCaret = Math.max(
    0,
    Math.min(previousCursor ?? oldCharacters.length, oldCharacters.length),
  );
  const newCaret = Math.max(
    0,
    Math.min(nextCursor ?? newCharacters.length, newCharacters.length),
  );
  if (previous === next) return moveCursor(oldCaret, newCaret);

  let start = 0;
  while (
    start < oldCharacters.length &&
    start < newCharacters.length &&
    oldCharacters[start] === newCharacters[start]
  ) {
    start++;
  }
  let oldEnd = oldCharacters.length;
  let newEnd = newCharacters.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldCharacters[oldEnd - 1] === newCharacters[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  const removed = oldEnd - start;
  const inserted = newCharacters.slice(start, newEnd).join("");
  return (
    moveCursor(oldCaret, oldEnd) +
    DELETE.repeat(removed) +
    inserted +
    moveCursor(newEnd, newCaret)
  );
}

function isIOS(): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function keySequence(event: KeyboardEvent, inputEmpty: boolean): string | undefined {
  if (event.ctrlKey) {
    if (event.key.length === 1) {
      const code = event.key.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
    }
    return;
  }
  if (event.metaKey || event.altKey) return;
  switch (event.key) {
    case "Enter":
      return "\r";
    case "Tab":
      return event.shiftKey ? "\x1b[Z" : "\t";
    case "Escape":
      return "\x1b";
    case "ArrowLeft":
      return LEFT;
    case "ArrowRight":
      return RIGHT;
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    // Nonempty textareas deliver the deletion range through an input event.
    case "Backspace":
      return inputEmpty ? DELETE : undefined;
  }
}

interface IOSTerminalInput {
  dispose: () => void;
  reset: () => void;
  moveCursorToTap: (clientX: number, clientY: number) => boolean;
}

/**
 * iOS sends text through input/composition events, sometimes replacing text that is already in
 * the hidden textarea. Capture those events before xterm's key and IME handlers so there is only
 * one sender. Keep the native textarea intact for the predictive keyboard's editing context.
 */
export function enableIOSTerminalInput(
  term: Terminal,
  onCompositionChange: (composing: boolean) => void,
): IOSTerminalInput {
  const root = term.element;
  const textarea = term.textarea;
  if (!isIOS() || !root || !textarea) {
    return { dispose: () => {}, reset: () => {}, moveCursorToTap: () => false };
  }
  const input = textarea;

  const compositionView = root.querySelector<HTMLElement>(".composition-view");
  const screen = root.querySelector<HTMLElement>(".xterm-screen");
  let previous = input.value;
  let remoteCursor = Array.from(previous).length;
  let composing = false;
  let finalizeTimer: number | undefined;
  let selectionTimer: number | undefined;

  function nativeCursor(): number {
    const position = input.selectionStart;
    return typeof position === "number"
      ? Array.from(input.value.slice(0, position)).length
      : Array.from(input.value).length;
  }

  function reset() {
    if (selectionTimer !== undefined) {
      clearTimeout(selectionTimer);
      selectionTimer = undefined;
    }
    previous = "";
    remoteCursor = 0;
    input.value = "";
  }

  function flush() {
    if (composing) return;
    const next = input.value;
    const nextCursor = nativeCursor();
    const data = terminalEdit(previous, next, remoteCursor, nextCursor);
    previous = next;
    remoteCursor = nextCursor;
    if (data) term.input(data);
  }

  function onSelectionChange() {
    if (input.ownerDocument?.activeElement !== input || composing) return;
    if (selectionTimer !== undefined) clearTimeout(selectionTimer);
    // Let the matching input event update textarea.value before syncing the caret.
    selectionTimer = window.setTimeout(() => {
      selectionTimer = undefined;
      flush();
    }, 0);
  }

  function updateCompositionView(value: string) {
    if (!compositionView || !screen) return;
    compositionView.textContent = value;
    compositionView.classList.toggle("active", !!value);
    const cursor = term.buffer.active;
    const cellWidth = screen.clientWidth / term.cols;
    const cellHeight = screen.clientHeight / term.rows;
    compositionView.style.left = `${cursor.cursorX * cellWidth}px`;
    compositionView.style.top = `${cursor.cursorY * cellHeight}px`;
    compositionView.style.height = `${cellHeight}px`;
    compositionView.style.lineHeight = `${cellHeight}px`;
    compositionView.style.fontFamily = term.options.fontFamily ?? "monospace";
    compositionView.style.fontSize = `${term.options.fontSize}px`;
  }

  function moveCursorToTap(clientX: number, clientY: number): boolean {
    if (composing || !screen) return false;
    const target = caretAtTap(
      term,
      screen,
      previous,
      remoteCursor,
      clientX,
      clientY,
    );
    if (target === null) return false;

    term.focus();
    const offset = Array.from(previous).slice(0, target).join("").length;
    input.setSelectionRange(offset, offset);
    flush();
    return true;
  }

  function intercept(event: Event): boolean {
    if (event.target !== input) return false;
    event.stopPropagation();
    return true;
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!intercept(event)) return;
    if (composing || event.isComposing || event.keyCode === 229) return;

    const data = keySequence(event, !input.value);
    if (!data) return;
    event.preventDefault();
    reset();
    term.input(data);
  }

  function onInput(event: InputEvent) {
    if (!intercept(event) || composing) return;
    if (
      event.inputType === "insertLineBreak" ||
      event.inputType === "insertParagraph"
    ) {
      reset();
      term.input("\r");
      return;
    }
    if (
      event.inputType.startsWith("delete") &&
      input.value === previous &&
      !previous
    ) {
      term.input(DELETE);
      return;
    }
    flush();
  }

  function onCompositionStart(event: CompositionEvent) {
    if (!intercept(event)) return;
    if (finalizeTimer !== undefined) {
      clearTimeout(finalizeTimer);
      finalizeTimer = undefined;
      flush();
    }
    composing = true;
    onCompositionChange(true);
  }

  function onCompositionUpdate(event: CompositionEvent) {
    if (!intercept(event)) return;
    updateCompositionView(event.data);
  }

  function onCompositionEnd(event: CompositionEvent) {
    if (!intercept(event)) return;
    updateCompositionView("");
    composing = false;
    // WebKit can update textarea.value after compositionend. Commit after its final input event.
    finalizeTimer = window.setTimeout(() => {
      finalizeTimer = undefined;
      flush();
      onCompositionChange(false);
    }, 0);
  }

  function onPaste(event: ClipboardEvent) {
    if (!intercept(event)) return;
    const text = event.clipboardData?.getData("text/plain");
    if (text === undefined) return;
    event.preventDefault();
    reset();
    term.paste(text);
  }

  function onBlur(event: FocusEvent) {
    if (event.target !== input) return;
    if (finalizeTimer !== undefined) {
      clearTimeout(finalizeTimer);
      finalizeTimer = undefined;
    }
    if (composing) {
      composing = false;
      updateCompositionView("");
    }
    flush();
    onCompositionChange(false);
    reset();
  }

  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("keypress", intercept, true);
  root.addEventListener("keyup", intercept, true);
  root.addEventListener("input", onInput, true);
  root.addEventListener("compositionstart", onCompositionStart, true);
  root.addEventListener("compositionupdate", onCompositionUpdate, true);
  root.addEventListener("compositionend", onCompositionEnd, true);
  root.addEventListener("paste", onPaste, true);
  // xterm clears textarea.value in its own blur listener, so flush before that listener runs.
  root.addEventListener("blur", onBlur, true);
  input.ownerDocument?.addEventListener("selectionchange", onSelectionChange);

  return {
    reset,
    moveCursorToTap,
    dispose: () => {
      if (finalizeTimer !== undefined) clearTimeout(finalizeTimer);
      if (selectionTimer !== undefined) clearTimeout(selectionTimer);
      root.removeEventListener("keydown", onKeyDown, true);
      root.removeEventListener("keypress", intercept, true);
      root.removeEventListener("keyup", intercept, true);
      root.removeEventListener("input", onInput, true);
      root.removeEventListener("compositionstart", onCompositionStart, true);
      root.removeEventListener("compositionupdate", onCompositionUpdate, true);
      root.removeEventListener("compositionend", onCompositionEnd, true);
      root.removeEventListener("paste", onPaste, true);
      root.removeEventListener("blur", onBlur, true);
      input.ownerDocument?.removeEventListener("selectionchange", onSelectionChange);
      updateCompositionView("");
    },
  };
}
