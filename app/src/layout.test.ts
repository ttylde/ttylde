import { describe, expect, test } from "vitest";

import {
  boxOf,
  fromSavedLayout,
  type Layout,
  MAX_PANES,
  mapPanes,
  neighbour,
  panesOf,
  rectsOf,
  single,
  split,
  toSavedLayout,
  without,
} from "./layout";

// 1 on the left; 2 over 3 on the right, which takes 40% of the width.
function sample(): Layout<number> {
  const right = split(split(single(1), 1, "row", 2), 2, "column", 3);
  return right.type === "split" ? { ...right, ratio: 0.6 } : right;
}

describe("split", () => {
  // The new pane comes after the one split, each with half of its room.
  test("puts the new pane after the one split", () => {
    const layout = split(single("a"), "a", "row", "b");
    expect(layout).toEqual({
      type: "split",
      direction: "row",
      ratio: 0.5,
      a: single("a"),
      b: single("b"),
    });
  });

  // Only the pane of the item splits; the others stay as they are.
  test("splits only the pane of the item", () => {
    expect(panesOf(sample())).toEqual([1, 2, 3]);
    expect(panesOf(split(sample(), 2, "row", 4))).toEqual([1, 2, 4, 3]);
  });
});

describe("without", () => {
  // The other half of the split takes the room of the pane that goes.
  test("gives the room to the other half", () => {
    const layout = without(sample(), 2);
    expect(layout && panesOf(layout)).toEqual([1, 3]);
    expect(layout && rectsOf(layout)[1].rect).toEqual({ x: 0.6, y: 0, w: 0.4, h: 1 });
  });

  // The only pane gone leaves no layout.
  test("leaves nothing without the only pane", () => {
    expect(without(single(1), 1)).toBeNull();
  });

  // An item not in the tree changes nothing, not even the object.
  test("keeps the tree without the item", () => {
    const layout = sample();
    expect(without(layout, 9)).toBe(layout);
  });
});

describe("rectsOf", () => {
  // The ratio is the room of the first half.
  test("divides the area by the ratios", () => {
    expect(rectsOf(sample())).toEqual([
      { item: 1, rect: { x: 0, y: 0, w: 0.6, h: 1 } },
      { item: 2, rect: { x: 0.6, y: 0, w: 0.4, h: 0.5 } },
      { item: 3, rect: { x: 0.6, y: 0.5, w: 0.4, h: 0.5 } },
    ]);
  });
});

describe("boxOf", () => {
  // Half of the gap on each side two panes share, none at the edges.
  test("leaves the gap between panes only", () => {
    const [one, two, three] = rectsOf(sample()).map(({ rect }) => boxOf(rect, 1000, 600, 8));
    expect(one).toEqual({ left: 0, top: 0, width: 596, height: 600 });
    expect(two).toEqual({ left: 604, top: 0, width: 396, height: 296 });
    expect(three).toEqual({ left: 604, top: 304, width: 396, height: 296 });
  });

  // One pane takes the whole area.
  test("gives the whole area to a single pane", () => {
    expect(boxOf({ x: 0, y: 0, w: 1, h: 1 }, 800, 500, 8)).toEqual({
      left: 0,
      top: 0,
      width: 800,
      height: 500,
    });
  });
});

describe("neighbour", () => {
  // Across a split, the pane that touches the edge.
  test("finds the pane on each side", () => {
    expect(neighbour(sample(), 2, "left")).toBe(1);
    expect(neighbour(sample(), 2, "down")).toBe(3);
    expect(neighbour(sample(), 3, "up")).toBe(2);
  });

  // From a tall pane, two touch its right edge as much: the first wins.
  test("takes the first of two equal ones", () => {
    expect(neighbour(sample(), 1, "right")).toBe(2);
  });

  // At the edge of the area there is none.
  test("finds none past the edge", () => {
    expect(neighbour(sample(), 1, "left")).toBeNull();
    expect(neighbour(sample(), 2, "up")).toBeNull();
  });

  // A pane that only touches the corner is not on that side.
  test("does not take a pane at the corner", () => {
    // 1 | 2 over 3 | 4 under 1: the right of 4 is 3, not 2.
    const layout = split(sample(), 1, "column", 4);
    expect(neighbour(layout, 4, "right")).toBe(3);
  });
});

describe("saved layouts", () => {
  // What is saved reads back as the same tree.
  test("reads back what is saved", () => {
    const saved = toSavedLayout(
      mapPanes(sample(), (n) => `tab${n}`),
      (item) => Number(item.slice(3)) - 1,
    );
    expect(saved).toEqual({
      split: "row",
      ratio: 0.6,
      a: 0,
      b: { split: "column", ratio: 0.5, a: 1, b: 2 },
    });
    const used = new Set<number>();
    const layout = fromSavedLayout(saved, 3, used);
    expect(layout && mapPanes(layout, (n) => n + 1)).toEqual(sample());
    expect([...used].sort()).toEqual([0, 1, 2]);
  });

  // A tab can be in one layout only, and must be there.
  test("refuses positions out of range or already used", () => {
    const pair = { split: "row" as const, ratio: 0.5, a: 0, b: 1 };
    expect(fromSavedLayout(pair, 1, new Set())).toBeNull();
    expect(fromSavedLayout(pair, 2, new Set([1]))).toBeNull();
    expect(fromSavedLayout({ ...pair, b: 0 }, 2, new Set())).toBeNull();
  });

  // What a group cannot be is not read: one pane, or a broken ratio.
  test("refuses what a group cannot be", () => {
    expect(fromSavedLayout(0, 1, new Set())).toBeNull();
    expect(fromSavedLayout({ split: "row", ratio: 1, a: 0, b: 1 }, 2, new Set())).toBeNull();
    let many: Layout<number> = single(0);
    for (let i = 1; i <= MAX_PANES; i++) many = split(many, i - 1, "row", i);
    const used = new Set<number>();
    expect(
      fromSavedLayout(
        toSavedLayout(many, (n) => n),
        MAX_PANES + 1,
        used,
      ),
    ).toBeNull();
    // A layout refused takes no position.
    expect(used.size).toBe(0);
  });
});
