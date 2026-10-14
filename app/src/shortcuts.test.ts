import { describe, expect, test } from "vitest";

import { actionOf, type KeyStroke } from "./shortcuts";

function stroke(parts: Partial<KeyStroke>): KeyStroke {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...parts,
  };
}

describe("actionOf", () => {
  // On macOS the app modifier is Cmd.
  test("Cmd+T opens a tab on macOS", () => {
    const action = actionOf(stroke({ key: "t", code: "KeyT", metaKey: true }), true);
    expect(action).toEqual({ type: "new-tab" });
  });

  // Digits select tabs by position, counting from one.
  test("Cmd+1..9 select a tab on macOS", () => {
    const first = actionOf(stroke({ key: "1", code: "Digit1", metaKey: true }), true);
    const ninth = actionOf(stroke({ key: "9", code: "Digit9", metaKey: true }), true);
    expect(first).toEqual({ type: "select-tab", index: 0 });
    expect(ninth).toEqual({ type: "select-tab", index: 8 });
  });

  // Ctrl+T is transpose-chars in the shell: it must reach the terminal.
  test("Ctrl+T is not a shortcut on macOS", () => {
    expect(actionOf(stroke({ key: "t", code: "KeyT", ctrlKey: true }), true)).toBeNull();
  });

  // Elsewhere the app modifier is Ctrl+Shift, and Shift turns the digit
  // into a symbol: the position of the key decides.
  test("Ctrl+Shift is the modifier off macOS", () => {
    const mods = { ctrlKey: true, shiftKey: true };
    expect(actionOf(stroke({ key: "T", code: "KeyT", ...mods }), false)).toEqual({
      type: "new-tab",
    });
    expect(actionOf(stroke({ key: "@", code: "Digit2", ...mods }), false)).toEqual({
      type: "select-tab",
      index: 1,
    });
    expect(actionOf(stroke({ key: "t", code: "KeyT", ctrlKey: true }), false)).toBeNull();
    expect(actionOf(stroke({ key: "t", code: "KeyT", metaKey: true }), false)).toBeNull();
  });

  // The backslash is found by what it types: on an Italian keyboard it is
  // not the key that `code` calls Backslash.
  test("the backslash toggles the sidebar", () => {
    const toggle = { type: "toggle-sidebar" };
    expect(actionOf(stroke({ key: "\\", code: "Backquote", metaKey: true }), true)).toEqual(toggle);
    const mods = { ctrlKey: true, shiftKey: true };
    expect(actionOf(stroke({ key: "|", code: "Backslash", ...mods }), false)).toEqual(toggle);
    expect(actionOf(stroke({ key: "\\", code: "Backslash" }), true)).toBeNull();
  });

  // Keys without a meaning for the app are left alone.
  test("other keys with the modifier are not shortcuts", () => {
    expect(actionOf(stroke({ key: "c", code: "KeyC", metaKey: true }), true)).toBeNull();
    expect(actionOf(stroke({ key: "0", code: "Digit0", metaKey: true }), true)).toBeNull();
  });

  // Spaces are on Ctrl on every platform.
  test("Ctrl+1..9 select a space", () => {
    for (const mac of [true, false]) {
      const first = actionOf(stroke({ key: "1", code: "Digit1", ctrlKey: true }), mac);
      const ninth = actionOf(stroke({ key: "9", code: "Digit9", ctrlKey: true }), mac);
      expect(first).toEqual({ type: "select-space", index: 0 });
      expect(ninth).toEqual({ type: "select-space", index: 8 });
    }
  });

  test("Ctrl+Tab goes to the next space, with Shift to the one before", () => {
    const next = actionOf(stroke({ key: "Tab", code: "Tab", ctrlKey: true }), true);
    const back = actionOf(stroke({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true }), true);
    expect(next).toEqual({ type: "step-space", step: 1 });
    expect(back).toEqual({ type: "step-space", step: -1 });
  });

  // Where Ctrl+Shift is the modifier of the app, the digits stay with the tabs.
  test("Ctrl+Shift+digit is still a tab off macOS", () => {
    const action = actionOf(
      stroke({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }),
      false,
    );
    expect(action).toEqual({ type: "select-tab", index: 0 });
  });

  // Tab alone, and Ctrl with a letter, belong to the terminal.
  test("plain Tab and Ctrl+letter are not shortcuts", () => {
    expect(actionOf(stroke({ key: "Tab", code: "Tab" }), true)).toBeNull();
    expect(actionOf(stroke({ key: "c", code: "KeyC", ctrlKey: true }), true)).toBeNull();
  });
});
