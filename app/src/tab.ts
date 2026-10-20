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
  /** Whether the user is looking at the tab: shown, in a window in front. */
  isSeen(tab: Tab): boolean;
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
  start: TabStart,
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
    command: null,
    restart: null,
    ready: false,
    offer: null,
    status: READY,
    favorites: [],
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
      case "CommandEnd":
        tab.restart = null;
        tab.status = ended(tab.status, event.data, Date.now(), handlers.isSeen(tab));
        handlers.onCommand(tab);
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
    tab.id = await invoke<number>("session_open", { ...size, ...start, onEvent });
  } catch (error) {
    canvas.remove();
    throw error;
  }
  attachMouse(canvas, textarea, renderer, tab.id, () => tab.mouse, tab.abort.signal);
  return tab;
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
