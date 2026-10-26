// The layout of a group of panes: a binary tree. Each split puts its two
// halves side by side (a row) or one over the other (a column), the first
// taking `ratio` of the room; each leaf is a pane. Pure functions: the
// tree is never changed in place, a change gives a new one.

/** A row puts its halves side by side; a column, one over the other. */
export type Direction = "row" | "column";

export type Layout<T> =
  | { type: "pane"; item: T }
  | { type: "split"; direction: Direction; ratio: number; a: Layout<T>; b: Layout<T> };

/** How many panes a group can have: past that, a pane is too small to use. */
export const MAX_PANES = 6;

/** A part of the area, as fractions of it: 0 to 1 from the top left. */
export type Rect = { x: number; y: number; w: number; h: number };

/** Where a pane can be, seen from another. */
export type Side = "left" | "right" | "up" | "down";

/** A layout of one pane, `item`. */
export function single<T>(item: T): Layout<T> {
  return { type: "pane", item };
}

/** The panes of `layout`, left to right and top to bottom. */
export function panesOf<T>(layout: Layout<T>): T[] {
  if (layout.type === "pane") return [layout.item];
  return [...panesOf(layout.a), ...panesOf(layout.b)];
}

/**
 * Splits the pane of `item` in two, `added` after it: on its right in a
 * row, under it in a column. Each half takes half of the room it had.
 */
export function split<T>(layout: Layout<T>, item: T, direction: Direction, added: T): Layout<T> {
  if (layout.type === "pane") {
    if (layout.item !== item) return layout;
    return { type: "split", direction, ratio: 0.5, a: layout, b: single(added) };
  }
  return {
    ...layout,
    a: split(layout.a, item, direction, added),
    b: split(layout.b, item, direction, added),
  };
}

/**
 * `layout` without the pane of `item`: the other half of its split takes
 * all of the room. `null` when it was the only pane.
 */
export function without<T>(layout: Layout<T>, item: T): Layout<T> | null {
  if (layout.type === "pane") return layout.item === item ? null : layout;
  const a = without(layout.a, item);
  const b = without(layout.b, item);
  if (!a) return b;
  if (!b) return a;
  return a === layout.a && b === layout.b ? layout : { ...layout, a, b };
}

/** The same tree, with `f` of each item in its leaves. */
export function mapPanes<T, U>(layout: Layout<T>, f: (item: T) => U): Layout<U> {
  if (layout.type === "pane") return single(f(layout.item));
  return { ...layout, a: mapPanes(layout.a, f), b: mapPanes(layout.b, f) };
}

/** Where each pane is, in the order of `panesOf`. */
export function rectsOf<T>(
  layout: Layout<T>,
  rect: Rect = { x: 0, y: 0, w: 1, h: 1 },
): { item: T; rect: Rect }[] {
  if (layout.type === "pane") return [{ item: layout.item, rect }];
  const { x, y, w, h } = rect;
  const k = layout.ratio;
  const [a, b]: Rect[] =
    layout.direction === "row"
      ? [
          { x, y, w: w * k, h },
          { x: x + w * k, y, w: w * (1 - k), h },
        ]
      : [
          { x, y, w, h: h * k },
          { x, y: y + h * k, w, h: h * (1 - k) },
        ];
  return [...rectsOf(layout.a, a), ...rectsOf(layout.b, b)];
}

// The two halves of the room `rect` of a split.
function halves(direction: Direction, ratio: number, { x, y, w, h }: Rect): [Rect, Rect] {
  return direction === "row"
    ? [
        { x, y, w: w * ratio, h },
        { x: x + w * ratio, y, w: w * (1 - ratio), h },
      ]
    : [
        { x, y, w, h: h * ratio },
        { x, y: y + h * ratio, w, h: h * (1 - ratio) },
      ];
}

/** The way from the top of a layout to one of its splits: a half at each step. */
export type Path = ("a" | "b")[];

/** The line between the two halves of a split, which dragging moves. */
export type Divider = {
  path: Path;
  direction: Direction;
  ratio: number;
  /** The room of the whole split: the line crosses it. */
  rect: Rect;
};

/** Every divider of `layout`, outer ones first. */
export function dividersOf<T>(
  layout: Layout<T>,
  rect: Rect = { x: 0, y: 0, w: 1, h: 1 },
  path: Path = [],
): Divider[] {
  if (layout.type === "pane") return [];
  const [a, b] = halves(layout.direction, layout.ratio, rect);
  return [
    { path, direction: layout.direction, ratio: layout.ratio, rect },
    ...dividersOf(layout.a, a, [...path, "a"]),
    ...dividersOf(layout.b, b, [...path, "b"]),
  ];
}

/**
 * The same tree, with `ratio` for the split at `path` and no other: the
 * splits inside its halves keep theirs. Unchanged without a split there.
 */
export function withRatio<T>(layout: Layout<T>, path: Path, ratio: number): Layout<T> {
  if (layout.type === "pane") return layout;
  if (path.length === 0) return { ...layout, ratio };
  const [step, ...rest] = path;
  return step === "a"
    ? { ...layout, a: withRatio(layout.a, rest, ratio) }
    : { ...layout, b: withRatio(layout.b, rest, ratio) };
}

/**
 * The ratio of a split `size` pixels long, held so that each half keeps
 * `min` pixels: a split too short for both gets half each.
 */
export function clampRatio(ratio: number, size: number, min: number): number {
  if (size < 2 * min) return 0.5;
  return Math.min(1 - min / size, Math.max(min / size, ratio));
}

// Below this, two edges are the same one: fractions add up with errors.
const EPSILON = 1e-6;

/** A pane in pixels, from the top left of the area. */
export type Box = { left: number; top: number; width: number; height: number };

/**
 * Where `rect` is in an area of `width` x `height` pixels, with `gap`
 * pixels between two panes: each takes half of it on the sides it shares
 * with another, none at the edges of the area. Whole pixels, so that two
 * panes side by side meet without a seam.
 */
export function boxOf(rect: Rect, width: number, height: number, gap: number): Box {
  const start = (at: number, size: number) => Math.round(at * size + (at > EPSILON ? gap / 2 : 0));
  const end = (at: number, size: number) =>
    Math.round(at * size - (at < 1 - EPSILON ? gap / 2 : 0));
  const left = start(rect.x, width);
  const top = start(rect.y, height);
  return {
    left,
    top,
    width: Math.max(0, end(rect.x + rect.w, width) - left),
    height: Math.max(0, end(rect.y + rect.h, height) - top),
  };
}

/**
 * The pane on `side` of the one of `item`: of those that touch its edge
 * there, the one that shares more of it, the first in order on a tie.
 * `null` at the edge of the area.
 */
export function neighbour<T>(layout: Layout<T>, item: T, side: Side): T | null {
  const all = rectsOf(layout);
  const from = all.find((pane) => pane.item === item)?.rect;
  if (!from) return null;
  let best: T | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  let bestShared = 0;
  for (const { item: other, rect } of all) {
    if (other === item) continue;
    const across = side === "left" || side === "right";
    const gap =
      side === "right"
        ? rect.x - (from.x + from.w)
        : side === "left"
          ? from.x - (rect.x + rect.w)
          : side === "down"
            ? rect.y - (from.y + from.h)
            : from.y - (rect.y + rect.h);
    if (gap < -EPSILON) continue;
    const shared = across
      ? Math.min(from.y + from.h, rect.y + rect.h) - Math.max(from.y, rect.y)
      : Math.min(from.x + from.w, rect.x + rect.w) - Math.max(from.x, rect.x);
    if (shared <= EPSILON) continue;
    const closer = gap < bestGap - EPSILON;
    const same = Math.abs(gap - bestGap) <= EPSILON;
    if (closer || (same && shared > bestShared + EPSILON)) {
      best = other;
      bestGap = gap;
      bestShared = shared;
    }
  }
  return best;
}

/**
 * A layout as the state file keeps it: a leaf is the position of its tab
 * among those of the space. Mirror of `Layout` in core/src/state.rs.
 */
export type SavedLayout =
  | number
  | { split: Direction; ratio: number; a: SavedLayout; b: SavedLayout };

/** `layout` for the state file, with `index` of each item in its leaves. */
export function toSavedLayout<T>(layout: Layout<T>, index: (item: T) => number): SavedLayout {
  if (layout.type === "pane") return index(layout.item);
  return {
    split: layout.direction,
    ratio: layout.ratio,
    a: toSavedLayout(layout.a, index),
    b: toSavedLayout(layout.b, index),
  };
}

/**
 * A layout of the state file, with the positions of the tabs in its
 * leaves. `null` if it cannot be one: a position past `count` or already
 * in `used`, a ratio out of (0, 1), fewer than two panes or too many. The
 * positions it takes go into `used`.
 */
export function fromSavedLayout(
  saved: SavedLayout,
  count: number,
  used: Set<number>,
): Layout<number> | null {
  const taken = new Set<number>();
  const read = (node: SavedLayout): Layout<number> | null => {
    if (typeof node === "number") {
      if (!Number.isInteger(node) || node < 0 || node >= count) return null;
      if (used.has(node) || taken.has(node)) return null;
      taken.add(node);
      return single(node);
    }
    if (node.split !== "row" && node.split !== "column") return null;
    if (!(node.ratio > 0 && node.ratio < 1)) return null;
    const a = read(node.a);
    const b = a && read(node.b);
    return a && b ? { type: "split", direction: node.split, ratio: node.ratio, a, b } : null;
  };
  const layout = read(saved);
  if (!layout || taken.size < 2 || taken.size > MAX_PANES) return null;
  for (const index of taken) used.add(index);
  return layout;
}
