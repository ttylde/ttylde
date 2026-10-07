import type { Metrics } from "./renderer";

export type SelectionSide = "Left" | "Right";

export type Cell = { row: number; col: number; side: SelectionSide };

/**
 * From a point in physical pixels to the cell under it.
 *
 * The point is clamped inside the grid, so dragging outside the canvas
 * stops the selection at the edge. `side` is the half of the cell that was
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
