import { cellAtCol, cellsOf } from "./geometry";
import { type Cursor, type Frame, type Segment, SegmentFlags } from "./types";

// Background used before the first frame arrives: from then on colors
// (background and cursor included) come already resolved from the core.
const INITIAL_BG = 0xffffff;

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
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("the canvas has no 2D context");
    this.ctx = ctx;
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

    // A glyph taller than the row (stacked marks, a fallback font) must not
    // leave traces on the rows next to it, which are not redrawn with it.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, this.canvas.width, cellHeight);
    ctx.clip();

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
        // Drawing the cells one by one keeps the grid aligned even if the
        // font is not exactly the measured width. A glyph wider than its
        // cell, as a fallback font may give, is squeezed into it.
        for (const text of cellsOf(seg)) {
          if (text !== " ") ctx.fillText(text, cx, y + ascent, advance);
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
    ctx.restore();
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
        // The character under the cursor stays readable, inverted: only
        // the part of it that is inside the block.
        const under = cellAtCol(this.rows[cursor.row] ?? [], cursor.col);
        if (under && under.text !== " ") {
          const advance = under.flags & SegmentFlags.WIDE ? cellWidth * 2 : cellWidth;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, cellWidth, cellHeight);
          ctx.clip();
          ctx.font = this.font(under.flags);
          ctx.fillStyle = this.color(this.background);
          ctx.fillText(under.text, x, y + ascent, advance);
          ctx.restore();
        }
        break;
      }
      case "underline":
        ctx.fillRect(x, y + cellHeight - 2 * this.dpr, cellWidth, 2 * this.dpr);
        break;
      case "beam":
        ctx.fillRect(x, y, 2 * this.dpr, cellHeight);
        break;
      // Four edges, one device pixel thick: the text under it stays as it is.
      case "hollow": {
        const t = this.dpr;
        ctx.fillRect(x, y, cellWidth, t);
        ctx.fillRect(x, y + cellHeight - t, cellWidth, t);
        ctx.fillRect(x, y, t, cellHeight);
        ctx.fillRect(x + cellWidth - t, y, t, cellHeight);
        break;
      }
    }
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
