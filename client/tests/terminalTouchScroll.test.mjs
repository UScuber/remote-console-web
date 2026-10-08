import assert from "node:assert/strict";
import test from "node:test";
import { enableTerminalTouchScroll } from "../src/components/terminalTouchScroll.ts";

test("a short tap moves the caret while a drag keeps scrolling behavior", () => {
  const handlers = new Map();
  const screen = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 240 }),
  };
  const root = { querySelector: () => screen };
  const container = {
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    removeEventListener(type) {
      handlers.delete(type);
    },
  };
  const taps = [];
  const dispose = enableTerminalTouchScroll(
    { element: root, rows: 24 },
    container,
    (x, y) => {
      taps.push([x, y]);
      return true;
    },
  );
  const touch = (x, y) => ({ identifier: 1, clientX: x, clientY: y });

  try {
    handlers.get("touchstart")({ touches: [touch(20, 20)] });
    let prevented = false;
    handlers.get("touchend")({
      touches: [],
      changedTouches: [touch(22, 21)],
      preventDefault() {
        prevented = true;
      },
    });
    assert.deepEqual(taps, [[22, 21]]);
    assert.equal(prevented, true);

    handlers.get("touchstart")({ touches: [touch(20, 20)] });
    handlers.get("touchmove")({
      touches: [touch(20, 29)],
      preventDefault() {},
    });
    handlers.get("touchend")({
      touches: [],
      changedTouches: [touch(20, 29)],
      preventDefault() {
        throw new Error("a drag must not become a tap");
      },
    });
    assert.deepEqual(taps, [[22, 21]]);
  } finally {
    dispose();
  }
});
