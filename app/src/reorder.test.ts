import { describe, expect, test } from "vitest";

import { dropIndex, makeRoom } from "./reorder";

// Four rows 30px tall, their middles 15px into each.
const centers = [15, 45, 75, 105];

describe("dropIndex", () => {
  test("a row not moved stays where it is", () => {
    expect(dropIndex(centers, 1, 45)).toBe(1);
  });

  test("passes a row once its middle is past the middle of that row", () => {
    expect(dropIndex(centers, 0, 74)).toBe(1);
    expect(dropIndex(centers, 0, 76)).toBe(2);
    expect(dropIndex(centers, 3, 46)).toBe(2);
    expect(dropIndex(centers, 3, 44)).toBe(1);
  });

  // The drag stops a row there: its middle is the middle of the last one.
  test("dragged as far as it goes, takes the first or the last place", () => {
    expect(dropIndex(centers, 0, 105)).toBe(3);
    expect(dropIndex(centers, 1, 105)).toBe(3);
    expect(dropIndex(centers, 3, 15)).toBe(0);
    expect(dropIndex(centers, 2, 15)).toBe(0);
  });

  test("goes no further than the first and the last place", () => {
    expect(dropIndex(centers, 2, -100)).toBe(0);
    expect(dropIndex(centers, 0, 500)).toBe(3);
  });
});

describe("makeRoom", () => {
  test("dragged down, the rows it passes go up", () => {
    expect([0, 2, 3].map((index) => makeRoom(index, 1, 2, 30))).toEqual([0, -30, 0]);
  });

  test("dragged up, the rows it passes go down", () => {
    expect([0, 1, 2].map((index) => makeRoom(index, 3, 1, 30))).toEqual([0, 30, 30]);
  });

  test("not moved, nothing moves", () => {
    expect([0, 2, 3].map((index) => makeRoom(index, 1, 1, 30))).toEqual([0, 0, 0]);
  });
});
