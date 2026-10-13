import { Channel, invoke } from "@tauri-apps/api/core";

import { folderName } from "./label";
import { defaultLook, type Look } from "./look";
import { attachMouse } from "./mouse";
import { fontStack, Renderer } from "./renderer";
import type { Font, GitStatus, SessionEvent } from "./types";

/** One session with the canvas it is drawn on. */
export type Tab = {
  /** Session id in the core; -1 until the session is open. */
  id: number;
  /** Title set by the program, `null` when there is none. */
  title: string | null;
  /** Folder the session works in, `null` until the core tells. */
  cwd: string | null;
  /** Repository of that folder, `null` when it is in none. */
  git: GitStatus | null;
  /** Name, color and icon the user chose. */
  look: Look;
  /** Background of the last frame, `null` before the first one. */
  background: number | null;
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  exited: boolean;
  /** The program asked for mouse events: they go to it, not to selection. */
  mouse: boolean;
  /** Removes the listeners the tab registered outside its canvas. */
  abort: AbortController;
};

export type TabHandlers = {
  /** The title, the folder or its repository changed. */
  onTitle(tab: Tab): void;
  onBackground(tab: Tab): void;
  onExit(tab: Tab): void;
};

/**
 * Opens a session and a canvas for it inside `container`.
 *
 * Every tab keeps its own canvas and renderer: a tab in the background
 * goes on receiving frames, so showing it again is only a matter of
 * unhiding the canvas.
 */
export async function openTab(
  container: HTMLElement,
  textarea: HTMLTextAreaElement,
  font: Font,
  handlers: TabHandlers,
): Promise<Tab> {
  const canvas = document.createElement("canvas");
  canvas.className = "screen";
  canvas.hidden = true;
  container.appendChild(canvas);

  const renderer = new Renderer(canvas, fontStack(font.family), font.size);
  const size = renderer.fit(container.clientWidth, container.clientHeight);
  const tab: Tab = {
    id: -1,
    title: null,
    cwd: null,
    git: null,
    look: defaultLook(),
    background: null,
    canvas,
    renderer,
    exited: false,
    mouse: false,
    abort: new AbortController(),
  };

  const onEvent = new Channel<SessionEvent>();
  onEvent.onmessage = (event) => {
    switch (event.type) {
      case "Frame":
        tab.mouse = event.data.mouse;
        renderer.apply(event.data);
        if (event.data.background !== tab.background) {
          tab.background = event.data.background;
          handlers.onBackground(tab);
        }
        break;
      case "Title":
        tab.title = event.data;
        handlers.onTitle(tab);
        break;
      case "TitleReset":
        tab.title = null;
        handlers.onTitle(tab);
        break;
      case "Cwd":
        tab.cwd = event.data;
        handlers.onTitle(tab);
        break;
      case "Git":
        tab.git = event.data;
        handlers.onTitle(tab);
        break;
      case "Bell":
        flashBell(canvas);
        break;
      case "Exit":
        tab.exited = true;
        handlers.onExit(tab);
        break;
    }
  };

  try {
    tab.id = await invoke<number>("session_open", { ...size, onEvent });
  } catch (error) {
    canvas.remove();
    throw error;
  }
  attachMouse(canvas, textarea, renderer, tab.id, () => tab.mouse, tab.abort.signal);
  return tab;
}

/**
 * What the tab is called when the user gave it no name: the folder it
 * works in or, until that is known, the title of its program. The folder
 * comes first because it stays put: a title changes with every command.
 */
export function defaultTitle(tab: Tab): string | null {
  return tab.cwd === null ? tab.title : folderName(tab.cwd);
}

/** Closes the session and removes everything `openTab` created. */
export function closeTab(tab: Tab): void {
  tab.abort.abort();
  tab.canvas.remove();
  if (tab.id >= 0) void invoke("session_close", { id: tab.id });
}

/** Refits the canvas to `width` x `height` CSS pixels and resizes the session. */
export function resizeTab(tab: Tab, width: number, height: number): void {
  const { cols, rows } = tab.renderer.fit(width, height);
  void invoke("session_resize", { id: tab.id, cols, rows });
}

/**
 * Tells the session whether it is the one the user is looking at: the core
 * draws the cursor hollow when it is not, and informs the program.
 */
export function focusTab(tab: Tab, focused: boolean): void {
  if (tab.id >= 0) void invoke("session_focus", { id: tab.id, focused });
}

// Visual bell: the screen brightens for a moment. A bell that rings while
// the flash is on restarts it.
const bellTimers = new WeakMap<HTMLCanvasElement, number>();
function flashBell(canvas: HTMLCanvasElement): void {
  canvas.classList.add("bell");
  window.clearTimeout(bellTimers.get(canvas));
  bellTimers.set(
    canvas,
    window.setTimeout(() => canvas.classList.remove("bell"), 120),
  );
}
