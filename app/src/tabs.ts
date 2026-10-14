import { closeForm } from "./form";
import { RENAME_ICON } from "./icons";
import { folderName } from "./label";
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

/** Where a tab belongs: a space, or none (`null`). */
type Place = Space | null;

type Entry = {
  tab: Tab;
  space: Place;
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

/** A closed space as the launcher lists it. */
export type ClosedSpace = {
  /** Its position among every space: `selectSpace` takes it. */
  index: number;
  space: Space;
  /** What each of its tabs is called. */
  tabs: string[];
  closedAt: number;
};

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
  /** The active tab, its title or its background changed. `null`: no tab is shown. */
  onActiveChange(tab: Tab | null): void;
  /**
   * Another space is shown, the one shown changed, or another one opened or
   * closed. `null`: no space is open, the launcher takes their place.
   */
  onSpaceChange(space: Space | null): void;
  /** Something worth keeping across a restart changed: see `snapshot`. */
  onChange(): void;
  /**
   * `count` tabs are open without a space and the space called `into` is
   * about to open: whether they come along into it or close. `null`: the
   * user changed their mind, nothing happens.
   */
  ask(count: number, into: string): Promise<"bring" | "close" | null>;
};

/**
 * The open tabs, grouped in spaces: one row each in the sidebar for those
 * of the space that is shown, one canvas each in the terminal area, a
 * single one visible.
 *
 * A tab of a space that is not shown is as alive as the others: its
 * session goes on, and its canvas goes on receiving frames. A closed space
 * has no tab: its sessions are gone, what they looked like is saved.
 *
 * With no space open, tabs belong to no space, as in a plain terminal.
 * They exist only then: opening a space asks whether they come along. With
 * no space and no such tab, nothing is shown: that is the launcher.
 */
export class Tabs {
  private entries: Entry[] = [];
  private spaces: Space[] = [];
  // The space the sidebar shows, `null` for none, and the tab each place
  // was left on.
  private space: Place = null;
  private lastTab = new Map<Place, Tab>();
  private closed = new Map<Space, Saved>();
  // The one to resume: closed last, or shown when the app quit.
  private lastClosed: Space | null = null;
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

  /** How many tabs are open without a space. */
  looseCount(): number {
    return this.tabsOf(null).length;
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

  /** The closed spaces, the one to resume first, then from the latest. */
  closedSpaces(): ClosedSpace[] {
    const list: ClosedSpace[] = [];
    this.spaces.forEach((space, index) => {
      const saved = this.closed.get(space);
      if (!saved) return;
      const tabs = saved.tabs.map(
        ({ look, cwd }) => look.name ?? (cwd === null ? UNTITLED : folderName(cwd)),
      );
      list.push({ index, space, tabs, closedAt: saved.closedAt });
    });
    const rank = (closed: ClosedSpace) =>
      closed.space === this.lastClosed ? Number.POSITIVE_INFINITY : closed.closedAt;
    return list.sort((a, b) => rank(b) - rank(a));
  }

  /** Every space and tab as the state file keeps them. */
  snapshot(): SavedState {
    return {
      shown: this.space?.id ?? null,
      saved_at: Date.now(),
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
   * Brings back the spaces of `state`, every one of them closed: those that
   * were open when the app quit count as closed then, and the one that was
   * shown is the one to resume. No session starts until one is reopened.
   */
  restore(state: SavedState): void {
    const quit = state.saved_at ?? Date.now();
    // An open space with no tab is one the last tab left: it is gone.
    const kept = state.spaces.filter((saved) => saved.closed_at !== null || saved.tabs.length > 0);
    this.spaces = kept.map(({ id, name, color, folder, shell }) => ({
      id,
      name,
      color,
      folder,
      shell,
    }));
    kept.forEach((saved, index) => {
      this.closed.set(this.spaces[index], {
        tabs: saved.tabs.map(({ cwd, ...look }) => ({ look, cwd })),
        shown: saved.shown,
        closedAt: saved.closed_at ?? quit,
      });
    });
    const shown = kept.findIndex((saved) => saved.id === state.shown && saved.closed_at === null);
    this.lastClosed = this.spaces[shown] ?? null;
    this.show(null);
  }

  /**
   * Opens a tab at the end of the space that is shown, and shows it; with
   * no space open, a tab without one, in the home with the shell of the
   * system. `null` if the tab did not last.
   */
  async open(): Promise<Tab | null> {
    // The space may change while the session opens: the tab is born here.
    const place = this.space;
    const start = place ? { cwd: place.folder, shell: place.shell } : { cwd: "~", shell: null };
    return this.openIn(place, start, null);
  }

  // Opens a tab at the end of `space`, with the look it had if it is one
  // that was saved. A new tab is shown; one that is coming back only if
  // its space shows nothing yet.
  private async openIn(place: Place, start: TabStart, look: Look | null): Promise<Tab | null> {
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
    // be closed or deleted meanwhile; a tab without a space is too late
    // once a space is open.
    const gone =
      place === null ? this.space !== null : this.closed.has(place) || !this.spaces.includes(place);
    if (tab.exited || gone) {
      closeTab(tab);
      this.leaveIfEmpty(place);
      return null;
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

    this.entries.push({ tab, space: place, row, icon, label, branch });
    this.retitle(tab);
    if (place === this.space) {
      if (!look || !this.lastTab.has(place)) this.activate(tab);
    } else {
      // Its space is not the one shown any more: it waits there.
      row.hidden = true;
      this.lastTab.set(place, tab);
    }
    return tab;
  }

  /** Shows the tab at `index` of the space that is shown, if there is one. */
  select(index: number): void {
    const entry = this.tabsOf(this.space)[index];
    if (entry) this.activate(entry.tab);
  }

  /**
   * Adds a space and shows it: with the tabs open without a space if the
   * user brings them along, with a tab of its own otherwise.
   */
  async newSpace(): Promise<void> {
    await this.go("new", null);
  }

  /** Makes a new space of the tabs open without a space, without asking. */
  async saveAsSpace(): Promise<void> {
    const loose = this.tabsOf(null).map(({ tab }) => tab);
    if (this.space !== null || loose.length === 0) return;
    await this.gather(this.makeSpace(), loose, this.active ?? loose[0]);
  }

  /** Changes the settings of the space that is shown. */
  editSpace(changes: SpaceChanges): void {
    // The tabs it has stay where they are: only new ones see the change.
    if (!this.space) return;
    Object.assign(this.space, changes);
    this.announce();
  }

  /**
   * Closes the space that is shown, keeping what its tabs looked like and
   * where they were, and shows another one, or the launcher if it was the
   * only one open. The sessions end: reopening it starts new ones.
   */
  closeSpace(): void {
    const space = this.space;
    if (!space) return;
    const next = this.neighbour(space);
    const entries = this.tabsOf(space);
    this.closed.set(space, this.keep(space));
    this.lastClosed = space;
    this.show(next ?? null);
    for (const { tab } of entries) this.close(tab);
  }

  /** Closes every tab of the space that is shown: the space goes with them. */
  deleteSpace(): void {
    if (!this.space) return;
    for (const { tab } of this.tabsOf(this.space)) this.close(tab);
  }

  /** Shows the space at `index`, if there is one, reopening it if closed. */
  async selectSpace(index: number): Promise<void> {
    const space = this.spaces[index];
    if (!space || space === this.space) return;
    await this.go(space, null);
  }

  /**
   * Moves `tab` to the end of `target`. If it was the only tab where it is,
   * the user goes along: the space is shown on it, session alive. If not,
   * the user stays: an open space takes it alive, a closed or new one as a
   * saved tab, whose shell ends and starts again when the space reopens.
   */
  async move(tab: Tab, target: Space | "new"): Promise<void> {
    const entry = this.entries.find((e) => e.tab === tab);
    if (!entry) return;
    const from = entry.space;
    if (this.tabsOf(from).length === 1) {
      await this.go(target, tab);
      return;
    }

    const space = target === "new" ? this.makeSpace() : target;
    const saved = this.closed.get(space);
    if (saved || target === "new") {
      const into = saved ?? { tabs: [], shown: 0, closedAt: Date.now() };
      into.tabs.push({ look: tab.look, cwd: tab.cwd });
      this.closed.set(space, into);
      this.close(tab);
      this.announce();
      return;
    }

    // Open: it goes on running there, out of sight.
    const index = this.tabsOf(from).indexOf(entry);
    const wasActive = tab === this.active;
    this.entries.splice(this.entries.indexOf(entry), 1);
    this.entries.push(entry);
    entry.space = space;
    entry.row.hidden = true;
    this.options.list.append(entry.row);
    if (this.lastTab.get(from) === tab) {
      const left = this.tabsOf(from);
      this.lastTab.set(from, left[Math.min(index, left.length - 1)].tab);
    }
    if (!this.lastTab.has(space)) this.lastTab.set(space, tab);
    const next = this.lastTab.get(from);
    if (wasActive && next) this.activate(next);
    this.announce();
  }

  /** Shows the open space `step` places after the one shown, going around. */
  stepSpace(step: number): void {
    if (!this.space) return;
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

  private tabsOf(place: Place): Entry[] {
    return this.entries.filter((entry) => entry.space === place);
  }

  private makeSpace(): Space {
    const space = createSpace(this.spaces);
    this.spaces.push(space);
    return space;
  }

  // Shows `target`, reopening it if closed or making it if new, with
  // `moving` at the end of its tabs. With tabs open without a space, the
  // user says first whether they come along or close.
  private async go(target: Space | "new", moving: Tab | null): Promise<void> {
    const loose =
      this.space === null ? this.tabsOf(null).filter((entry) => entry.tab !== moving) : [];
    let choice: "bring" | "close" = "close";
    if (loose.length > 0) {
      const into = target === "new" ? "a new space" : target.name;
      const answer = await this.options.ask(loose.length, into);
      if (!answer) return;
      choice = answer;
    }

    const space = target === "new" ? this.makeSpace() : target;
    const brought = this.entries
      .filter((entry) => entry.tab === moving || (choice === "bring" && loose.includes(entry)))
      .map(({ tab }) => tab);
    // The tab moved, or the one that was in front, stays in front.
    const front = moving ?? (this.active && brought.includes(this.active) ? this.active : null);
    if (brought.length > 0) {
      await this.gather(space, brought, front ?? brought[0]);
    } else if (this.closed.has(space)) {
      await this.reopen(space);
    } else {
      this.show(space);
      if (this.tabsOf(space).length === 0) {
        await this.openIn(space, { cwd: space.folder, shell: space.shell }, null);
      }
    }
    if (choice === "close") for (const { tab } of loose) this.close(tab);
  }

  // Puts `tabs`, sessions alive, at the end of `space` in the order they
  // have, and shows it on `front`. A closed space opens first with its own
  // tabs; a space the tabs leave with none goes away.
  private async gather(space: Space, tabs: Tab[], front: Tab): Promise<void> {
    const moved = this.entries.filter((entry) => tabs.includes(entry.tab));
    const from = new Set(moved.map((entry) => entry.space));
    for (const entry of moved) {
      if (this.lastTab.get(entry.space) === entry.tab) this.lastTab.delete(entry.space);
      entry.space = space;
    }
    this.lastTab.set(space, front);
    if (this.closed.has(space)) await this.reopen(space, false);
    else this.show(space);

    // After the tabs of the space, which reopening it has just added.
    for (const entry of moved) {
      const at = this.entries.indexOf(entry);
      if (at < 0) continue;
      this.entries.splice(at, 1);
      this.entries.push(entry);
      this.options.list.append(entry.row);
    }
    if (this.space === space && this.entries.some((entry) => entry.tab === front)) {
      this.activate(front);
    }
    for (const place of from) {
      const first = this.tabsOf(place)[0];
      if (first && !this.lastTab.has(place)) this.lastTab.set(place, first.tab);
      this.leaveIfEmpty(place);
    }
    this.changed();
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
    this.options.onSpaceChange(this.space);
    this.changed();
  }

  private changed(): void {
    this.options.onChange();
  }

  // Shows a closed space and opens its tabs again, each in the folder it
  // was in and with the look it had, on the one that was shown; with
  // `front` false, on the one already in front.
  private async reopen(space: Space, front = true): Promise<void> {
    const saved = this.closed.get(space);
    if (!saved) return;
    this.closed.delete(space);
    this.show(space);
    for (const { look, cwd } of saved.tabs) {
      try {
        await this.openIn(space, { cwd: cwd ?? space.folder, shell: space.shell }, look);
      } catch {
        // A tab that cannot start again is left out: the others still can.
      }
    }
    const shown = front ? this.tabsOf(space)[saved.shown]?.tab : undefined;
    if (shown && space === this.space) this.activate(shown);
    else if (shown) this.lastTab.set(space, shown);
    // Not one of them started: a space with no tab goes away.
    this.leaveIfEmpty(space);
  }

  // Puts the rows of `place` in the sidebar and shows the tab it was left
  // on. With no space and no tab, nothing is shown: the launcher is.
  private show(place: Place): void {
    if (place !== null && place === this.space) return;
    closeForm();
    closeMenu();
    this.space = place;
    for (const entry of this.entries) entry.row.hidden = entry.space !== place;
    this.announce();

    const tab = this.lastTab.get(place) ?? this.tabsOf(place)[0]?.tab;
    if (tab) {
      this.activate(tab);
      return;
    }
    // A space just made has no tab yet: the one being opened will show.
    if (place !== null) return;
    if (this.active) focusTab(this.active, false);
    this.active = null;
    for (const entry of this.entries) entry.tab.canvas.hidden = true;
    this.options.onActiveChange(null);
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
        { label: "Move to space…", icon: "›", onSelect: () => this.moveMenu(tab) },
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

  // The spaces `tab` can go to, where its menu was.
  private moveMenu(tab: Tab): void {
    const entry = this.entries.find((e) => e.tab === tab);
    if (!entry) return;
    const others = this.spaces.filter((space) => space !== entry.space);
    openMenu({
      title: "Move to",
      left: this.popoverLeft(),
      top: entry.row.getBoundingClientRect().top - 6,
      items: [
        ...others.map((space) => ({
          label: space.name,
          // The color is one of the palette, never text typed by someone.
          icon: `<span class="dot" style="background:${space.color}"></span>`,
          meta: this.closed.has(space) ? "closed" : undefined,
          onSelect: () => void this.move(tab, space),
        })),
        {
          label: "New space",
          icon: "+",
          quiet: true,
          line: others.length > 0,
          onSelect: () => void this.move(tab, "new"),
        },
      ],
      onClose: () => {},
    });
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
    const { space: place } = entry;
    const index = this.tabsOf(place).indexOf(entry);
    if (tab === this.renaming) closeForm();
    if (tab === this.inMenu) closeMenu();
    this.entries.splice(this.entries.indexOf(entry), 1);
    entry.row.remove();
    closeTab(tab);
    this.changed();

    const left = this.tabsOf(place);
    if (this.lastTab.get(place) === tab) {
      const next = left[Math.min(index, left.length - 1)];
      if (next) this.lastTab.set(place, next.tab);
      else this.lastTab.delete(place);
    }
    if (tab !== this.active) {
      this.leaveIfEmpty(place);
      return;
    }

    // The session is gone: there is no focus to take away from it.
    this.active = null;
    const next = this.lastTab.get(place);
    if (next) this.activate(next);
    else this.leaveIfEmpty(place);
  }

  // A space with no tab left goes away, and the open one before it is
  // shown; with no open space left, nothing is. A closed space has no tab,
  // but its tabs are saved: it stays. With no space, the last tab without
  // one gone leaves the launcher.
  private leaveIfEmpty(place: Place): void {
    if (this.tabsOf(place).length > 0) return;
    if (place === null) {
      if (this.space === null) this.show(null);
      return;
    }
    if (this.closed.has(place)) return;
    const index = this.spaces.indexOf(place);
    if (index < 0) return;
    const next = this.neighbour(place);
    this.spaces.splice(index, 1);
    this.lastTab.delete(place);
    if (place !== this.space) this.announce();
    else this.show(next ?? null);
  }
}
