import { RENAME_ICON } from "./icons";
import { shortLabel } from "./label";
import { closeMenu, openMenu } from "./menu";
import { closeRename, openRename } from "./rename";
import { closeTab, defaultTitle, focusTab, openTab, resizeTab, type Tab } from "./tab";
import type { Font } from "./types";

/** Shown in the sidebar for a tab with no title and no known folder. */
const UNTITLED = "shell";

// `short` is what is left of the title when the sidebar is a rail.
type Entry = {
  tab: Tab;
  row: HTMLElement;
  icon: HTMLElement;
  label: HTMLElement;
  branch: HTMLElement;
  short: HTMLElement;
};

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
  // The tab the popover is editing, and the one a menu is open on.
  private renaming: Tab | null = null;
  private inMenu: Tab | null = null;

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
    const bar = document.createElement("span");
    bar.className = "tab-bar";
    const icon = document.createElement("span");
    icon.className = "tab-icon";
    const short = document.createElement("span");
    short.className = "tab-short";
    const label = document.createElement("span");
    label.className = "tab-title";
    const branch = document.createElement("span");
    branch.className = "tab-branch";
    const actions = document.createElement("span");
    actions.className = "tab-actions";
    const more = document.createElement("button");
    more.className = "tab-action tab-more";
    more.title = "More…";
    more.textContent = "⋯";
    const close = document.createElement("button");
    close.className = "tab-action tab-close";
    close.title = "Close tab";
    close.textContent = "×";
    actions.append(more, close);
    row.append(bar, icon, short, label, branch, actions);
    list.appendChild(row);

    row.addEventListener("click", () => this.activate(tab));
    row.addEventListener("dblclick", () => this.rename(tab));
    // A double click on a button is two clicks on it, not a rename.
    actions.addEventListener("dblclick", (e) => e.stopPropagation());
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      this.menu(tab);
    });
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close(tab);
    });

    this.entries.push({ tab, row, icon, label, branch, short });
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
    const title = tab.look.name ?? defaultTitle(tab) ?? UNTITLED;
    entry.icon.textContent = tab.look.icon;
    entry.row.style.setProperty("--tab-color", tab.look.color);
    entry.label.textContent = title;
    entry.short.textContent = shortLabel(title);
    entry.branch.textContent = tab.git?.branch ?? "";
    entry.branch.classList.toggle("dirty", tab.git?.dirty ?? false);
    // One hover away: what the program says of itself, and the whole path.
    const branch = tab.git && `${tab.git.branch}${tab.git.dirty ? " (changes to commit)" : ""}`;
    entry.row.title = [title, tab.title, tab.cwd, branch]
      .filter((line) => line !== null)
      .join("\n");
    if (tab === this.active) this.options.onActiveChange(tab);
  }

  // Where popovers open: past the edge of the sidebar, over the terminal.
  private popoverLeft(): number {
    const { list } = this.options;
    return (list.closest("aside") ?? list).getBoundingClientRect().right + 6;
  }

  // Opens the menu of what can be done with `tab`, next to its row.
  private menu(tab: Tab): void {
    const entry = this.entries.find((e) => e.tab === tab);
    if (!entry) return;
    openMenu({
      title: entry.label.textContent ?? "",
      row: entry.row.getBoundingClientRect(),
      left: this.popoverLeft(),
      items: [
        { label: "Rename…", icon: RENAME_ICON, onSelect: () => this.rename(tab) },
        { label: "Close tab", icon: "×", danger: true, onSelect: () => this.close(tab) },
      ],
      onClose: () => {
        this.inMenu = null;
        entry.row.classList.remove("in-menu");
      },
    });
    this.inMenu = tab;
    // The row stays marked while its menu is open, pointer on it or not.
    entry.row.classList.add("in-menu");
  }

  // Opens the popover next to the row of `tab`, on the side of the terminal.
  private rename(tab: Tab): void {
    const entry = this.entries.find((e) => e.tab === tab);
    if (!entry) return;
    const { textarea } = this.options;
    openRename({
      row: entry.row.getBoundingClientRect(),
      left: this.popoverLeft(),
      look: tab.look,
      placeholder: defaultTitle(tab) ?? UNTITLED,
      onSave: (look) => {
        tab.look = look;
        this.retitle(tab);
      },
      onClose: () => {
        this.renaming = null;
        textarea.focus();
      },
    });
    this.renaming = tab;
  }

  // Closing the visible tab shows the one that takes its place in the
  // list, or the last one.
  private close(tab: Tab): void {
    const index = this.entries.findIndex((e) => e.tab === tab);
    if (index < 0) return;
    if (tab === this.renaming) closeRename();
    if (tab === this.inMenu) closeMenu();
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
