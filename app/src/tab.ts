import { Channel, invoke } from "@tauri-apps/api/core";

import { folderName } from "./label";
import { defaultLook, type Look } from "./look";
import { attachMouse } from "./mouse";
import { fontStack, Renderer } from "./renderer";
import { ended, READY, started, type TabStatus } from "./status";
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
  /**
   * The last command the shell ran, `null` until one is known. Only from a
   * shell with the integration, as the three below.
   */
  command: string | null;
  /** The command still running in the foreground: one to start again. */
  restart: string | null;
  /** The shell has shown its first prompt. */
  ready: boolean;
  /** A command that was running last time, offered to start again. */
  offer: string | null;
  /** Running a command, done with one, or at the prompt: the dot. */
  status: TabStatus;
  /**
   * The ids of the saved commands in its header, in their order: each tab
   * has its own. A new tab has none.
   */
  favorites: number[];
  /** Name, color and icon the user chose. */
  look: Look;
  /** Background of the last frame, `null` before the first one. */
  background: number | null;
  /** Where it is in the terminal area: the box of the canvas, as a pane. */
  pane: HTMLElement;
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  exited: boolean;
  /** The program asked for mouse events: they go to it, not to selection. */
  mouse: boolean;
  /** Removes the listeners the tab registered outside its canvas. */
  abort: AbortController;
};

/** Where a session starts, and with what. */
export type TabStart = {
  /** Folder, `~` for the home; the home when it does not exist. */
  cwd: string;
  /** The shell to run, `null` for the one of the system. */
  shell: string | null;
};

export type TabHandlers = {
  /** The title, the folder or its repository changed. */
  onTitle(tab: Tab): void;
  /** A command started or ended, or the shell shows a prompt. */
  onCommand(tab: Tab): void;
  /** A command ended: `before` is the state it had while it ran. */
  onEnd(tab: Tab, before: TabStatus): void;
  /** Whether the user is looking at the tab: shown, in a window in front. */
  isSeen(tab: Tab): boolean;
  /** Whether it is the tab the keyboard writes to, seen or not. */
  isActive(tab: Tab): boolean;
  onBackground(tab: Tab): void;
  /** A frame came: what the screen of the tab shows changed. */
  onFrame(tab: Tab): void;
  onExit(tab: Tab): void;
};

/**
 * The room around the canvas inside its pane, in CSS pixels: the margin of
 * the terminal, which every pane has, alone or next to others.
 */
export const PANE_PADDING = { x: 14, y: 10 };

/**
 * Opens a session and a canvas for it inside `container`, in a pane as
 * big as it.
 *
 * Every tab keeps its own canvas and renderer: a tab in the background
 * goes on receiving frames, so showing it again is only a matter of
 * unhiding its pane.
 */
export async function openTab(
  container: HTMLElement,
  textarea: HTMLTextAreaElement,
  font: Font,
  start: TabStart,
  handlers: TabHandlers,
): Promise<Tab> {
  const pane = document.createElement("div");
  pane.className = "pane";
  pane.hidden = true;
  pane.style.padding = `${PANE_PADDING.y}px ${PANE_PADDING.x}px`;
  const canvas = document.createElement("canvas");
  canvas.className = "screen";
  pane.appendChild(canvas);
  container.appendChild(pane);

  const renderer = new Renderer(canvas, fontStack(font.family), font.size);
  const size = renderer.fit(...inside(container.clientWidth, container.clientHeight));
  const tab: Tab = {
    id: -1,
    title: null,
    cwd: null,
    git: null,
    command: null,
    restart: null,
    ready: false,
    offer: null,
    status: READY,
    favorites: [],
    look: defaultLook(),
    background: null,
    pane,
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
        handlers.onFrame(tab);
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
      case "Prompt":
        tab.ready = true;
        handlers.onCommand(tab);
        break;
      case "CommandStart":
        if (event.data !== null) tab.command = event.data;
        tab.status = started(tab.status, Date.now());
        tab.restart = null;
        // Another command than the one offered: the offer is over.
        tab.offer = null;
        handlers.onCommand(tab);
        break;
      case "CommandRunning":
        tab.restart = event.data;
        handlers.onCommand(tab);
        break;
      case "CommandEnd": {
        tab.restart = null;
        const before = tab.status;
        tab.status = ended(before, event.data, Date.now(), handlers.isSeen(tab));
        handlers.onCommand(tab);
        handlers.onEnd(tab, before);
        break;
      }
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
    tab.id = await invoke<number>("session_open", { ...size, ...start, onEvent });
  } catch (error) {
    pane.remove();
    throw error;
  }
  attachMouse(
    canvas,
    textarea,
    renderer,
    tab.id,
    () => tab.mouse,
    () => handlers.isActive(tab),
    tab.abort.signal,
  );
  return tab;
}

/** The background of the last frame of `tab`, as CSS; `null` before one. */
export function backgroundOf(tab: Tab): string | null {
  return tab.background === null ? null : `#${tab.background.toString(16).padStart(6, "0")}`;
}

/** What a tab with no name, no title and no known folder is called. */
export const UNTITLED = "shell";

/** What the tab is called: the name the user gave it, or the default one. */
export function titleOf(tab: Tab): string {
  return tab.look.name ?? defaultTitle(tab) ?? UNTITLED;
}

/**
 * What the tab is called when the user gave it no name: the folder it
 * works in or, until that is known, the title of its program. The folder
 * comes first because it stays put: a title changes with every command.
 */
export function defaultTitle(tab: Tab): string | null {
  return tab.cwd === null ? tab.title : folderName(tab.cwd);
}

/** Types `command` into the shell of `tab` and runs it, as if the user had. */
export function typeCommand(tab: Tab, command: string): void {
  if (tab.id >= 0) void invoke("session_write", { id: tab.id, text: `${command}\r` });
}

/**
 * Whether a command that was running when its tab closed starts again by
 * itself, as the config file says, rather than waiting for Enter.
 */
export async function runsByItself(command: string): Promise<boolean> {
  try {
    return await invoke<boolean>("restore_runs_by_itself", { command });
  } catch {
    return false;
  }
}

/**
 * Tells the session of `tab` the space it is in, `null` for none: the
 * history records it with each command that ends.
 */
export function setTabSpace(tab: Tab, space: number | null): void {
  if (tab.id >= 0) void invoke("session_set_space", { id: tab.id, space });
}

/** Closes the session and removes everything `openTab` created. */
export function closeTab(tab: Tab): void {
  tab.abort.abort();
  tab.pane.remove();
  if (tab.id >= 0) void invoke("session_close", { id: tab.id });
}

/**
 * The prompt above the first line shown (`up`), or below it, comes to the
 * top of the view.
 */
export function jumpToPrompt(tab: Tab, up: boolean): void {
  if (tab.id >= 0) void invoke("session_jump_to_prompt", { id: tab.id, up });
}

/** The output of the last command run in `tab`, `null` if there is none. */
export async function lastOutput(tab: Tab): Promise<string | null> {
  if (tab.id < 0) return null;
  return invoke<string | null>("session_last_output", { id: tab.id });
}

/** The last `count` lines of the output of the last command run in `tab`. */
export async function outputTail(tab: Tab, count: number): Promise<string[]> {
  if (tab.id < 0) return [];
  return invoke<string[]>("session_output_tail", { id: tab.id, count });
}

/**
 * Selects the output of the last command run in `tab`, ready for Cmd+C.
 * Returns whether there was one.
 */
export async function selectLastOutput(tab: Tab): Promise<boolean> {
  if (tab.id < 0) return false;
  const selected = await invoke<boolean>("session_select_last_output", { id: tab.id });
  if (!selected) return false;
  const text = await invoke<string | null>("session_selection_text", { id: tab.id });
  // The mouse keeps the text of the selection for the clipboard.
  tab.canvas.dispatchEvent(new CustomEvent<string | null>("selected", { detail: text }));
  return true;
}

/**
 * Refits the canvas to a pane of `width` x `height` CSS pixels and resizes
 * the session, if its grid changes.
 */
export function resizeTab(tab: Tab, width: number, height: number): void {
  const { cols, rows } = tab.renderer.fit(...inside(width, height));
  void invoke("session_resize", { id: tab.id, cols, rows });
}

// The room of the canvas in a pane of `width` x `height`.
function inside(width: number, height: number): [number, number] {
  return [Math.max(1, width - 2 * PANE_PADDING.x), Math.max(1, height - 2 * PANE_PADDING.y)];
}

/**
 * Tells the session whether it is the one the user is looking at: the core
 * draws the cursor hollow when it is not, and informs the program.
 */
export function focusTab(tab: Tab, focused: boolean): void {
  if (tab.id >= 0) void invoke("session_focus", { id: tab.id, focused });
}

// Visual bell: the screen flashes for a moment. A bell that rings while
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
