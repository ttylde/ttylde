import { type Cursor, type Frame, type Segment, SegmentFlags } from "./types";

// Background used before the first frame arrives: from then on colors
// (background and cursor included) come already resolved from the core.
const INITIAL_BG = 0x16161a;

/**
 * The CSS font family for a configured font: the name quoted, followed by
 * the fonts to fall back on when it is not installed.
 */
export function fontStack(family: string): string {
  const name = family.replace(/["\\]/g, "\\$&");
  return `"${name}", Menlo, Monaco, monospace`;
}

export type Metrics = { cellWidth: number; cellHeight: number; ascent: number };

/**
 * Draws frames on a 2D canvas.
 *
 * Keeps a copy of the current rows (`rows`) so a single row can be redrawn
 * on its own, e.g. when the cursor leaves it. Everything works in physical
 * pixels: the canvas is `devicePixelRatio` times its CSS size.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private metrics: Metrics = { cellWidth: 0, cellHeight: 0, ascent: 0 };
  private cols = 0;
  private rows: Segment[][] = [];
  private cursor: Cursor | null = null;
  private background = INITIAL_BG;
  private dirty = new Set<number>();
  private scheduled = false;
  private colorCache = new Map<number, string>();

  constructor(
    private canvas: HTMLCanvasElement,
    private fontFamily: string,
    private fontSize: number,
  ) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Measures a cell with the current font, in physical pixels. */
  private measure(): void {
    this.ctx.font = this.font(0);
    const m = this.ctx.measureText("M");
    const ascent = Math.ceil(m.fontBoundingBoxAscent);
    const descent = Math.ceil(m.fontBoundingBoxDescent);
    this.metrics = {
      cellWidth: Math.ceil(m.width),
      cellHeight: ascent + descent,
      ascent,
    };
  }

  /**
   * Fits the canvas to the available space (in CSS pixels) and returns
   * how many columns and rows fit.
   */
  fit(width: number, height: number): { cols: number; rows: number } {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.measure();

    const cols = Math.max(1, Math.floor(this.canvas.width / this.metrics.cellWidth));
    const rows = Math.max(1, Math.floor(this.canvas.height / this.metrics.cellHeight));

    // Resizing clears the canvas: paint the background now, the content
    // arrives with the full frame the core sends after the resize.
    this.ctx.fillStyle = this.color(this.background);
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    return { cols, rows };
  }

  /** Current cell metrics, in physical pixels. */
  getMetrics(): Metrics {
    return this.metrics;
  }

  /** Columns and rows of the last frame received. */
  gridSize(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows.length };
  }

  /** Cell height in CSS pixels, to turn wheel deltas into rows. */
  cellHeightCss(): number {
    return this.metrics.cellHeight / this.dpr;
  }

  /** Applies a frame: updates the model and schedules a draw. */
  apply(frame: Frame): void {
    if (frame.background !== this.background) {
      this.background = frame.background;
      for (let r = 0; r < frame.rows; r++) this.dirty.add(r);
    }
    if (frame.full || frame.cols !== this.cols || frame.rows !== this.rows.length) {
      this.cols = frame.cols;
      this.rows = Array.from({ length: frame.rows }, () => []);
      for (let r = 0; r < frame.rows; r++) this.dirty.add(r);
    }
    for (const line of frame.lines) {
      this.rows[line.row] = line.segments;
      this.dirty.add(line.row);
    }
    // The row the cursor leaves must be redrawn without it.
    if (this.cursor) this.dirty.add(this.cursor.row);
    this.cursor = frame.cursor;
    if (this.cursor) this.dirty.add(this.cursor.row);
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.draw();
    });
  }

  private draw(): void {
    for (const row of this.dirty) {
      if (row < this.rows.length) this.drawRow(row);
    }
    this.dirty.clear();
    if (this.cursor && this.cursor.row < this.rows.length) this.drawCursor(this.cursor);
  }

  private drawRow(row: number): void {
    const { cellWidth, cellHeight, ascent } = this.metrics;
    const ctx = this.ctx;
    const y = row * cellHeight;

    ctx.fillStyle = this.color(this.background);
    ctx.fillRect(0, y, this.canvas.width, cellHeight);

    let col = 0;
    for (const seg of this.rows[row]) {
      const x = col * cellWidth;
      const width = seg.cols * cellWidth;

      if (seg.bg !== this.background) {
        ctx.fillStyle = this.color(seg.bg);
        ctx.fillRect(x, y, width, cellHeight);
      }

      if (seg.text.length > 0) {
        ctx.font = this.font(seg.flags);
        ctx.fillStyle = this.color(seg.fg);
        const advance = seg.flags & SegmentFlags.WIDE ? cellWidth * 2 : cellWidth;
        let cx = x;
        // One character per cell: drawing them one by one keeps the grid
        // aligned even if the font is not exactly the measured width.
        for (const ch of seg.text) {
          if (ch !== " ") ctx.fillText(ch, cx, y + ascent);
          cx += advance;
        }
      }

      if (seg.flags & SegmentFlags.UNDERLINE) {
        ctx.fillStyle = this.color(seg.fg);
        ctx.fillRect(x, y + ascent + this.dpr, width, this.dpr);
      }
      if (seg.flags & SegmentFlags.STRIKE) {
        ctx.fillStyle = this.color(seg.fg);
        ctx.fillRect(x, y + Math.round(cellHeight * 0.55), width, this.dpr);
      }
      col += seg.cols;
    }
  }

  private drawCursor(cursor: Cursor): void {
    const { cellWidth, cellHeight, ascent } = this.metrics;
    const ctx = this.ctx;
    const x = cursor.col * cellWidth;
    const y = cursor.row * cellHeight;
    ctx.fillStyle = this.color(cursor.color);

    switch (cursor.shape) {
      case "block": {
        ctx.fillRect(x, y, cellWidth, cellHeight);
        // The character under the cursor stays readable, inverted.
        const under = this.cellAt(cursor.row, cursor.col);
        if (under && under.ch !== " ") {
          ctx.font = this.font(under.flags);
          ctx.fillStyle = this.color(this.background);
          ctx.fillText(under.ch, x, y + ascent);
        }
        break;
      }
      case "underline":
        ctx.fillRect(x, y + cellHeight - 2 * this.dpr, cellWidth, 2 * this.dpr);
        break;
      case "beam":
        ctx.fillRect(x, y, 2 * this.dpr, cellHeight);
        break;
    }
  }

  /** The character and attributes in cell (row, col), if any. */
  private cellAt(row: number, col: number): { ch: string; flags: number } | null {
    let start = 0;
    for (const seg of this.rows[row] ?? []) {
      if (col < start + seg.cols) {
        if (seg.text.length === 0) return null;
        const perChar = seg.flags & SegmentFlags.WIDE ? 2 : 1;
        const index = Math.floor((col - start) / perChar);
        const ch = Array.from(seg.text)[index];
        return ch === undefined ? null : { ch, flags: seg.flags };
      }
      start += seg.cols;
    }
    return null;
  }

  private font(flags: number): string {
    const weight = flags & SegmentFlags.BOLD ? "bold " : "";
    const style = flags & SegmentFlags.ITALIC ? "italic " : "";
    return `${style}${weight}${this.fontSize * this.dpr}px ${this.fontFamily}`;
  }

  private color(rgb: number): string {
    let css = this.colorCache.get(rgb);
    if (!css) {
      css = `#${rgb.toString(16).padStart(6, "0")}`;
      this.colorCache.set(rgb, css);
    }
    return css;
  }
}
