import type { Terminal } from "@xterm/xterm";

const DRAG_START_THRESHOLD_PX = 8;
const FALLBACK_LINE_HEIGHT_PX = 16;

interface Gesture {
  touchId: number;
  startY: number;
  anchorY: number;
  lineHeightPx: number;
  isScrolling: boolean;
  wheelX: number;
  wheelY: number;
}

// xtermはタッチをスクロールに配線しないため、縦ドラッグを合成WheelEventに載せ替えて
// tmuxのcopy-modeをスクロールさせる(1ノッチ=1行の設定はserver/tmux.conf側)
export function enableTerminalTouchScroll(
  term: Terminal,
  container: HTMLElement,
): () => void {
  const root = term.element;
  const screen = root?.querySelector<HTMLElement>(".xterm-screen") ?? null;
  if (!root || !screen) return () => {};

  let gesture: Gesture | null = null;

  function findTouch(touches: TouchList, id: number): Touch | null {
    for (let i = 0; i < touches.length; i++) {
      if (touches[i].identifier === id) return touches[i];
    }
    return null;
  }

  function visibleLineHeightPx(): number {
    return Math.max(
      FALLBACK_LINE_HEIGHT_PX,
      screen!.getBoundingClientRect().height / (term.rows || 1),
    );
  }

  // DOM_DELTA_LINEの±1ならセル高やDPRに依存せず確実に1行=1ノッチとして扱われる
  function scrollOneLine(deltaY: -1 | 1, clientX: number, clientY: number) {
    const event = new WheelEvent("wheel", {
      deltaY,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      clientX,
      clientY,
      bubbles: true,
      cancelable: true,
    });
    root!.dispatchEvent(event);
  }

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) {
      gesture = null;
      return;
    }
    const touch = e.touches[0];
    gesture = {
      touchId: touch.identifier,
      startY: touch.clientY,
      anchorY: touch.clientY,
      lineHeightPx: FALLBACK_LINE_HEIGHT_PX,
      isScrolling: false,
      wheelX: 0,
      wheelY: 0,
    };
  }

  function onTouchMove(e: TouchEvent) {
    if (!gesture) return;
    const touch = findTouch(e.touches, gesture.touchId);
    if (!touch) return;

    if (!gesture.isScrolling) {
      if (Math.abs(touch.clientY - gesture.startY) < DRAG_START_THRESHOLD_PX) return;
      const rect = screen!.getBoundingClientRect();
      gesture.isScrolling = true;
      gesture.anchorY = touch.clientY;
      gesture.lineHeightPx = visibleLineHeightPx();
      gesture.wheelX = rect.left + rect.width / 2;
      gesture.wheelY = rect.top + rect.height / 2;
    }

    e.preventDefault();

    // 指を下げる=古い履歴を見る=ホイール上(deltaY -1)、1行ぶん進むごとにノッチを送る
    let dy = touch.clientY - gesture.anchorY;
    while (Math.abs(dy) >= gesture.lineHeightPx) {
      const draggingDown = dy > 0;
      scrollOneLine(draggingDown ? -1 : 1, gesture.wheelX, gesture.wheelY);
      gesture.anchorY += draggingDown ? gesture.lineHeightPx : -gesture.lineHeightPx;
      dy += draggingDown ? -gesture.lineHeightPx : gesture.lineHeightPx;
    }
  }

  function onTouchEnd(e: TouchEvent) {
    if (gesture && !findTouch(e.touches, gesture.touchId)) gesture = null;
  }

  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: false });
  container.addEventListener("touchend", onTouchEnd, { passive: true });
  container.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return () => {
    container.removeEventListener("touchstart", onTouchStart);
    container.removeEventListener("touchmove", onTouchMove);
    container.removeEventListener("touchend", onTouchEnd);
    container.removeEventListener("touchcancel", onTouchEnd);
  };
}
