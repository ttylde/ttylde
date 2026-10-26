import { invoke } from "@tauri-apps/api/core";

import { type Cell, cellAtPoint, edgeScroll } from "./geometry";
import type { Renderer } from "./renderer";

// Same names as the `SelectionKind` variants in the core.
type SelectionKind = "Simple" | "Word" | "Line";

// Same names as `MouseButton` and `MouseAction` in the core.
type MouseButton = "Left" | "Middle" | "Right" | "WheelUp" | "WheelDown";
type MouseAction = "Press" | "Release" | "Move";

/** How often a selection dragged past the edge scrolls the view, in ms. */
const EDGE_EVERY = 50;

/** The core's name for a DOM `MouseEvent.button`, `null` for the extra ones. */
export function buttonOf(button: number): MouseButton | null {
  return (["Left", "Middle", "Right"] as const)[button] ?? null;
}

/** Single, double and triple click: character, word, line. */
export function kindOf(clicks: number): SelectionKind {
  if (clicks >= 3) return "Line";
  if (clicks === 2) return "Word";
  return "Simple";
}

/**
 * Wires the mouse to selection, to Cmd+C and to the programs that ask for
 * mouse events.
 *
 * Geometry (which cell is under the pointer) is computed here; what
 * selecting means is up to the core, which answers with a frame.
 *
 * While `reporting()` is true the program has asked for the mouse: clicks,
 * moves and wheel go to it instead of selecting and scrolling. The core
 * knows which of them the program wants and drops the rest. Holding Shift
 * gives the mouse back to the terminal, as in xterm.
 *
 * A selection dragged above or below the grid scrolls the view on a
 * timer, as long as the pointer stays there: it may not move at all.
 *
 * The selected text is read from the core on mouse release and kept aside:
 * the `copy` event is synchronous and cannot wait for an `invoke`.
 * No clipboard plugin needed, `clipboardData.setData` is enough.
 *
 * The textarea is shared by every tab: its listeners answer only while
 * this tab is the active one, and `signal` removes them, with the ones
 * on `window`, when the tab closes.
 */
export function attachMouse(
  canvas: HTMLCanvasElement,
  textarea: HTMLTextAreaElement,
  renderer: Renderer,
  sessionId: number,
  reporting: () => boolean,
  /** Whether it is the tab the keyboard writes to: Cmd+C copies from it. */
  active: () => boolean,
  signal: AbortSignal,
): void {
  let selecting = false;
  // The button whose press went to the program, until its release.
  let held: MouseButton | null = null;
  // Last cell reported: a move inside the same cell is not news.
  let reported: { row: number; col: number } | null = null;
  let pending: MouseEvent | null = null;
  let scheduled = false;
  let selectedText: string | null = null;
  let wheelRemainder = 0;
  // While a selection is dragged past the edge: the timer that scrolls,
  // and where the pointer was last.
  let edgeTimer = 0;
  let dragged: MouseEvent | null = null;

  function cellOf(e: MouseEvent): Cell {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (e.clientX - rect.left) * dpr;
    const y = (e.clientY - rect.top) * dpr;
    const { cols, rows } = renderer.gridSize();
    return cellAtPoint(x, y, renderer.getMetrics(), cols, rows);
  }

  // Rows to scroll for the pointer of `e`: see `edgeScroll`.
  function edgeOf(e: MouseEvent): number {
    const top = canvas.getBoundingClientRect().top;
    const rowHeight = renderer.cellHeightCss();
    return edgeScroll(e.clientY - top, renderer.gridSize().rows * rowHeight, rowHeight);
  }

  // Each tick scrolls towards the pointer and extends the selection to the
  // row now at the edge; back over the grid, the moves take over.
  function scrollEdge(): void {
    const delta = dragged && selecting ? edgeOf(dragged) : 0;
    if (delta === 0 || !dragged) {
      stopEdge();
      return;
    }
    const { row, col, side } = cellOf(dragged);
    void invoke("session_select_scroll", { id: sessionId, delta, row, col, side });
  }

  function stopEdge(): void {
    window.clearInterval(edgeTimer);
    edgeTimer = 0;
    dragged = null;
  }

  function forProgram(e: MouseEvent): boolean {
    return reporting() && !e.shiftKey;
  }

  function report(action: MouseAction, button: MouseButton | null, e: MouseEvent): void {
    const { row, col } = cellOf(e);
    reported = { row, col };
    const mods = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey };
    void invoke("session_mouse", { id: sessionId, event: { action, button, row, col, mods } });
  }

  canvas.addEventListener("mousedown", (e) => {
    // Focus stays on the textarea even when clicking the canvas.
    e.preventDefault();
    textarea.focus();
    if (forProgram(e)) {
      const button = buttonOf(e.button);
      if (!button) return;
      held = button;
      report("Press", button, e);
      return;
    }
    if (e.button !== 0) return;
    selecting = true;
    selectedText = null;
    const { row, col, side } = cellOf(e);
    void invoke("session_select_start", {
      id: sessionId,
      row,
      col,
      side,
      kind: kindOf(e.detail),
    });
  });

  // The mouse can move many times per frame: only the latest position is
  // sent to the core, once per animation frame.
  window.addEventListener(
    "mousemove",
    (e) => {
      // A drag is followed anywhere; a move with no button only over the canvas.
      const hovering = !held && e.target === canvas && forProgram(e);
      if (!selecting && !held && !hovering) return;
      if (selecting) {
        dragged = e;
        if (!edgeTimer && edgeOf(e) !== 0) {
          scrollEdge();
          edgeTimer = window.setInterval(scrollEdge, EDGE_EVERY);
        }
      }
      pending = e;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const last = pending;
        pending = null;
        if (!last) return;
        const { row, col, side } = cellOf(last);
        if (selecting) {
          void invoke("session_select_update", { id: sessionId, row, col, side });
        } else if (reported?.row !== row || reported.col !== col) {
          report("Move", held, last);
        }
      });
    },
    { signal },
  );

  window.addEventListener(
    "mouseup",
    async (e) => {
      if (held) {
        if (buttonOf(e.button) !== held) return;
        pending = null;
        report("Release", held, e);
        held = null;
        return;
      }
      if (!selecting || e.button !== 0) return;
      selecting = false;
      pending = null;
      stopEdge();
      selectedText = await invoke<string | null>("session_selection_text", { id: sessionId });
    },
    { signal },
  );

  // A release outside the window may never arrive: the drag ends there.
  window.addEventListener("blur", stopEdge, { signal });
  signal.addEventListener("abort", stopEdge);

  // The right button belongs to the program too.
  canvas.addEventListener("contextmenu", (e) => {
    if (forProgram(e)) e.preventDefault();
  });

  // The wheel arrives in pixels (fractional on a trackpad): we accumulate
  // and send the core whole rows only. deltaY > 0 means "down", which for
  // the core is a negative scroll delta.
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const pixelsPerLine =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 1 : renderer.cellHeightCss();
      wheelRemainder += e.deltaY / pixelsPerLine;
      const lines = Math.trunc(wheelRemainder);
      if (lines === 0) return;
      wheelRemainder -= lines;
      if (forProgram(e)) {
        const button = lines > 0 ? "WheelDown" : "WheelUp";
        for (let i = 0; i < Math.abs(lines); i++) report("Press", button, e);
      } else {
        void invoke("session_scroll", { id: sessionId, delta: -lines });
      }
    },
    { passive: false },
  );

  // A selection made by the app, not by the mouse: its text is ready to copy.
  canvas.addEventListener(
    "selected",
    (e) => {
      selectedText = (e as CustomEvent<string | null>).detail;
    },
    { signal },
  );

  textarea.addEventListener(
    "copy",
    (e) => {
      if (!active() || !selectedText) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", selectedText);
    },
    { signal },
  );

  // Typing clears the selection in the core: the text kept aside is stale.
  textarea.addEventListener(
    "keydown",
    (e) => {
      if (active() && !e.metaKey) selectedText = null;
    },
    { signal },
  );
  textarea.addEventListener(
    "input",
    () => {
      if (active()) selectedText = null;
    },
    { signal },
  );
}
