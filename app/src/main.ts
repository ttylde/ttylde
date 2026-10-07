import { Channel, invoke } from "@tauri-apps/api/core";

import { attachKeyboard } from "./input";
import { attachMouse } from "./mouse";
import { Renderer } from "./renderer";
import type { SessionEvent } from "./types";

const canvas = document.querySelector<HTMLCanvasElement>("#screen")!;
const notice = document.querySelector<HTMLDivElement>("#notice")!;
const renderer = new Renderer(canvas, "Menlo, Monaco, monospace", 13);

// The canvas fills the window; the core decides what goes in each cell.
function fitToWindow(): { cols: number; rows: number } {
  return renderer.fit(window.innerWidth, window.innerHeight);
}

const onEvent = new Channel<SessionEvent>();
onEvent.onmessage = (event) => {
  if (event.type === "Exit") {
    notice.textContent = "The shell has exited.";
    notice.hidden = false;
    return;
  }
  renderer.apply(event.data);
};

const size = fitToWindow();
const sessionId = await invoke<number>("session_open", { ...size, onEvent });
const keyboard = attachKeyboard(canvas, sessionId);
attachMouse(canvas, keyboard, renderer, sessionId);

// The wheel arrives in pixels (fractional on a trackpad): we accumulate and
// send the core whole rows only. deltaY > 0 means "down", which for the core
// is a negative delta.
let wheelRemainder = 0;
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const pixelsPerLine = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 1 : renderer.cellHeightCss();
    wheelRemainder += e.deltaY / pixelsPerLine;
    const lines = Math.trunc(wheelRemainder);
    if (lines === 0) return;
    wheelRemainder -= lines;
    void invoke("session_scroll", { id: sessionId, delta: -lines });
  },
  { passive: false },
);

// On window resize the canvas refits and the core resizes PTY and grid; the
// full frame that follows redraws everything.
let resizeTimer: number | undefined;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const { cols, rows } = fitToWindow();
    void invoke("session_resize", { id: sessionId, cols, rows });
  }, 50);
});
