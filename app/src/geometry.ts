import type { Metrics } from "./renderer";
import { type Segment, SegmentFlags } from "./types";

export type SelectionSide = "Left" | "Right";

export type Cell = { row: number; col: number; side: SelectionSide };

/**
 * From a point in physical pixels to the cell under it.
 *
 * The point is clamped inside the grid: dragging outside the canvas puts
 * the selection on the edge, and `edgeScroll` scrolls the view under it. `side` is the half of the cell that was
 * hit: the core uses it to tell whether the selection edge falls before or
 * after that character.
 */
export function cellAtPoint(
  x: number,
  y: number,
  metrics: Metrics,
  cols: number,
  rows: number,
): Cell {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  const fx = clamp(x / metrics.cellWidth, cols - 1e-6);
  const fy = clamp(y / metrics.cellHeight, rows - 1e-6);
  const col = Math.floor(fx);
  const row = Math.floor(fy);
  const side: SelectionSide = fx - col < 0.5 ? "Left" : "Right";
  return { row, col, side };
}

/** The most rows a drag past the edge scrolls on each tick. */
const EDGE_MAX_ROWS = 10;

/**
 * How many rows the view scrolls on each tick of a selection dragged past
 * the top of the grid (positive, into the history) or past its bottom
 * (negative), as the core counts them; 0 while the pointer is over it.
 * One row a tick right past the edge, one more for each row further.
 *
 * `y` is the pointer from the top of the grid, `height` the height of the
 * grid and `rowHeight` that of a row, all in CSS pixels.
 */
export function edgeScroll(y: number, height: number, rowHeight: number): number {
  const beyond = y < 0 ? -y : y - height;
  if (beyond <= 0) return 0;
  const rows = Math.min(EDGE_MAX_ROWS, 1 + Math.floor(beyond / rowHeight));
  return y < 0 ? rows : -rows;
}

/**
 * The text of each cell of a segment, in order.
 *
 * A cell holds one character, so the text splits by code point; a cluster
 * is the exception, a single cell whose text is a character and its marks.
 */
export function cellsOf(seg: Segment): string[] {
  return seg.flags & SegmentFlags.CLUSTER ? [seg.text] : Array.from(seg.text);
}

/** The text and attributes of the cell at column `col` of a row, if any. */
export function cellAtCol(row: Segment[], col: number): { text: string; flags: number } | null {
  let start = 0;
  for (const seg of row) {
    if (col < start + seg.cols) {
      // The second column of a wide character belongs to that character.
      const perCell = seg.flags & SegmentFlags.WIDE ? 2 : 1;
      const text = cellsOf(seg)[Math.floor((col - start) / perCell)];
      return text === undefined ? null : { text, flags: seg.flags };
    }
    start += seg.cols;
  }
  return null;
}
