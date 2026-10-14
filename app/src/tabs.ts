import { closeForm } from "./form";
import { RENAME_ICON } from "./icons";
import { iconMarkup, type Look } from "./look";
import { closeMenu, openMenu } from "./menu";
import { openRename } from "./rename";
import { createSpace, type Space, type SpaceChanges, stepIndex } from "./space";
import {
  closeTab,
  defaultTitle,
  focusTab,
  openTab,
  resizeTab,
  type Tab,
  type TabHandlers,
  type TabStart,
} from "./tab";
import type { Font, SavedState } from "./types";

/** Shown in the sidebar for a tab with no title and no known folder. */
const UNTITLED = "shell";

type Entry = {
  tab: Tab;
  space: Space;
  row: HTMLElement;
  icon: HTMLElement;
  label: HTMLElement;
  branch: HTMLElement;
};

/**
 * What is kept of a closed space: for each tab what it looked like and the
 * folder it was in, and which one was shown.
 */
type Saved = { tabs: { look: Look; cwd: string | null }[]; shown: number; closedAt: number };

/** A space as the menu lists it. */
export type SpaceInfo = {
  space: Space;
  tabs: number;
  current: boolean;
  /** When it was closed, in milliseconds; `null` if it is open. */
  closedAt: number | null;
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
  /**
   * Another space is shown, the one shown changed, or another one opened or
   * closed. `closable`: there is an open space to show instead of it.
   */
  onSpaceChange(space: Space, closable: boolean): void;
  /** Something worth keeping across a restart changed: see `snapshot`. */
  onChange(): void;
};

/**
 * The open tabs, grouped in spaces: one row each in the sidebar for those
 * of the space that is shown, one canvas each in the terminal area, a
 * single one visible.
 *
 * A tab of a space that is not shown is as alive as the others: its
 * session goes on, and its canvas goes on receiving frames. A closed space
 * has no tab: its sessions are gone, what they looked like is saved.
 */
export class Tabs {
  private entries: Entry[] = [];
  private spaces: Space[] = [createSpace([])];
  // The space the sidebar shows, and the tab each space was left on.
  private space: Space = this.spaces[0];
  private lastTab = new Map<Space, Tab>();
  private closed = new Map<Space, Saved>();
  private active: Tab | null = null;
  // Whether the window has the focus: only then the visible tab has it.
  private focused = document.hasFocus();
  // The tab the popover is editing, and the one a menu is open on.
  private renaming: Tab | null = null;
  private inMenu: Tab | null = null;
  // While the spaces of last time come back, nothing is worth saving yet.
  private restoring = false;

  constructor(private options: TabsOptions) {
    this.announce();
  }

  /** Session id of the visible tab, the one the keyboard writes to. */
  activeId(): number | null {
    return this.active?.id ?? null;
  }

  /** Every space, in the order of their shortcuts. */
  spaceList(): SpaceInfo[] {
    return this.spaces.map((space) => {
      const saved = this.closed.get(space);
      return {
        space,
        tabs: saved ? saved.tabs.length : this.tabsOf(space).length,
        current: space === this.space,
        closedAt: saved?.closedAt ?? null,
      };
    });
  }

  /** Every space and tab as the state file keeps them. */
  snapshot(): SavedState {
    return {
      shown: this.space.id,
      spaces: this.spaces.map((space) => {
        const saved = this.closed.get(space);
        const { tabs, shown } = saved ?? this.keep(space);
        return {
          ...space,
          closed_at: saved?.closedAt ?? null,
          shown,
          tabs: tabs.map(({ look, cwd }) => ({ ...look, cwd })),
        };
      }),
    };
  }

  /**
   * Brings back the spaces of `state`: the open ones with their tabs, each
   * started again in its folder, the closed ones in the menu. `false` if
   * there was no tab to bring back: the app starts with a tab of its own.
   */
  async restore(state: SavedState): Promise<boolean> {
    // An open space with no tab is one the last tab left: it is gone.
    const kept = state.spaces.filter((saved) => saved.closed_at !== null || saved.tabs.length > 0);
    if (kept.length === 0) return false;

    this.restoring = true;
    this.spaces = kept.map(({ id, name, color, folder, shell }) => ({
      id,
      name,
      color,
      folder,
      shell,
    }));
    // Every one starts closed: opening is reopening what was saved.
    kept.forEach((saved, index) => {
      this.closed.set(this.spaces[index], {
        tabs: saved.tabs.map(({ cwd, ...look }) => ({ look, cwd })),
        shown: saved.shown,
        closedAt: saved.closed_at ?? 0,
      });
    });
    const open = this.spaces.filter((_, index) => kept[index].closed_at === null);
    try {
      // The one that was shown first, so that it is the first to be seen.
      const first = open.find((space) => space.id === state.shown) ?? open[0];
      if (first) await this.reopen(first);
      for (const space of open) {
        if (space !== first) await this.reopen(space, false);
      }
    } finally {
      this.restoring = false;
    }

    // Not one of them came back: a space of its own to start in.
    const left = this.openSpaces();
    if (left.length === 0) {
      const space = createSpace(this.spaces);
      this.spaces.push(space);
      this.show(space);
      return false;
    }
    if (!this.active) this.show(left[0]);
    this.announce();
    return true;
  }

  /** Opens a tab at the end of the space that is shown, and shows it. */
  async open(): Promise<void> {
    // The space may change while the session opens: the tab is born here.
    const space = this.space;
    await this.openIn(space, { cwd: space.folder, shell: space.shell }, null);
  }

  // Opens a tab at the end of `space`, with the look it had if it is one
  // that was saved. A new tab is shown; one that is coming back only if
  // its space shows nothing yet.
  private async openIn(space: Space, start: TabStart, look: Look | null): Promise<void> {
    const { list, screens, textarea, font } = this.options;
    const handlers: TabHandlers = {
      onTitle: (tab) => this.retitle(tab),
      onBackground: (tab) => {
        if (tab === this.active) this.options.onActiveChange(tab);
      },
      onExit: (tab) => this.close(tab),
    };
    let tab: Tab;
    try {
      tab = await openTab(screens, textarea, font, start, handlers);
    } catch (error) {
      // A shell that is not installed: the one of the system takes its place.
      if (start.shell === null) throw error;
      tab = await openTab(screens, textarea, font, { ...start, shell: null }, handlers);
    }
    // The shell can die before `session_open` returns, and the space can
    // be closed or deleted meanwhile.
    if (tab.exited || this.closed.has(space) || !this.spaces.includes(space)) {
      closeTab(tab);
      this.leaveIfEmpty(space);
      return;
    }
    if (look) tab.look = look;

    const row = document.createElement("div");
    row.className = "tab";
    const mark = document.createElement("span");
    mark.className = "tab-mark";
    const icon = document.createElement("span");
    icon.className = "tab-icon";
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
    row.append(mark, icon, label, branch, actions);
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

    this.entries.push({ tab, space, row, icon, label, branch });
    this.retitle(tab);
    if (space === this.space) {
      if (!look || !this.lastTab.has(space)) this.activate(tab);
    } else {
      // Its space is not the one shown any more: it waits there.
      row.hidden = true;
      this.lastTab.set(space, tab);
    }
  }

  /** Shows the tab at `index` of the space that is shown, if there is one. */
  select(index: number): void {
    const entry = this.tabsOf(this.space)[index];
    if (entry) this.activate(entry.tab);
  }

  /** Adds a space with one tab in it, and shows it. */
  async newSpace(): Promise<void> {
    const space = createSpace(this.spaces);
    this.spaces.push(space);
    this.show(space);
    await this.open();
  }

  /** Changes the settings of the space that is shown. */
  editSpace(changes: SpaceChanges): void {
    // The tabs it has stay where they are: only new ones see the change.
    Object.assign(this.space, changes);
    this.announce();
  }

  /**
   * Closes the space that is shown, keeping what its tabs looked like and
   * where they were, and shows another one. The sessions end: reopening it
   * starts new ones. With no other open space it stays as it is.
   */
  closeSpace(): void {
    const space = this.space;
    const next = this.neighbour(space);
    if (!next) return;
    const entries = this.tabsOf(space);
    this.closed.set(space, this.keep(space));
    this.show(next);
    for (const { tab } of entries) this.close(tab);
  }

  /** Closes every tab of the space that is shown: the space goes with them. */
  deleteSpace(): void {
    for (const { tab } of this.tabsOf(this.space)) this.close(tab);
  }

  /** Shows the space at `index`, if there is one, reopening it if closed. */
  selectSpace(index: number): void {
    const space = this.spaces[index];
    if (!space) return;
    if (this.closed.has(space)) void this.reopen(space);
    else this.show(space);
  }

  /** Shows the open space `step` places after the one shown, going around. */
  stepSpace(step: number): void {
    const open = this.openSpaces();
    this.show(open[stepIndex(open.indexOf(this.space), open.length, step)]);
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

  private tabsOf(space: Space): Entry[] {
    return this.entries.filter((entry) => entry.space === space);
  }

  private openSpaces(): Space[] {
    return this.spaces.filter((space) => !this.closed.has(space));
  }

  // The open space to show instead of `space`: the one before it, or the
  // one after it if it is the first.
  private neighbour(space: Space): Space | undefined {
    const open = this.openSpaces();
    const index = open.indexOf(space);
    return open[index - 1] ?? open[index + 1];
  }

  // What is kept of an open space when it closes: its tabs as they are now.
  private keep(space: Space): Saved {
    const entries = this.tabsOf(space);
    const last = this.lastTab.get(space);
    return {
      tabs: entries.map(({ tab }) => ({ look: tab.look, cwd: tab.cwd })),
      shown: Math.max(
        0,
        entries.findIndex((entry) => entry.tab === last),
      ),
      closedAt: Date.now(),
    };
  }

  private announce(): void {
    this.options.onSpaceChange(this.space, this.openSpaces().length > 1);
    this.changed();
  }

  private changed(): void {
    if (!this.restoring) this.options.onChange();
  }

  // Opens the tabs of a closed space again, each in the folder it was in
  // and with the look it had, on the one that was shown; `show`: the space
  // is shown while they open.
  private async reopen(space: Space, show = true): Promise<void> {
    const saved = this.closed.get(space);
    if (!saved) return;
    this.closed.delete(space);
    if (show) this.show(space);
    for (const { look, cwd } of saved.tabs) {
      try {
        await this.openIn(space, { cwd: cwd ?? space.folder, shell: space.shell }, look);
      } catch {
        // A tab that cannot start again is left out: the others still can.
      }
    }
    const shown = this.tabsOf(space)[saved.shown]?.tab;
    if (shown && space === this.space) this.activate(shown);
    else if (shown) this.lastTab.set(space, shown);
    // Not one of them started: a space with no tab goes away.
    this.leaveIfEmpty(space);
  }

  // Puts the rows of `space` in the sidebar and shows the tab it was left on.
  private show(space: Space): void {
    if (space === this.space) return;
    closeForm();
    closeMenu();
    this.space = space;
    for (const entry of this.entries) entry.row.hidden = entry.space !== space;
    this.announce();

    const tab = this.lastTab.get(space) ?? this.tabsOf(space)[0]?.tab;
    // A space just made has no tab yet: the one being opened will show.
    if (tab) this.activate(tab);
  }

  private activate(tab: Tab): void {
    if (this.active && this.active !== tab) focusTab(this.active, false);
    focusTab(tab, this.focused);
    this.active = tab;
    for (const entry of this.entries) {
      const isActive = entry.tab === tab;
      entry.tab.canvas.hidden = !isActive;
      entry.row.classList.toggle("active", isActive);
      if (isActive) this.lastTab.set(entry.space, tab);
    }
    this.options.onActiveChange(tab);
    this.changed();
  }

  private retitle(tab: Tab): void {
    const entry = this.entries.find((e) => e.tab === tab);
    if (!entry) return;
    const title = tab.look.name ?? defaultTitle(tab) ?? UNTITLED;
    entry.icon.innerHTML = iconMarkup(tab.look.icon);
    entry.row.style.setProperty("--tab-color", tab.look.color);
    entry.label.textContent = title;
    entry.branch.textContent = tab.git?.branch ?? "";
    entry.branch.classList.toggle("dirty", tab.git?.dirty ?? false);
    // One hover away: what the program says of itself, and the whole path.
    const branch = tab.git && `${tab.git.branch}${tab.git.dirty ? " (changes to commit)" : ""}`;
    entry.row.title = [title, tab.title, tab.cwd, branch]
      .filter((line) => line !== null)
      .join("\n");
    if (tab === this.active) this.options.onActiveChange(tab);
    this.changed();
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
      left: this.popoverLeft(),
      top: entry.row.getBoundingClientRect().top - 6,
      items: [
        { label: "Rename…", icon: RENAME_ICON, onSelect: () => this.rename(tab) },
        {
          label: "Close tab",
          icon: "×",
          danger: true,
          line: true,
          onSelect: () => this.close(tab),
        },
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
      onChange: (look) => {
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
  // list of its space, or the last one.
  private close(tab: Tab): void {
    const entry = this.entries.find((e) => e.tab === tab);
    if (!entry) return;
    const { space } = entry;
    const index = this.tabsOf(space).indexOf(entry);
    if (tab === this.renaming) closeForm();
    if (tab === this.inMenu) closeMenu();
    this.entries.splice(this.entries.indexOf(entry), 1);
    entry.row.remove();
    closeTab(tab);
    this.changed();

    const left = this.tabsOf(space);
    if (this.lastTab.get(space) === tab) {
      const next = left[Math.min(index, left.length - 1)];
      if (next) this.lastTab.set(space, next.tab);
      else this.lastTab.delete(space);
    }
    if (tab !== this.active) {
      this.leaveIfEmpty(space);
      return;
    }

    // The session is gone: there is no focus to take away from it.
    this.active = null;
    const next = this.lastTab.get(space);
    if (next) this.activate(next);
    else this.leaveIfEmpty(space);
  }

  // A space with no tab left goes away, and the open one before it is
  // shown. With no open space left there is nothing to show at all. A
  // closed space has no tab, but its tabs are saved: it stays.
  private leaveIfEmpty(space: Space): void {
    if (this.closed.has(space) || this.tabsOf(space).length > 0) return;
    const index = this.spaces.indexOf(space);
    if (index < 0) return;
    const next = this.neighbour(space);
    // While restoring, the others are still on their way: `restore` sees to
    // a space with no tab being the only one.
    if (!next && !this.restoring) {
      this.options.onActiveChange(null);
      return;
    }

    this.spaces.splice(index, 1);
    this.lastTab.delete(space);
    // The one that was shown is gone: another one takes its place.
    if (space === this.space && next) this.show(next);
    else this.announce();
  }
}
