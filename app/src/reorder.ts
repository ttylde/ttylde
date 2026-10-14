/**
 * Where a dragged row lands: its place among the others, counted from the
 * top. `centers` are the middles of the rows before the drag, `from` is the
 * one being dragged and `y` is its middle now. It passes a row as soon as
 * its middle reaches the middle of that row: dragged as far as it goes, it
 * stops exactly on the middle of the first or the last row, and takes its
 * place.
 */
export function dropIndex(centers: number[], from: number, y: number): number {
  return centers.filter((center, index) =>
    index < from ? center < y : index > from && center <= y,
  ).length;
}

/**
 * How far the row at `index` moves to make room while the one at `from` is
 * dragged to `to`: one `step` up or down, or not at all.
 */
export function makeRoom(index: number, from: number, to: number, step: number): number {
  if (index > from && index <= to) return -step;
  if (index < from && index >= to) return step;
  return 0;
}
