import { describe, expect, test } from "vitest";

import { cellAtPoint } from "./geometry";
import { buttonOf, kindOf } from "./mouse";

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
