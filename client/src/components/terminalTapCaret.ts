import type { Terminal } from "@xterm/xterm";

function matchInputCells(
  term: Terminal,
  characters: string[],
  start: number,
): number[] | null {
  const buffer = term.buffer.active;
  const cols = term.cols;
  const lastVisibleCell = term.rows * cols;
  const boundaries = [start];
  let position = start;

  for (const character of characters) {
    if (position >= lastVisibleCell) return null;
    let row = Math.floor(position / cols);
    let column = position % cols;
    let line = buffer.getLine(buffer.baseY + row);
    if (column === 0 && boundaries.length > 1 && !line?.isWrapped) return null;
    let cell = line?.getCell(column);

    // A wide character wraps before the last cell and leaves that cell blank.
    if (
      column === cols - 1 &&
      cell?.getWidth() === 1 &&
      cell.getChars() === "" &&
      buffer.getLine(buffer.baseY + row + 1)?.isWrapped
    ) {
      position++;
      boundaries[boundaries.length - 1] = position;
      row++;
      column = 0;
      line = buffer.getLine(buffer.baseY + row);
      cell = line?.getCell(column);
    }

    if (!cell || cell.getChars() !== character || cell.getWidth() < 1) return null;
    position += cell.getWidth();
    boundaries.push(position);
  }

  return position <= lastVisibleCell ? boundaries : null;
}

/** Find a caret within text currently visible at the terminal cursor. */
export function caretAtTap(
  term: Terminal,
  screen: HTMLElement,
  text: string,
  currentCaret: number,
  clientX: number,
  clientY: number,
): number | null {
  if (!text || !term.cols || !term.rows) return null;
  const buffer = term.buffer.active;
  if (buffer.viewportY !== buffer.baseY) return null;

  const rect = screen.getBoundingClientRect();
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return null;
  }

  const characters = Array.from(text);
  const cursorCell = buffer.cursorY * term.cols + buffer.cursorX;
  let boundaries: number[] | null = null;
  for (let start = 0; start <= cursorCell; start++) {
    const candidate = matchInputCells(term, characters, start);
    if (candidate?.[currentCaret] === cursorCell) {
      boundaries = candidate;
      break;
    }
  }
  if (!boundaries) return null;

  const tapRow = Math.min(
    term.rows - 1,
    Math.floor(((clientY - rect.top) / rect.height) * term.rows),
  );
  const tapCell =
    tapRow * term.cols + ((clientX - rect.left) / rect.width) * term.cols;
  if (
    tapCell < boundaries[0] - 0.5 ||
    tapCell > boundaries[boundaries.length - 1] + 0.5
  ) {
    return null;
  }

  let closestCaret = 0;
  let closestDistance = Math.abs(tapCell - boundaries[0]);
  for (let caret = 1; caret < boundaries.length; caret++) {
    const distance = Math.abs(tapCell - boundaries[caret]);
    if (distance <= closestDistance) {
      closestDistance = distance;
      closestCaret = caret;
    }
  }
  return closestCaret;
}
