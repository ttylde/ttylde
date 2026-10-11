import { shortLabel } from "./label";
import { closeTab, focusTab, openTab, resizeTab, type Tab } from "./tab";
import type { Font } from "./types";

/** Shown in the sidebar for a tab whose program has set no title. */
const UNTITLED = "shell";

// `short` is what is left of the title when the sidebar is a rail.
type Entry = { tab: Tab; row: HTMLElement; label: HTMLElement; short: HTMLElement };

export type TabsOptions = {
  /** Where the rows go, in the sidebar. */
  list: HTMLElement;
  /** Where the canvases go; its size is the size of every tab. */
  screens: HTMLElement;
  textarea: HTMLTextAreaElement;
  /** Font of every tab, from the config file. */
  font: Font;
  /** The active tab, its title or its background changed. `null`: no tab is left. */
  onActiveChange(tab: Tab | null): void;
};

/**
 * The open tabs: one row each in the sidebar, one canvas each in the
 * terminal area, a single one visible.
 */
export class Tabs {
  private entries: Entry[] = [];
  private active: Tab | null = null;
  // Whether the window has the focus: only then the visible tab has it.
  private focused = document.hasFocus();

  constructor(private options: TabsOptions) {}

  /** Session id of the visible tab, the one the keyboard writes to. */
  activeId(): number | null {
    return this.active?.id ?? null;
  }

  /** Opens a tab at the end of the list and shows it. */
  async open(): Promise<void> {
    const { list, screens, textarea, font } = this.options;
    const tab = await openTab(screens, textarea, font, {
      onTitle: (tab) => this.retitle(tab),
      onBackground: (tab) => {
        if (tab === this.active) this.options.onActiveChange(tab);
      },
      onExit: (tab) => this.close(tab),
    });
    // The shell can die before `session_open` returns.
    if (tab.exited) {
      closeTab(tab);
      if (this.entries.length === 0) this.options.onActiveChange(null);
      return;
    }

    const row = document.createElement("div");
    row.className = "tab";
    const short = document.createElement("span");
    short.className = "tab-short";
    const label = document.createElement("span");
    label.className = "tab-title";
    const close = document.createElement("button");
    close.className = "tab-close";
    close.title = "Close tab";
    close.textContent = "×";
    row.append(short, label, close);
    list.appendChild(row);

    row.addEventListener("click", () => this.activate(tab));
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close(tab);
    });

    this.entries.push({ tab, row, label, short });
    this.retitle(tab);
    this.activate(tab);
  }

  /** Shows the tab at `index`, if there is one. */
  select(index: number): void {
    const entry = this.entries[index];
    if (entry) this.activate(entry.tab);
  }

  /** The window gained or lost the focus. */
  setFocused(focused: boolean): void {
    this.focused = focused;
    if (this.active) focusTab(this.active, focused);
  }

  /** Refits every tab to the terminal area, hidden ones included. */
  resize(): void {
    const { clientWidth, clientHeight } = this.options.screens;
    for (const { tab } of this.entries) resizeTab(tab, clientWidth, clientHeight);
  }

  private activate(tab: Tab): void {
    if (this.active && this.active !== tab) focusTab(this.active, false);
    focusTab(tab, this.focused);
    this.active = tab;
    for (const entry of this.entries) {
      const isActive = entry.tab === tab;
      entry.tab.canvas.hidden = !isActive;
      entry.row.classList.toggle("active", isActive);
    }
    this.options.onActiveChange(tab);
  }

  private retitle(tab: Tab): void {
    const entry = this.entries.find((e) => e.tab === tab);
    if (!entry) return;
    const title = tab.title ?? UNTITLED;
    entry.label.textContent = title;
    entry.short.textContent = shortLabel(title);
    // In the rail the full title is one hover away.
    entry.row.title = title;
    if (tab === this.active) this.options.onActiveChange(tab);
  }

  // Closing the visible tab shows the one that takes its place in the
  // list, or the last one.
  private close(tab: Tab): void {
    const index = this.entries.findIndex((e) => e.tab === tab);
    if (index < 0) return;
    const [entry] = this.entries.splice(index, 1);
    entry.row.remove();
    closeTab(tab);
    if (tab !== this.active) return;

    // The session is gone: there is no focus to take away from it.
    this.active = null;
    const next = this.entries[Math.min(index, this.entries.length - 1)];
    if (next) {
      this.activate(next.tab);
    } else {
      this.options.onActiveChange(null);
    }
  }
}
