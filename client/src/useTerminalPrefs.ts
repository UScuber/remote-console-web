import { useState } from "react";
import { TERMINAL_IDS, isValidTerminalId } from "remote-console-shared";

const ACTIVE_ID_STORAGE_KEY = "terminalActiveId";
const FONT_SIZE_STORAGE_KEY = "terminalFontSize";

export const DEFAULT_FONT_SIZE = 16;
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 28;
const FONT_SIZE_STEP = 1;

function loadActiveTerminalId(): string {
  const stored = localStorage.getItem(ACTIVE_ID_STORAGE_KEY);
  return stored && isValidTerminalId(stored) ? stored : TERMINAL_IDS[0];
}

function loadFontSize(): number {
  const stored = Number(localStorage.getItem(FONT_SIZE_STORAGE_KEY));
  return Number.isFinite(stored) && stored >= MIN_FONT_SIZE && stored <= MAX_FONT_SIZE
    ? stored
    : DEFAULT_FONT_SIZE;
}

export interface TerminalPrefs {
  activeTerminalId: string;
  setActiveTerminalId: (id: string) => void;
  fontSize: number;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
}

export function useTerminalPrefs(): TerminalPrefs {
  const [activeTerminalId, setActiveTerminalIdState] = useState(loadActiveTerminalId);
  const [fontSize, setFontSizeState] = useState(loadFontSize);

  function setActiveTerminalId(id: string) {
    setActiveTerminalIdState(id);
    localStorage.setItem(ACTIVE_ID_STORAGE_KEY, id);
  }

  function changeFontSize(delta: number) {
    setFontSizeState((prev) => {
      const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, prev + delta));
      localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(next));
      return next;
    });
  }

  return {
    activeTerminalId,
    setActiveTerminalId,
    fontSize,
    increaseFontSize: () => changeFontSize(FONT_SIZE_STEP),
    decreaseFontSize: () => changeFontSize(-FONT_SIZE_STEP),
  };
}
