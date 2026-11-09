import { describe, expect, test } from "vitest";

import { lineEditOf } from "./line-keys";
import type { KeyStroke } from "./shortcuts";

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

describe("lineEditOf", () => {
  test("Cmd with the arrows and Backspace works on the whole line", () => {
    expect(lineEditOf(stroke({ key: "ArrowLeft", metaKey: true }), true)).toBe("Start");
    expect(lineEditOf(stroke({ key: "ArrowRight", metaKey: true }), true)).toBe("End");
    expect(lineEditOf(stroke({ key: "Backspace", metaKey: true }), true)).toBe("DeleteLine");
  });

  test("Option with the arrows and Backspace works by words", () => {
    expect(lineEditOf(stroke({ key: "ArrowLeft", altKey: true }), true)).toBe("WordBack");
    expect(lineEditOf(stroke({ key: "ArrowRight", altKey: true }), true)).toBe("WordForward");
    expect(lineEditOf(stroke({ key: "Backspace", altKey: true }), true)).toBe("DeleteWord");
  });

  // Option types characters on many layouts.
  test("Option with a letter keeps typing", () => {
    expect(lineEditOf(stroke({ key: "@", code: "KeyG", altKey: true }), true)).toBeNull();
  });

  // Cmd+Option and an arrow moves between panes; Cmd+Up goes to a prompt.
  test("other combinations are left alone", () => {
    expect(lineEditOf(stroke({ key: "ArrowLeft", metaKey: true, altKey: true }), true)).toBeNull();
    expect(
      lineEditOf(stroke({ key: "ArrowLeft", metaKey: true, shiftKey: true }), true),
    ).toBeNull();
    expect(lineEditOf(stroke({ key: "ArrowUp", metaKey: true }), true)).toBeNull();
    expect(lineEditOf(stroke({ key: "ArrowLeft" }), true)).toBeNull();
  });

  test("off macOS the keys stay what they are", () => {
    expect(lineEditOf(stroke({ key: "ArrowLeft", altKey: true }), false)).toBeNull();
    expect(lineEditOf(stroke({ key: "ArrowLeft", metaKey: true }), false)).toBeNull();
  });
});
