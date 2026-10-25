import { describe, expect, test } from "vitest";

import { cellAtCol, cellAtPoint, cellsOf, edgeScroll } from "./geometry";
import { buttonOf, kindOf } from "./mouse";
import { fontStack } from "./renderer";
import { type Segment, SegmentFlags } from "./types";

const metrics = { cellWidth: 10, cellHeight: 20, ascent: 15 };

describe("cellAtPoint", () => {
  // A point inside a cell yields that cell's row and column.
  test("maps a point to its cell", () => {
    const cell = cellAtPoint(32, 45, metrics, 80, 24);
    expect(cell).toEqual({ row: 2, col: 3, side: "Left" });
  });

  // The right half of the cell yields `Right`.
  test("right half of the cell is Right", () => {
    expect(cellAtPoint(37, 0, metrics, 80, 24).side).toBe("Right");
    expect(cellAtPoint(35, 0, metrics, 80, 24).side).toBe("Right");
    expect(cellAtPoint(34, 0, metrics, 80, 24).side).toBe("Left");
  });

  // Outside the canvas we stay on the edge cell.
  test("clamps to the grid", () => {
    expect(cellAtPoint(-50, -50, metrics, 80, 24)).toEqual({ row: 0, col: 0, side: "Left" });
    expect(cellAtPoint(5000, 5000, metrics, 80, 24)).toEqual({ row: 23, col: 79, side: "Right" });
  });
});

describe("edgeScroll", () => {
  test("does not scroll over the grid", () => {
    expect(edgeScroll(0, 300, 20)).toBe(0);
    expect(edgeScroll(150, 300, 20)).toBe(0);
    expect(edgeScroll(300, 300, 20)).toBe(0);
  });

  test("scrolls into the history above the top, out of it below the bottom", () => {
    expect(edgeScroll(-1, 300, 20)).toBe(1);
    expect(edgeScroll(301, 300, 20)).toBe(-1);
  });

  test("goes faster further from the edge, up to a limit", () => {
    expect(edgeScroll(-45, 300, 20)).toBe(3);
    expect(edgeScroll(345, 300, 20)).toBe(-3);
    expect(edgeScroll(-5000, 300, 20)).toBe(10);
  });
});

describe("kindOf", () => {
  // Single, double and triple (or more) clicks pick the selection kind.
  test("click count picks the selection kind", () => {
    expect(kindOf(1)).toBe("Simple");
    expect(kindOf(2)).toBe("Word");
    expect(kindOf(3)).toBe("Line");
    expect(kindOf(5)).toBe("Line");
  });
});

describe("buttonOf", () => {
  // The DOM numbers the buttons left, middle, right; the rest (back,
  // forward) have no meaning for the terminal.
  test("names the three main buttons", () => {
    expect(buttonOf(0)).toBe("Left");
    expect(buttonOf(1)).toBe("Middle");
    expect(buttonOf(2)).toBe("Right");
    expect(buttonOf(3)).toBeNull();
  });
});

describe("fontStack", () => {
  // The name is quoted, so spaces are fine, and falls back to fonts that
  // are always there.
  test("quotes the family and adds fallbacks", () => {
    expect(fontStack("JetBrains Mono")).toBe('"JetBrains Mono", Menlo, Monaco, monospace');
  });

  // A quote in the name must not end the string early.
  test("escapes quotes and backslashes", () => {
    expect(fontStack('a"b\\c')).toBe('"a\\"b\\\\c", Menlo, Monaco, monospace');
  });
});

function segment(text: string, cols: number, flags = 0): Segment {
  return { text, cols, fg: 0, bg: 0, flags };
}

describe("cellsOf", () => {
  test("plain text is one character per cell", () => {
    expect(cellsOf(segment("abc", 3))).toEqual(["a", "b", "c"]);
  });

  // A character outside the BMP is two UTF-16 units and still one cell.
  test("splits by code point, not by UTF-16 unit", () => {
    expect(cellsOf(segment("a😀", 3, SegmentFlags.WIDE))).toEqual(["a", "😀"]);
  });

  // The marks stay with their character instead of taking cells of their own.
  test("a cluster is a single cell", () => {
    const cells = cellsOf(segment("e\u0301\u0308", 1, SegmentFlags.CLUSTER));
    expect(cells).toEqual(["e\u0301\u0308"]);
  });
});

describe("cellAtCol", () => {
  const row = [
    segment("ab", 2),
    segment("e\u0301", 1, SegmentFlags.CLUSTER),
    segment("日本", 4, SegmentFlags.WIDE),
    segment("c", 1),
  ];

  test("finds the cell across segments", () => {
    expect(cellAtCol(row, 1)).toEqual({ text: "b", flags: 0 });
    expect(cellAtCol(row, 7)).toEqual({ text: "c", flags: 0 });
  });

  // The cell after a cluster is found by columns, not by characters.
  test("a cluster counts as one column", () => {
    expect(cellAtCol(row, 2)).toEqual({ text: "e\u0301", flags: SegmentFlags.CLUSTER });
    expect(cellAtCol(row, 3)?.text).toBe("日");
  });

  test("both columns of a wide character give that character", () => {
    expect(cellAtCol(row, 4)?.text).toBe("日");
    expect(cellAtCol(row, 5)?.text).toBe("本");
    expect(cellAtCol(row, 6)?.text).toBe("本");
  });

  test("outside the row there is no cell", () => {
    expect(cellAtCol(row, 8)).toBeNull();
    expect(cellAtCol([], 0)).toBeNull();
  });
});
