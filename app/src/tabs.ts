import { closeForm } from "./form";
import { PIN_ICON, RENAME_ICON } from "./icons";
import { folderName } from "./label";
import { iconMarkup, type Look } from "./look";
import { closeMenu, openMenu } from "./menu";
import { openRename } from "./rename";
import { dropIndex, makeRoom } from "./reorder";
import { createSpace, type Space, type SpaceChanges, stepIndex } from "./space";
import { ACTIVE_AFTER, aged, describe, SHOWN_AFTER, seen, shown } from "./status";
import {
  closeTab,
  defaultTitle,
  focusTab,
  openTab,
  resizeTab,
  runsByItself,
  setTabSpace,
  type Tab,
  type TabHandlers,
  type TabStart,
  titleOf,
  typeCommand,
  UNTITLED,
} from "./tab";
import type { Font, SavedState, SavedTab } from "./types";

/** How far the pointer moves, in pixels, before a press on a row is a drag. */
const DRAG_THRESHOLD = 4;

/** Where the pinned tabs are: no space, but seen from every one. */
const PINNED = "pinned";

/**
 * How long a command to start again by itself waits for the first prompt:
 * a shell without the integration never shows one, and takes it typed.
 */
const READY_TIMEOUT = 3000;

/** Where a tab belongs: a space, none (`null`), or the pinned ones. */
type Place = Space | null | typeof PINNED;

type Entry = {
  tab: Tab;
  space: Place;
  row: HTMLElement;
  icon: HTMLElement;
  label: HTMLElement;
  /** The state of the tab, as a dot: see `status.ts`. */
  dot: HTMLElement;
};

/** How often the time in the tooltips of the dots is brought up to date. */
const TOOLTIP_EVERY = 30_000;

/**
 * What is kept of a tab that closes: what it looked like, the folder it was
 * in, the last command it ran and the one still running, to start again.
 */
type Kept = { look: Look; cwd: string | null; command: string | null; restart: string | null };

/** What is kept of a closed space: its tabs, and which one was shown. */
type Saved = { tabs: Kept[]; shown: number; closedAt: number };

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
  /** Where the rows of the pinned tabs go, under the others. */
  pinned: HTMLElement;
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
 *
 * Pinned tabs belong to no space either, but are there whatever is shown,
 * launcher included, under the tabs of the space. Showing one leaves the
 * space where it is: closing it, or picking a tab of the space, goes back.
 */
export class Tabs {
  private entries: Entry[] = [];
  private spaces: Space[] = [];
  // The space the sidebar shows, `null` for none, and the tab each place
  // was left on.
  private space: Space | null = null;
  private lastTab = new Map<Place, Tab>();
  private closed = new Map<Space, Saved>();
  // The one to resume: closed last, or shown when the app quit.
  private lastClosed: Space | null = null;
  // The pinned tabs of last time while they start again: until then they
  // are what is saved, not the few already open.
  private starting: SavedTab[] | null = null;
  private active: Tab | null = null;
  // Whether the window has the focus: only then the visible tab has it.
  private focused = document.hasFocus();
  // The tab the popover is editing, and the one a menu is open on.
  private renaming: Tab | null = null;
  private inMenu: Tab | null = null;
  // Tabs whose command starts again by itself at the first prompt.
  private waiting = new Map<Tab, string>();
  // The one timer of each tab with a state that changes by itself: a
  // running command whose dot shows, then becomes active.
  private statusTimers = new Map<Tab, number>();
  constructor(private options: TabsOptions) {
    window.setInterval(() => {
      for (const entry of this.entries) this.paintStatus(entry);
      if (this.active) this.options.onActiveChange(this.active);
    }, TOOLTIP_EVERY);
  }

  /** Session id of the visible tab, the one the keyboard writes to. */
  activeId(): number | null {
    return this.active?.id ?? null;
  }

  /**
   * Where the visible tab belongs: its space, `"pinned"`, or `null` for a
   * tab without a space or no tab at all.
   */
  activePlace(): Space | "pinned" | null {
    const place = this.placeOf(this.active);
    return place === undefined ? null : place;
  }

  /** What the tab open in `cwd` is called, if one is: the first found. */
  nameIn(cwd: string): string | null {
    const entry = this.entries.find(({ tab }) => tab.cwd === cwd);
    return entry ? titleOf(entry.tab) : null;
  }

  /** The folders the tabs of the space shown are in. */
  foldersOfSpace(): string[] {
    if (!this.space) return [];
    const folders = this.tabsOf(this.space).flatMap(({ tab }) => (tab.cwd ? [tab.cwd] : []));
    return [...new Set(folders)];
  }

  /** The tab shown, the one the keyboard writes to; `null` with none. */
  activeTab(): Tab | null {
    return this.active;
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
          tabs: tabs.map(toSaved),
        };
      }),
      pinned: this.starting ?? this.tabsOf(PINNED).map(({ tab }) => toSaved(kept(tab))),
    };
  }

  /**
   * Brings back the spaces of `state`, every one of them closed: those that
   * were open when the app quit count as closed then, and the one that was
   * shown is the one to resume. No session of a space starts until it is
   * reopened; the pinned tabs start at once, seen from the launcher.
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
        tabs: saved.tabs.map(fromSaved),
        shown: saved.shown,
        closedAt: saved.closed_at ?? quit,
      });
    });
    const shown = kept.findIndex((saved) => saved.id === state.shown && saved.closed_at === null);
    this.lastClosed = this.spaces[shown] ?? null;
    this.show(null);
    void this.startPinned(state.pinned);
  }

  // Starts the pinned tabs of last time again, each in the folder it was in,
  // in the order they had. One that cannot start is left out.
  private async startPinned(tabs: SavedTab[]): Promise<void> {
    this.starting = tabs;
    for (const tab of tabs.map(fromSaved)) {
      try {
        await this.openIn(PINNED, { cwd: tab.cwd ?? "~", shell: null }, tab);
      } catch {}
    }
    this.starting = null;
    this.changed();
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

  // Opens a tab at the end of `space`, as it was if it is one that was
  // kept. A new tab is shown; one that is coming back only if its space
  // shows nothing yet.
  private async openIn(place: Place, start: TabStart, from: Kept | null): Promise<Tab | null> {
    const { list, pinned, screens, textarea, font } = this.options;
    const handlers: TabHandlers = {
      onTitle: (tab) => this.retitle(tab),
      onCommand: (tab) => this.commandChanged(tab),
      isSeen: (tab) => tab === this.active && this.focused,
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
      place !== PINNED &&
      (place === null
        ? this.space !== null
        : this.closed.has(place) || !this.spaces.includes(place));
    if (tab.exited || gone) {
      closeTab(tab);
      this.leaveIfEmpty(place);
      return null;
    }
    if (from) {
      tab.look = from.look;
      tab.command = from.command;
    }

    const row = document.createElement("div");
    row.className = "tab";
    const mark = document.createElement("span");
    mark.className = "tab-mark";
    const icon = document.createElement("span");
    icon.className = "tab-icon";
    const label = document.createElement("span");
    label.className = "tab-title";
    const dot = document.createElement("span");
    dot.className = "status-dot tab-status";
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
    row.append(mark, icon, label, dot, actions);
    (place === PINNED ? pinned : list).appendChild(row);

    row.addEventListener("click", () => this.activate(tab));
    row.addEventListener("dblclick", () => this.rename(tab));
    row.addEventListener("pointerdown", (e) => this.press(tab, e));
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

    const entry: Entry = { tab, space: place, row, icon, label, dot };
    this.entries.push(entry);
    placed(entry);
    this.paintStatus(entry);
    this.retitle(tab);
    if (place === this.space) {
      if (!from || !this.lastTab.has(place)) this.activate(tab);
    } else if (place !== PINNED) {
      // Its space is not the one shown any more: it waits there.
      row.hidden = true;
      this.lastTab.set(place, tab);
    }
    if (from?.restart) void this.offer(tab, from.restart);
    return tab;
  }

  /** The visible tab offers to start a command again: start it. */
  acceptOffer(): void {
    const tab = this.active;
    if (!tab?.offer) return;
    typeCommand(tab, tab.offer);
    tab.offer = null;
    this.commandChanged(tab);
  }

  /** The visible tab offers to start a command again: leave it at its prompt. */
  dismissOffer(): void {
    const tab = this.active;
    if (!tab?.offer) return;
    tab.offer = null;
    this.commandChanged(tab);
  }

  // `command` was running in `tab` when it closed. As the config file says,
  // it starts again by itself once the shell is ready, or a banner offers it.
  private async offer(tab: Tab, command: string): Promise<void> {
    if (!(await runsByItself(command))) {
      tab.offer = command;
      this.commandChanged(tab);
      return;
    }
    if (tab.ready) {
      typeCommand(tab, command);
      return;
    }
    this.waiting.set(tab, command);
    window.setTimeout(() => this.runWaiting(tab), READY_TIMEOUT);
  }

  // Starts the command `tab` was waiting to start by itself, if any.
  private runWaiting(tab: Tab): void {
    const command = this.waiting.get(tab);
    if (command === undefined) return;
    this.waiting.delete(tab);
    if (!tab.exited) typeCommand(tab, command);
  }

  // A command of `tab` started or ended, or the shell is ready.
  private commandChanged(tab: Tab): void {
    if (tab.ready) this.runWaiting(tab);
    this.scheduleStatus(tab);
    const entry = this.entries.find((e) => e.tab === tab);
    if (entry) this.paintStatus(entry);
    if (tab === this.active) this.options.onActiveChange(tab);
    this.changed();
  }

  // Sets the timer of a running command: its dot shows after a moment, and
  // it becomes active after a while.
  private scheduleStatus(tab: Tab): void {
    window.clearTimeout(this.statusTimers.get(tab));
    this.statusTimers.delete(tab);
    const { status, since } = tab.status;
    if (status !== "running") return;
    const now = Date.now();
    const at = now < since + SHOWN_AFTER ? since + SHOWN_AFTER : since + ACTIVE_AFTER;

    const timer = window.setTimeout(() => {
      this.statusTimers.delete(tab);
      tab.status = aged(tab.status, Date.now());
      this.commandChanged(tab);
    }, at - now);
    this.statusTimers.set(tab, timer);
  }

  // The user looks at `tab`: a command it finished meanwhile has been seen.
  private look(tab: Tab): void {
    const before = tab.status;
    tab.status = seen(before);
    if (tab.status === before) return;
    const entry = this.entries.find((e) => e.tab === tab);
    if (entry) this.paintStatus(entry);
  }

  private paintStatus({ tab, dot }: Entry): void {
    dot.dataset.status = shown(tab.status, Date.now());
    dot.title = describe(tab.status, Date.now());
  }

  /**
   * Shows the tab at `index` among those of the space that is shown, then
   * the pinned ones, as the sidebar lists them.
   */
  select(index: number): void {
    const entry = [...this.tabsOf(this.space), ...this.tabsOf(PINNED)][index];
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
      into.tabs.push(kept(tab));
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
    placed(entry);
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
    if (!this.active) return;
    focusTab(this.active, focused);
    if (focused) {
      this.look(this.active);
      this.options.onActiveChange(this.active);
    }
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
      placed(entry);
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
      tabs: entries.map(({ tab }) => kept(tab)),
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
    for (const tab of saved.tabs) {
      try {
        await this.openIn(space, { cwd: tab.cwd ?? space.folder, shell: space.shell }, tab);
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
  private show(place: Space | null): void {
    if (place !== null && place === this.space) return;
    closeForm();
    closeMenu();
    this.space = place;
    for (const entry of this.entries) {
      entry.row.hidden = entry.space !== place && entry.space !== PINNED;
    }
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
    if (this.focused) this.look(tab);
    this.options.onActiveChange(tab);
    this.changed();
  }

  private retitle(tab: Tab): void {
    const entry = this.entries.find((e) => e.tab === tab);
    if (!entry) return;
    const title = titleOf(tab);
    entry.icon.innerHTML = iconMarkup(tab.look.icon);
    entry.row.style.setProperty("--tab-color", tab.look.color);
    entry.label.textContent = title;
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
        entry.space === PINNED
          ? { label: "Unpin tab", icon: PIN_ICON, onSelect: () => this.unpin(tab) }
          : { label: "Pin tab", icon: PIN_ICON, onSelect: () => void this.pin(tab) },
        // A pinned tab is in no space: it is unpinned into one.
        ...(entry.space === PINNED
          ? []
          : [{ label: "Move to space…", icon: "›", onSelect: () => this.moveMenu(tab) }]),
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

  // Pins `tab`, session alive: it leaves its space, or the tabs without
  // one, and stays in front if it was. The only tab of a space leaves a new
  // one there in its folder: a space with no tab would go away.
  private async pin(tab: Tab): Promise<void> {
    const entry = this.entries.find((e) => e.tab === tab);
    if (!entry || entry.space === PINNED) return;
    const from = entry.space;
    this.relocate(entry, PINNED);
    if (from === null) {
      this.leaveIfEmpty(from);
    } else if (this.tabsOf(from).length === 0) {
      await this.openIn(from, { cwd: from.folder, shell: from.shell }, null);
      if (this.active !== tab && this.placeOf(tab) === PINNED) this.activate(tab);
    }
  }

  // Takes the pin away from `tab`: it goes to the end of the space that is
  // shown, or of the tabs without one if no space is open. Over the
  // launcher it is shown, as a tab without a space always is.
  private unpin(tab: Tab): void {
    const entry = this.entries.find((e) => e.tab === tab);
    if (!entry || entry.space !== PINNED) return;
    this.relocate(entry, this.space);
    if (this.active === null) this.activate(tab);
  }

  // Moves `entry`, session alive, to the end of `target`, whose rows are
  // the ones seen: the space shown, the tabs without one, or the pinned.
  private relocate(entry: Entry, target: Place): void {
    const from = entry.space;
    const index = this.tabsOf(from).indexOf(entry);
    this.entries.splice(this.entries.indexOf(entry), 1);
    this.entries.push(entry);
    entry.space = target;
    placed(entry);
    entry.row.hidden = false;
    (target === PINNED ? this.options.pinned : this.options.list).append(entry.row);
    if (this.lastTab.get(from) === entry.tab) {
      const left = this.tabsOf(from);
      const next = left[Math.min(index, left.length - 1)];
      if (next) this.lastTab.set(from, next.tab);
      else this.lastTab.delete(from);
    }
    if (entry.tab === this.active || !this.lastTab.has(target)) {
      this.lastTab.set(target, entry.tab);
    }
    this.changed();
  }

  private placeOf(tab: Tab | null): Place | undefined {
    return this.entries.find((entry) => entry.tab === tab)?.space;
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

  // A press on the row of `tab`: moved past the threshold, it drags the row
  // among the others of its space, which make room for it; released, the
  // tab takes that place and is shown, as a click would.
  private press(tab: Tab, e: PointerEvent): void {
    if (e.button !== 0 || (e.target as Element).closest(".tab-actions")) return;
    const entry = this.entries.find((x) => x.tab === tab);
    if (!entry) return;
    const { row, space: place } = entry;
    // The list it is in: the tabs of the space, or the pinned ones.
    const box = row.parentElement;
    const rows = this.tabsOf(place).map((x) => x.row);
    if (rows.length < 2) return;
    const from = rows.indexOf(row);
    // Measured once: the rows that make room only move by transforms.
    const boxes = rows.map((r) => r.getBoundingClientRect());
    const centers = boxes.map((box) => box.top + box.height / 2);
    const step = boxes[1].top - boxes[0].top;
    const min = boxes[0].top - boxes[from].top;
    const max = boxes[boxes.length - 1].top - boxes[from].top;
    const start = e.clientY;
    let dragging = false;
    let to = from;

    const move = (m: PointerEvent) => {
      const dy = Math.min(max, Math.max(min, m.clientY - start));
      if (!dragging) {
        if (Math.abs(m.clientY - start) < DRAG_THRESHOLD) return;
        dragging = true;
        closeForm();
        closeMenu();
        box?.classList.add("reordering");
        row.classList.add("dragging");
      }
      row.style.transform = `translateY(${dy}px)`;
      to = dropIndex(centers, from, centers[from] + dy);
      rows.forEach((r, index) => {
        if (index === from) return;
        const shift = makeRoom(index, from, to, step);
        r.style.transform = shift === 0 ? "" : `translateY(${shift}px)`;
      });
    };
    const end = () => {
      row.removeEventListener("pointermove", move);
      row.removeEventListener("pointerup", end);
      row.removeEventListener("pointercancel", end);
      if (!dragging) return;
      // Without the transition first, the rows would slide back from where
      // they already are.
      box?.classList.remove("reordering");
      row.classList.remove("dragging");
      for (const r of rows) r.style.transform = "";
      // A tab that opened or closed meanwhile, or a space that changed,
      // makes the places counted at the start wrong: nothing moves.
      const now = this.tabsOf(place);
      if (entry.space !== place || now.length !== rows.length || !now.includes(entry)) return;
      this.place(entry, to);
      if (place === this.space || place === PINNED) this.activate(tab);
    };
    row.setPointerCapture(e.pointerId);
    row.addEventListener("pointermove", move);
    row.addEventListener("pointerup", end);
    row.addEventListener("pointercancel", end);
  }

  // Puts `entry` at `index` among the tabs of its space, in the list and
  // in the sidebar.
  private place(entry: Entry, index: number): void {
    if (this.tabsOf(entry.space).indexOf(entry) === index) return;
    const others = this.tabsOf(entry.space).filter((x) => x !== entry);
    this.entries.splice(this.entries.indexOf(entry), 1);
    const before = others[index];
    if (before) {
      this.entries.splice(this.entries.indexOf(before), 0, entry);
      before.row.before(entry.row);
    } else {
      const after = others[others.length - 1];
      this.entries.splice(this.entries.indexOf(after) + 1, 0, entry);
      after.row.after(entry.row);
    }
    this.changed();
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
    this.waiting.delete(tab);
    window.clearTimeout(this.statusTimers.get(tab));
    this.statusTimers.delete(tab);
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

    // The session is gone: there is no focus to take away from it. A
    // pinned tab gives way to what it was shown over.
    this.active = null;
    const back = place === PINNED ? this.space : place;
    const next = this.lastTab.get(back) ?? this.tabsOf(back)[0]?.tab;
    if (next) this.activate(next);
    else this.leaveIfEmpty(back);
  }

  // A space with no tab left goes away, and the open one before it is
  // shown; with no open space left, nothing is. A closed space has no tab,
  // but its tabs are saved: it stays. With no space, the last tab without
  // one gone leaves the launcher, unless a pinned tab is in front.
  private leaveIfEmpty(place: Place): void {
    if (place === PINNED || this.tabsOf(place).length > 0) return;
    if (place === null) {
      if (this.space === null && this.placeOf(this.active) !== PINNED) this.show(null);
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

/**
 * What is kept of an open tab. A command offered and not answered yet is
 * still one to start again.
 */
function kept(tab: Tab): Kept {
  return { look: tab.look, cwd: tab.cwd, command: tab.command, restart: tab.restart ?? tab.offer };
}

function toSaved({ look, cwd, command, restart }: Kept): SavedTab {
  return { ...look, cwd, command, restart };
}

// A file from before the commands were kept has none.
function fromSaved({ cwd, command, restart, ...look }: SavedTab): Kept {
  return { look, cwd, command: command ?? null, restart: restart ?? null };
}

// Tells the session of `entry` the space its tab is in now, for the
// commands it records in the history.
function placed({ tab, space }: Entry): void {
  setTabSpace(tab, space === null || space === PINNED ? null : space.id);
}
