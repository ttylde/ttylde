// The focus mode: the terminal alone, without sidebar and header. A pill at
// the top says where the user is and keeps a dot for each tab; resting the
// pointer on it lists them by name. Left alone for a while it shrinks to
// the tab shown, and grows back under the pointer or on another tab.

import { iconMarkup, type Look } from "./look";
import type { Status } from "./status";

/**
 * How close two presses of Escape come to leave the focus mode, in
 * milliseconds. One alone belongs to the terminal: vim, less, the shell.
 */
export const DOUBLE_ESCAPE = 400;

/** Whether a press of Escape at `now` makes a pair with the one at `before`. */
export function isDoubleTap(before: number | null, now: number): boolean {
  return before !== null && now - before <= DOUBLE_ESCAPE;
}

/** How long the whole pill stays before it shrinks, in milliseconds. */
const SHRINKS_AFTER = 4000;

/** How long the list stays once the pointer has left the pill, in milliseconds. */
const LIST_LINGERS = 180;

export type PillRow = {
  name: string;
  look: Look;
  status: Status;
  active: boolean;
  select(): void;
};

export type PillContent = {
  /** The tab shown: on another one the pill grows back. */
  key: unknown;
  /** Where the tab is: its space, or what stands for one. */
  space: { name: string; color: string };
  /** What the tab shown is called, or its group, and how it looks. */
  name: string;
  look: Look;
  status: Status;
  branch: string | null;
  rows: PillRow[];
};

export type PillOptions = {
  /** Where the pill goes: over the top of the terminal. */
  root: HTMLElement;
  /** The keys that leave the focus mode, as the pill says them. */
  leaveHint: string;
  onLeave(): void;
  /** The space is clicked: the menu of the spaces opens under `anchor`. */
  onSpaceMenu(anchor: HTMLElement): void;
};

/** The pill of the focus mode, small or whole, and the list of the tabs under it. */
export class FocusPill {
  private readonly bar = document.createElement("div");
  private readonly mini = document.createElement("div");
  private readonly pill = document.createElement("div");
  private readonly list = document.createElement("div");
  private key: unknown = null;
  private hovered = false;
  private menuOpen = false;
  private lingering: number | undefined;
  private shrinking: number | undefined;

  constructor(private options: PillOptions) {
    // The band at the top is where the window is dragged from: nothing else
    // of the window is left to hold.
    this.bar.className = "focus-bar";
    this.bar.dataset.tauriDragRegion = "";
    this.bar.hidden = true;
    this.mini.className = "focus-pill focus-mini";
    this.mini.hidden = true;
    this.pill.className = "focus-pill";
    this.list.className = "focus-list";
    this.list.hidden = true;
    this.bar.append(this.mini, this.pill, this.list);
    options.root.append(this.bar);

    for (const part of [this.mini, this.pill, this.list]) {
      part.addEventListener("mouseenter", () => this.enter());
      part.addEventListener("mouseleave", () => this.leave());
      // The keyboard stays in the terminal.
      part.addEventListener("mousedown", (e) => e.preventDefault());
    }
  }

  show(content: PillContent): void {
    const coming = this.bar.hidden;
    this.bar.hidden = false;
    // Just shown, or on another tab: whole, for a while.
    if (coming || content.key !== this.key) this.grow();
    this.key = content.key;
    this.paint(content);
  }

  hide(): void {
    this.bar.hidden = true;
    this.list.hidden = true;
    this.hovered = false;
    this.menuOpen = false;
    window.clearTimeout(this.lingering);
    window.clearTimeout(this.shrinking);
  }

  /** The menu of the spaces opened from the pill, or closed: open, it keeps the pill whole. */
  setMenuOpen(open: boolean): void {
    this.menuOpen = open;
    this.pill.querySelector(".focus-space")?.classList.toggle("open", open);
    if (open) this.grow();
    else this.shrinkSoon();
  }

  private paint({ space, name, look, status, branch, rows }: PillContent): void {
    // The small one: where, which tab, and its state.
    this.mini.replaceChildren(
      colorDot("focus-space-dot", space.color),
      tabIcon(look),
      element("span", "focus-mono", name),
      statusDot(status),
    );

    const where = element("span", "focus-space");
    where.classList.toggle("open", this.menuOpen);
    where.title = "Switch space (⌃1…9)";
    const chevron = element("span", "focus-chevron");
    chevron.innerHTML =
      '<svg viewBox="0 0 10 6" width="9" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>';
    where.append(
      colorDot("focus-space-dot", space.color),
      element("span", "", space.name),
      chevron,
    );
    where.addEventListener("click", () => this.options.onSpaceMenu(where));

    const parts: Node[] = [
      where,
      element("span", "focus-muted", "›"),
      element("span", "focus-mono", name),
    ];
    if (branch) {
      parts.push(
        element("span", "focus-muted", "·"),
        element("span", "focus-mono focus-muted", `⎇ ${branch}`),
      );
    }
    const dots = element("span", "focus-dots");
    for (const row of rows) {
      const dot = colorDot("focus-dot", row.look.color);
      dot.classList.toggle("active", row.active);
      dot.title = row.name;
      dot.addEventListener("click", () => row.select());
      dots.append(dot);
    }
    const leave = element("span", "focus-leave", this.options.leaveHint);
    leave.title = "Leave focus mode";
    leave.addEventListener("click", () => this.options.onLeave());
    parts.push(element("span", "focus-rule"), dots, leave);
    this.pill.replaceChildren(...parts);

    // Under it, the tabs by name: icon, name, and the state of each.
    this.list.replaceChildren(
      ...rows.map((row) => {
        const item = element("span", "focus-row");
        item.classList.toggle("active", row.active);
        item.append(tabIcon(row.look), row.name, statusDot(row.status));
        item.addEventListener("click", () => row.select());
        return item;
      }),
    );
  }

  private enter(): void {
    this.hovered = true;
    window.clearTimeout(this.lingering);
    this.grow();
    this.list.hidden = false;
  }

  // From the pill to the list the pointer crosses the gap between them.
  private leave(): void {
    window.clearTimeout(this.lingering);
    this.lingering = window.setTimeout(() => {
      this.hovered = false;
      this.list.hidden = true;
      this.shrinkSoon();
    }, LIST_LINGERS);
  }

  private grow(): void {
    this.mini.hidden = true;
    this.pill.hidden = false;
    this.shrinkSoon();
  }

  // Shrinks after a while, unless the pointer or the menu of the spaces
  // still needs the whole pill then.
  private shrinkSoon(): void {
    window.clearTimeout(this.shrinking);
    this.shrinking = window.setTimeout(() => {
      if (this.hovered || this.menuOpen || this.bar.hidden) return;
      this.pill.hidden = true;
      this.mini.hidden = false;
    }, SHRINKS_AFTER);
  }
}

function element(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

// The colors are those of the palette, never text typed by someone.
function colorDot(className: string, color: string): HTMLElement {
  const dot = element("span", className);
  dot.style.setProperty("--dot", color);
  return dot;
}

function tabIcon(look: Look): HTMLElement {
  const icon = element("span", "focus-icon");
  icon.style.color = look.color;
  icon.innerHTML = iconMarkup(look.icon);
  return icon;
}

// A dot in the color of `status`; none when nothing is going on.
function statusDot(status: Status): HTMLElement {
  const dot = element("span", "status-dot focus-status");
  dot.dataset.status = status;
  return dot;
}
