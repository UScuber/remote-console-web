import assert from "node:assert/strict";
import test from "node:test";
import {
  enableIOSTerminalInput,
  terminalEdit,
} from "../src/components/iosTerminalInput.ts";
import { caretAtTap } from "../src/components/terminalTapCaret.ts";

function mockIOS(t) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "iPhone", platform: "iPhone", maxTouchPoints: 5 },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  });
  t.after(() => {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
    if (windowDescriptor) {
      Object.defineProperty(globalThis, "window", windowDescriptor);
    } else {
      delete globalThis.window;
    }
  });
}

function applyEdit(value, data) {
  const characters = Array.from(value);
  let cursor = characters.length;
  for (let index = 0; index < data.length;) {
    if (data.startsWith("\x1b[D", index)) {
      cursor--;
      index += 3;
    } else if (data.startsWith("\x1b[C", index)) {
      cursor++;
      index += 3;
    } else if (data[index] === "\x7f") {
      if (cursor > 0) characters.splice(--cursor, 1);
      index++;
    } else {
      const character = Array.from(data.slice(index))[0];
      characters.splice(cursor++, 0, character);
      index += character.length;
    }
  }
  assert.equal(cursor, characters.length);
  return characters.join("");
}

test("each bracket and following character is sent once", () => {
  assert.equal(terminalEdit("", ")"), ")");
  assert.equal(terminalEdit(")", ")a"), "a");
  assert.equal(terminalEdit(")a", ")ab"), "b");
});

test("native caret between paired brackets moves the terminal caret too", () => {
  assert.equal(terminalEdit("", "()", 0, 1), "()\x1b[D");
  assert.equal(terminalEdit("()", "()", 2, 1), "\x1b[D");
  assert.equal(terminalEdit("()", "(a)", 1, 2), "a");
});

test("candidate replacement deletes only the replaced characters", () => {
  const previous = "こんにちは";
  const next = "今日は";
  assert.equal(applyEdit(previous, terminalEdit(previous, next)), next);
  assert.equal(applyEdit("hello", terminalEdit("hello", "Hello")), "Hello");
});

test("insertion, deletion, and emoji replacement preserve the cursor", () => {
  for (const [previous, next] of [
    ["abc", "ac"],
    ["abc", "abXc"],
    ["abc", "xyz"],
    ["😀!", "😃!"],
  ]) {
    assert.equal(applyEdit(previous, terminalEdit(previous, next)), next);
  }
});

test("iOS keyboard events use one input path for brackets and later text", (t) => {
  mockIOS(t);

  const listeners = new Map();
  const root = {
    querySelector: () => null,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  const textarea = {
    value: "",
    addEventListener() {},
    removeEventListener() {},
  };
  const sent = [];
  const term = { element: root, textarea, input: (data) => sent.push(data) };
  const adapter = enableIOSTerminalInput(term, () => {});
  t.after(adapter.dispose);
  function fire(type, extra = {}) {
    let stopped = false;
    listeners.get(type)({
      target: textarea,
      stopPropagation() {
        stopped = true;
      },
      preventDefault() {},
      ...extra,
    });
    assert.equal(stopped, true);
  }

  fire("keydown", { key: ")", keyCode: 229 });
  textarea.value = ")";
  fire("input", { inputType: "insertText", data: ")" });
  fire("keydown", { key: "a", keyCode: 229 });
  textarea.value = ")a";
  fire("input", { inputType: "insertText", data: "a" });
  assert.deepEqual(sent, [")", "a"]);
  listeners.get("blur")({ target: textarea });
  assert.deepEqual(sent, [")", "a"]);
  assert.equal(textarea.value, "");
  fire("keydown", { key: "Enter", keyCode: 13 });
  fire("keydown", { key: "Backspace", keyCode: 8 });
  assert.deepEqual(sent, [")", "a", "\r", "\x7f"]);
});

test("composition is emitted once after the final textarea update", async (t) => {
  mockIOS(t);
  const listeners = new Map();
  const root = {
    querySelector: () => null,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  const textarea = { value: "", addEventListener() {}, removeEventListener() {} };
  const sent = [];
  const states = [];
  const adapter = enableIOSTerminalInput(
    { element: root, textarea, input: (data) => sent.push(data) },
    (state) => states.push(state),
  );
  t.after(adapter.dispose);
  const fire = (type, extra = {}) =>
    listeners.get(type)({
      target: textarea,
      stopPropagation() {},
      ...extra,
    });
  fire("compositionstart");
  textarea.value = "にほ";
  fire("input", { inputType: "insertCompositionText" });
  assert.deepEqual(sent, []);
  fire("compositionend", { data: "日本" });
  textarea.value = "日本";
  fire("input", { inputType: "insertFromComposition" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(sent, ["日本"]);
  assert.deepEqual(states, [true, false]);
});

test("a delayed iOS selectionchange keeps typing inside the brackets", async (t) => {
  mockIOS(t);
  const listeners = new Map();
  const documentListeners = new Map();
  const root = {
    querySelector: () => null,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  const textarea = {
    value: "",
    selectionStart: 0,
  };
  textarea.ownerDocument = {
    activeElement: textarea,
    addEventListener(type, handler) {
      documentListeners.set(type, handler);
    },
    removeEventListener(type) {
      documentListeners.delete(type);
    },
  };
  const sent = [];
  const adapter = enableIOSTerminalInput(
    { element: root, textarea, input: (data) => sent.push(data) },
    () => {},
  );
  t.after(adapter.dispose);
  const input = () =>
    listeners.get("input")({
      target: textarea,
      inputType: "insertText",
      stopPropagation() {},
    });
  textarea.value = "()";
  textarea.selectionStart = 2;
  input();
  textarea.selectionStart = 1;
  documentListeners.get("selectionchange")();
  await new Promise((resolve) => setTimeout(resolve, 5));
  textarea.value = "(a)";
  textarea.selectionStart = 2;
  input();
  assert.deepEqual(sent, ["()", "\x1b[D", "a"]);
});

test("tapping visible Japanese text moves both terminal and native carets", (t) => {
  mockIOS(t);
  const cells = new Map([
    [12, "("],
    [13, "テ"],
    [15, "ス"],
    [17, "ト"],
    [19, ")"],
  ]);
  const screen = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 240,
      width: 800,
      height: 240,
    }),
  };
  const root = {
    querySelector: (selector) => (selector === ".xterm-screen" ? screen : null),
    addEventListener() {},
    removeEventListener() {},
  };
  const textarea = {
    value: "(テスト)",
    selectionStart: 5,
    setSelectionRange(start) {
      this.selectionStart = start;
    },
  };
  const sent = [];
  const term = {
    element: root,
    textarea,
    cols: 80,
    rows: 24,
    buffer: {
      active: {
        cursorX: 20,
        cursorY: 0,
        baseY: 0,
        viewportY: 0,
        getLine: () => ({
          getCell: (x) => ({
            getChars: () => cells.get(x) ?? "",
            getWidth: () => (x === 13 || x === 15 || x === 17 ? 2 : 1),
          }),
        }),
      },
    },
    focus() {},
    input: (data) => sent.push(data),
  };
  const adapter = enableIOSTerminalInput(term, () => {});
  t.after(adapter.dispose);
  assert.equal(adapter.moveCursorToTap(130, 5), true);
  assert.equal(textarea.selectionStart, 1);
  assert.deepEqual(sent, ["\x1b[D".repeat(4)]);
  assert.equal(adapter.moveCursorToTap(400, 5), false);
});

test("tapping text after a soft wrap moves to the matching character", (t) => {
  mockIOS(t);
  const screen = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 20,
      width: 100,
      height: 20,
    }),
  };
  const root = {
    querySelector: (selector) => (selector === ".xterm-screen" ? screen : null),
    addEventListener() {},
    removeEventListener() {},
  };
  const cells = new Map([
    [8, "a"],
    [9, "b"],
    [10, "c"],
    [11, "d"],
  ]);
  const textarea = {
    value: "abcd",
    selectionStart: 4,
    setSelectionRange(start) {
      this.selectionStart = start;
    },
  };
  const sent = [];
  const term = {
    element: root,
    textarea,
    cols: 10,
    rows: 2,
    buffer: {
      active: {
        cursorX: 2,
        cursorY: 1,
        baseY: 0,
        viewportY: 0,
        getLine: (row) => ({
          isWrapped: row === 1,
          getCell: (x) => ({
            getChars: () => cells.get(row * 10 + x) ?? "",
            getWidth: () => 1,
          }),
        }),
      },
    },
    focus() {},
    input: (data) => sent.push(data),
  };
  const adapter = enableIOSTerminalInput(term, () => {});
  t.after(adapter.dispose);
  const originalGetLine = term.buffer.active.getLine;
  term.buffer.active.getLine = (row) => ({
    ...originalGetLine(row),
    isWrapped: false,
  });
  assert.equal(caretAtTap(term, screen, "abcd", 4, 0, 15), null);
  term.buffer.active.getLine = originalGetLine;
  assert.equal(adapter.moveCursorToTap(0, 15), true);
  assert.equal(textarea.selectionStart, 2);
  assert.deepEqual(sent, ["\x1b[D".repeat(2)]);
});
