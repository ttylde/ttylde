import { invoke } from "@tauri-apps/api/core";

import { cellAtPoint, type Cell } from "./geometry";
import type { Renderer } from "./renderer";

// Same names as the `SelectionKind` variants in the core.
type SelectionKind = "Simple" | "Word" | "Line";

/** Single, double and triple click: character, word, line. */
export function kindOf(clicks: number): SelectionKind {
  if (clicks >= 3) return "Line";
  if (clicks === 2) return "Word";
  return "Simple";
}

/**
 * Wires the mouse to selection and Cmd+C to copy.
 *
 * Geometry (which cell is under the pointer) is computed here; what
 * selecting means is up to the core, which answers with a frame.
 *
 * The selected text is read from the core on mouse release and kept aside:
 * the `copy` event is synchronous and cannot wait for an `invoke`.
 * No clipboard plugin needed, `clipboardData.setData` is enough.
 */
export function attachMouse(
  canvas: HTMLCanvasElement,
  textarea: HTMLTextAreaElement,
  renderer: Renderer,
  sessionId: number,
): void {
  let selecting = false;
  let pending: Cell | null = null;
  let scheduled = false;
  let selectedText: string | null = null;

  function cellOf(e: MouseEvent): Cell {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (e.clientX - rect.left) * dpr;
    const y = (e.clientY - rect.top) * dpr;
    const { cols, rows } = renderer.gridSize();
    return cellAtPoint(x, y, renderer.getMetrics(), cols, rows);
  }

  canvas.addEventListener("mousedown", (e) => {
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
  window.addEventListener("mousemove", (e) => {
    if (!selecting) return;
    pending = cellOf(e);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!pending) return;
      const { row, col, side } = pending;
      pending = null;
      void invoke("session_select_update", { id: sessionId, row, col, side });
    });
  });

  window.addEventListener("mouseup", async (e) => {
    if (!selecting || e.button !== 0) return;
    selecting = false;
    pending = null;
    selectedText = await invoke<string | null>("session_selection_text", { id: sessionId });
  });

  textarea.addEventListener("copy", (e) => {
    if (!selectedText) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", selectedText);
  });

  // Typing clears the selection in the core: the text kept aside is stale.
  textarea.addEventListener("keydown", (e) => {
    if (!e.metaKey) selectedText = null;
  });
  textarea.addEventListener("input", () => {
    selectedText = null;
  });
}
