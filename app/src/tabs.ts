import { closeForm } from "./form";
import { PIN_ICON, RENAME_ICON } from "./icons";
import { folderName } from "./label";
import {
  boxOf,
  clampRatio,
  type Direction,
  type Divider,
  dividersOf,
  fromSavedLayout,
  type Layout,
  MAX_PANES,
  mapPanes,
  neighbour as paneOn,
  panesOf,
  rectsOf,
  type SavedLayout,
  type Side,
  single,
  split,
  toSavedLayout,
  without,
  withRatio,
} from "./layout";
import { iconMarkup, iconName, type Look, popoverTop } from "./look";
import { closeMenu, openMenu } from "./menu";
import { PREVIEW_LINES, Preview, type PreviewContent } from "./preview";
import { openRename } from "./rename";
import { dropIndex, makeRoom } from "./reorder";
import { createSpace, type Space, type SpaceChanges, stepIndex } from "./space";
import {
  ACTIVE_AFTER,
  aged,
  describe,
  loudest,
  noticeOf,
  SHOWN_AFTER,
  type Status,
  seen,
  shown,
  type TabStatus,
} from "./status";
import {
  backgroundOf,
  closeTab,
  defaultTitle,
  focusTab,
  openTab,
  outputTail,
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

/** The room between two panes side by side, in CSS pixels. */
const PANE_GAP = 8;

/** How wide the band that drags a divider is, over the gap, in CSS pixels. */
const DIVIDER_HIT = 10;

/** How small a pane can be dragged: smaller, a terminal is of no use. */
const MIN_PANE = { width: 160, height: 80 };

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
  close: HTMLButtonElement;
  /** The group of panes it is in; `null`: it is on its own. */
  group: Group | null;
  /** Over its pane, next to others: its name and its state. */
  pill: { name: HTMLElement; status: HTMLElement };
  /** The size of its pane, the one its session was last fitted to. */
  size: { width: number; height: number };
};

/**
 * Tabs shown together, each in a pane: one row in the sidebar, with the
 * rows of its panes under it while it is the one shown. The group is the
 * tab the user sees: it has the name, the color and the icon, and it is
 * what is renamed and moved; its panes are only where its shells run.
 */
type Group = {
  layout: Layout<Tab>;
  /** What it looks like: that of the tab split into it, at first. */
  look: Look;
  /** The pane shown last: the group opens on it. */
  last: Tab;
  /** Its row and the rows of its panes, in the sidebar. */
  box: HTMLElement;
  head: HTMLElement;
  icon: HTMLElement;
  label: HTMLElement;
  count: HTMLElement;
  dot: HTMLElement;
  /** Where the rows of its panes go. */
  panes: HTMLElement;
};

/** What the sidebar lists as one row: a tab on its own, or a group. */
type Unit = { element: HTMLElement; entries: Entry[]; group: Group | null };

/** How often the time in the tooltips of the dots is brought up to date. */
const TOOLTIP_EVERY = 30_000;

/**
 * What is kept of a tab that closes: what it looked like, the folder it was
 * in, the last command it ran and the one still running, to start again.
 */
type Kept = {
  look: Look;
  cwd: string | null;
  command: string | null;
  restart: string | null;
  /** The ids of the saved commands in its header. */
  favorites: number[];
};

/**
 * What is kept of a closed space: its tabs, which one was shown, and its
 * groups of panes, with the positions of their tabs among `tabs`.
 */
type Saved = { tabs: Kept[]; shown: number; closedAt: number; layouts: Layout<number>[] };

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
  /** The state that most wants the eye among its tabs: `ready` when closed. */
  status: Status;
};

/** A command ended in a tab of a space that is not shown, worth knowing. */
export type Notice = {
  tab: Tab;
  space: Space;
  /** What the tab is called, or its group. */
  name: string;
  command: string | null;
  outcome: "done" | "error";
};

export type TabsOptions = {
  /** Where the rows go, in the sidebar. */
  list: HTMLElement;
  /** Where the rows of the pinned tabs go, under the others. */
  pinned: HTMLElement;
  /** Where the panes go; its size is the size of every tab on its own. */
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
  /** A command ended where the user is not: see `Notice`. */
  onNotice(notice: Notice): void;
  /**
   * `count` tabs are open without a space and the space called `into` is
   * about to open: whether they come along into it or close. `null`: the
   * user changed their mind, nothing happens.
   */
  ask(count: number, into: string): Promise<"bring" | "close" | null>;
  /** What was asked cannot be done: `message` says why. */
  refuse(message: string): void;
};

/**
 * The open tabs, grouped in spaces: one row each in the sidebar for those
 * of the space that is shown, one pane each in the terminal area.
 *
 * A tab is shown on its own, over the whole area, or with the others of
 * its group, each in a pane: splitting a tab makes a group of it and a new
 * tab. A group has one row in the sidebar, and the rows of its panes
 * under it while it is shown. Its tabs are next to each other among those
 * of their space, in the order of their panes.
 *
 * A tab of a space that is not shown is as alive as the others: its
 * session goes on, and its canvas goes on receiving frames. A closed space
 * has no tab: its sessions are gone, what they looked like is saved, and
 * so are its groups.
 *
 * With no space open, tabs belong to no space, as in a plain terminal.
 * They exist only then: opening a space asks whether they come along. With
 * no space and no such tab, nothing is shown: that is the launcher.
 *
 * Pinned tabs belong to no space either, but are there whatever is shown,
 * launcher included, under the tabs of the space. Showing one leaves the
 * space where it is: closing it, or picking a tab of the space, goes back.
 * They are always on their own.
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
  // The tab or group the popover is editing, and the one a menu is open on.
  private renaming: Tab | Group | null = null;
  private inMenu: Tab | Group | null = null;
  // Tabs whose command starts again by itself at the first prompt.
  private waiting = new Map<Tab, string>();
  // The one timer of each tab with a state that changes by itself: a
  // running command whose dot shows, then becomes active.
  private statusTimers = new Map<Tab, number>();
  // The dividers of the group on screen, over its panes, and whether one
  // is being dragged: that one then moves on its own, and stays the same.
  private dividers: HTMLElement[] = [];
  private resizing = false;
  // The card of the row the pointer rests on.
  private preview = new Preview<Tab>({
    content: (tab) => this.previewOf(tab),
    place: (row, height) => ({
      left: this.popoverLeft(),
      top: popoverTop(row.getBoundingClientRect().top, height, window.innerHeight),
    }),
  });
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

  /** The header of `tab` now has the saved commands `ids`, in this order. */
  setFavorites(tab: Tab, ids: number[]): void {
    tab.favorites = ids;
    if (tab === this.active) this.options.onActiveChange(tab);
    this.changed();
  }

  /** Only the saved commands `ids` are still there: the others leave every header. */
  keepFavorites(ids: Set<number>): void {
    let gone = false;
    const keep = (list: number[]) => {
      const left = list.filter((id) => ids.has(id));
      gone ||= left.length !== list.length;
      return left;
    };
    for (const { tab } of this.entries) tab.favorites = keep(tab.favorites);
    for (const saved of this.closed.values()) {
      for (const kept of saved.tabs) kept.favorites = keep(kept.favorites);
    }
    if (gone) this.changed();
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
        status: saved
          ? "ready"
          : loudest(this.tabsOf(space).map(({ tab }) => shown(tab.status, Date.now()))),
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
        const { tabs, shown, layouts } = saved ?? this.keep(space);
        return {
          ...space,
          closed_at: saved?.closedAt ?? null,
          shown,
          tabs: tabs.map(toSaved),
          layouts: layouts.map((layout) => toSavedLayout(layout, (index) => index)),
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
        layouts: readLayouts(saved.layouts ?? [], saved.tabs.length),
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

  /**
   * Splits the pane of the visible tab in two: a new tab, in the folder it
   * is in, on its right in a row or under it in a column, and shown. A
   * pinned tab is not split, nor a group that has all the panes it can.
   * `null` if no tab opened.
   */
  async split(direction: Direction): Promise<Tab | null> {
    const tab = this.active;
    const entry = tab && this.entryOf(tab);
    if (!tab || !entry) return null;
    const place = entry.space;
    if (place === PINNED) {
      this.options.refuse("A pinned tab cannot be split");
      return null;
    }
    if (this.paneCount(entry) >= MAX_PANES) {
      this.options.refuse(`A tab can have up to ${MAX_PANES} panes`);
      return null;
    }
    const start = {
      cwd: tab.cwd ?? (place === null ? "~" : place.folder),
      shell: place === null ? null : place.shell,
    };
    return this.openIn(place, start, null, { tab, direction });
  }

  /** Shows the pane on `side` of the visible one, in its group, if there is one. */
  focusPane(side: Side): void {
    const entry = this.active && this.entryOf(this.active);
    if (!entry?.group) return;
    const next = paneOn(entry.group.layout, entry.tab, side);
    if (next) this.activate(next);
  }

  // How many panes the group of `entry` has: one if it is on its own.
  private paneCount(entry: Entry): number {
    return entry.group ? panesOf(entry.group.layout).length : 1;
  }

  // Opens a tab at the end of `space`, as it was if it is one that was
  // kept. A new tab is shown; one that is coming back only if its space
  // shows nothing yet. With `beside`, it is a new pane next to that tab.
  private async openIn(
    place: Place,
    start: TabStart,
    from: Kept | null,
    beside: { tab: Tab; direction: Direction } | null = null,
  ): Promise<Tab | null> {
    const { list, pinned, screens, textarea, font } = this.options;
    const handlers: TabHandlers = {
      onTitle: (tab) => this.retitle(tab),
      onCommand: (tab) => this.commandChanged(tab),
      onEnd: (tab, before) => this.commandEnded(tab, before),
      isSeen: (tab) => tab === this.active && this.focused,
      isActive: (tab) => tab === this.active,
      onBackground: (tab) => {
        tab.pane.style.setProperty("--pane-bg", backgroundOf(tab));
        if (tab === this.active) this.options.onActiveChange(tab);
      },
      onFrame: (tab) => this.preview.changed(tab),
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
      tab.favorites = from.favorites;
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
    const more = button("tab-action tab-more", "More…", "⋯");
    const close = button("tab-action tab-close", "Close tab", "×");
    actions.append(more, close);
    row.append(mark, icon, label, dot, actions);
    (place === PINNED ? pinned : list).appendChild(row);

    row.addEventListener("click", () => this.activate(tab));
    // A pane is renamed with its group.
    row.addEventListener("dblclick", () => {
      if (!this.entryOf(tab)?.group) this.rename(tab);
    });
    row.addEventListener("pointerdown", (e) => {
      this.preview.leave();
      // The panes of a group move with it: its own row is the one to drag.
      if (!this.entryOf(tab)?.group) this.press(row, e);
    });
    // The card says what a tab out of sight is doing: one on screen says it
    // already, and a row being edited has a popover of its own.
    row.addEventListener("pointerenter", () => {
      if (!this.onScreen(tab) && !this.renaming && !this.inMenu) this.preview.hover(tab, row);
    });
    row.addEventListener("pointerleave", () => this.preview.leave());
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

    // Next to others, the pane says whose it is when the pointer is on it.
    const pill = document.createElement("div");
    pill.className = "pane-label";
    const pillName = document.createElement("b");
    const pillStatus = document.createElement("span");
    pillStatus.className = "pane-status";
    const pillClose = button("pane-close", "Close pane", "×");
    pill.append(pillName, pillStatus, pillClose);
    tab.pane.append(pill);
    pill.addEventListener("mousedown", (e) => e.preventDefault());
    pillClose.addEventListener("click", () => this.close(tab));
    // A press anywhere on a pane makes it the one the keys go to, before
    // the mouse does anything else there.
    tab.pane.addEventListener(
      "pointerdown",
      () => {
        if (tab !== this.active && this.entryOf(tab)) this.activate(tab);
      },
      { capture: true },
    );

    const entry: Entry = {
      tab,
      space: place,
      row,
      icon,
      label,
      dot,
      close,
      group: null,
      pill: { name: pillName, status: pillStatus },
      size: { width: screens.clientWidth, height: screens.clientHeight },
    };
    this.entries.push(entry);
    placed(entry);
    // The tab split may have closed meanwhile, or gone elsewhere, or its
    // group filled up: the new one is then a tab on its own.
    const base = beside && this.entryOf(beside.tab);
    if (beside && base && base.space === place && this.paneCount(base) < MAX_PANES) {
      this.join(entry, base, beside.direction);
    }
    this.paintStatus(entry);
    this.retitle(tab);
    if (place === this.space) {
      if (!from || !this.lastTab.has(place)) this.activate(tab);
      else this.arrange();
    } else {
      // Its space is not the one shown any more: it waits there.
      if (place !== PINNED) {
        this.unitOf(entry).hidden = true;
        this.lastTab.set(place, tab);
      }
      this.arrange();
    }
    if (from?.restart) void this.offer(tab, from.restart);
    return tab;
  }

  // Puts the new `entry` in a pane next to the one of `base`, after it.
  private join(entry: Entry, base: Entry, direction: Direction): void {
    if (base.group) {
      base.group.layout = split(base.group.layout, base.tab, direction, entry.tab);
      entry.group = base.group;
      this.settle(base.group);
    } else {
      this.makeGroup(split(single(base.tab), base.tab, direction, entry.tab), base.tab.look);
    }
    this.changed();
  }

  // Makes a group that looks like `look` of the tabs of `layout`, where
  // the first of them is in the sidebar. None with fewer than two of them
  // still open.
  private makeGroup(layout: Layout<Tab>, look: Look): void {
    const entries = panesOf(layout)
      .map((tab) => this.entryOf(tab))
      .filter((entry) => entry !== undefined);
    if (entries.length < 2 || entries.some((entry) => entry.group)) return;

    const box = document.createElement("div");
    box.className = "group";
    const head = document.createElement("div");
    head.className = "tab group-head";
    const mark = document.createElement("span");
    mark.className = "tab-mark";
    const icon = document.createElement("span");
    icon.className = "tab-icon";
    const label = document.createElement("span");
    label.className = "tab-title";
    const count = document.createElement("span");
    count.className = "group-count";
    const dot = document.createElement("span");
    dot.className = "status-dot tab-status";
    const actions = document.createElement("span");
    actions.className = "tab-actions";
    const more = button("tab-action tab-more", "More…", "⋯");
    const close = button("tab-action tab-close", "Close tab", "×");
    actions.append(more, close);
    head.append(mark, icon, label, count, dot, actions);
    const panes = document.createElement("div");
    panes.className = "group-panes";
    box.append(head, panes);
    box.hidden = entries[0].row.hidden;
    entries[0].row.before(box);

    const group: Group = {
      layout,
      look,
      last: entries[0].tab,
      box,
      head,
      icon,
      label,
      count,
      dot,
      panes,
    };
    for (const entry of entries) entry.group = group;

    head.addEventListener("click", () => this.activate(group.last));
    head.addEventListener("dblclick", () => this.renameGroup(group));
    actions.addEventListener("dblclick", (e) => e.stopPropagation());
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      this.groupMenu(group);
    });
    head.addEventListener("pointerdown", (e) => {
      this.preview.leave();
      this.press(box, e);
    });
    head.addEventListener("pointerenter", () => {
      if (!this.onScreen(group.last) && !this.renaming && !this.inMenu) {
        this.preview.hover(group.last, head);
      }
    });
    head.addEventListener("pointerleave", () => this.preview.leave());
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeGroup(group);
    });
    this.settle(group);
  }

  // Closes every pane of `group`, the one in front last: the others leave
  // no gap to fill meanwhile.
  private closeGroup(group: Group): void {
    const tabs = panesOf(group.layout).sort(
      (a, b) => Number(a === this.active) - Number(b === this.active),
    );
    for (const tab of tabs) this.close(tab);
  }

  /** What `tab` is called where the user sees it: the name of its group, if in one. */
  nameOf(tab: Tab): string {
    const group = this.entryOf(tab)?.group;
    return group ? groupTitle(group) : titleOf(tab);
  }

  // After its layout changed: the tabs of `group` next to each other, in
  // the order of their panes, among the others and in the sidebar.
  private settle(group: Group): void {
    const tabs = panesOf(group.layout);
    const entries = tabs.map((tab) => this.entryOf(tab)).filter((entry) => entry !== undefined);
    const first = Math.min(...entries.map((entry) => this.entries.indexOf(entry)));
    this.entries = this.entries.filter((entry) => !entries.includes(entry));
    this.entries.splice(first, 0, ...entries);
    for (const entry of entries) {
      entry.row.classList.add("pane-row");
      entry.row.hidden = false;
      group.panes.append(entry.row);
      this.paintRow(entry);
    }
    if (!tabs.includes(group.last)) group.last = tabs[0];
    this.paintGroup(group);
  }

  // Takes `entry` out of its group, its row after the one of the group. A
  // group left with one tab is no more: that tab is on its own, where the
  // group was, and looks as the group did.
  private detach(entry: Entry): void {
    const group = entry.group;
    if (!group) return;
    entry.group = null;
    entry.row.classList.remove("pane-row");
    entry.row.hidden = group.box.hidden;
    group.box.after(entry.row);
    this.paintRow(entry);
    const layout = without(group.layout, entry.tab);
    if (layout && layout.type === "split") {
      group.layout = layout;
      this.settle(group);
    } else {
      for (const other of this.entries) {
        if (other.group !== group) continue;
        other.group = null;
        other.tab.look = group.look;
        other.row.classList.remove("pane-row");
        other.row.hidden = group.box.hidden;
        group.box.replaceWith(other.row);
        this.paintRow(other);
      }
      group.box.remove();
    }
    this.changed();
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
    const entry = this.entryOf(tab);
    if (entry) {
      this.paintStatus(entry);
      if (entry.group) this.paintRow(entry);
    }
    if (tab === this.active) this.options.onActiveChange(tab);
    this.changed();
    this.preview.changed(tab);
  }

  // A command of `tab` ended: worth a notice if it ran in a space that is
  // not shown, where its dot cannot be seen.
  private commandEnded(tab: Tab, before: TabStatus): void {
    const place = this.placeOf(tab);
    if (!place || place === PINNED || place === this.space) return;
    const outcome = noticeOf(before, tab.status, Date.now());
    if (!outcome) return;
    this.options.onNotice({
      tab,
      space: place,
      name: this.nameOf(tab),
      command: tab.command,
      outcome,
    });
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
    const entry = this.entryOf(tab);
    if (entry) this.paintStatus(entry);
  }

  private paintStatus(entry: Entry): void {
    const { tab, dot, pill } = entry;
    const now = Date.now();
    dot.dataset.status = shown(tab.status, now);
    dot.title = describe(tab.status, now);
    pill.status.textContent = describe(tab.status, now);
    pill.status.dataset.status = shown(tab.status, now);
    if (entry.group) this.paintGroup(entry.group);
  }

  // The row of `group`: its name and icon, how many panes it has, and the
  // state that most wants the eye among theirs.
  private paintGroup(group: Group): void {
    const tabs = panesOf(group.layout);
    const now = Date.now();
    group.icon.innerHTML = iconMarkup(group.look.icon);
    group.head.style.setProperty("--tab-color", group.look.color);
    group.label.textContent = groupTitle(group);
    group.count.textContent = String(tabs.length);
    group.count.title = `${tabs.length} panes`;
    group.dot.dataset.status = loudest(tabs.map((tab) => shown(tab.status, now)));
    group.head.title = tabs.map(paneText).join("\n");
  }

  // The row of `entry` and the label of its pane: a tab on its own shows
  // its name and icon, a pane only where it works and what it ran.
  private paintRow(entry: Entry): void {
    const { tab } = entry;
    const text = entry.group ? paneText(tab) : titleOf(tab);
    entry.icon.innerHTML = iconMarkup(tab.look.icon);
    entry.row.style.setProperty("--tab-color", tab.look.color);
    entry.label.textContent = text;
    entry.pill.name.textContent = entry.group ? (defaultTitle(tab) ?? UNTITLED) : text;
    entry.close.title = entry.group ? "Close pane" : "Close tab";
  }

  /**
   * Shows the tab at `index` among those of the space that is shown, then
   * the pinned ones, as the sidebar lists them: a group counts as one.
   */
  select(index: number): void {
    const unit = [...this.unitsOf(this.space), ...this.unitsOf(PINNED)][index];
    if (unit) this.activate(unit.group?.last ?? unit.entries[0].tab);
  }

  /**
   * Adds a space and shows it: with the tabs open without a space if the
   * user brings them along, with a tab of its own otherwise.
   */
  async newSpace(): Promise<void> {
    await this.go("new", []);
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
  /**
   * Shows `tab`, opening its space first if it is another one. `false` if
   * the tab is not open any more; `true` also when the user changed their
   * mind about the tabs without a space, and stayed.
   */
  async reveal(tab: Tab): Promise<boolean> {
    const place = this.placeOf(tab);
    if (place === undefined) return false;
    if (place !== PINNED && place !== this.space && place !== null) await this.go(place, []);
    const now = this.placeOf(tab);
    if (now === PINNED || (now !== undefined && now === this.space)) this.activate(tab);
    return now !== undefined;
  }

  async selectSpace(index: number): Promise<void> {
    const space = this.spaces[index];
    if (!space || space === this.space) return;
    await this.go(space, []);
  }

  /**
   * Moves `tab` to the end of `target`, with the other panes of its group
   * if it is in one. If it was the only one where it is, the user goes
   * along: the space is shown on it, sessions alive. If not, the user
   * stays: an open space takes it alive, a closed or new one as saved tabs,
   * whose shells end and start again when the space reopens.
   */
  async move(tab: Tab, target: Space | "new"): Promise<void> {
    const entry = this.entryOf(tab);
    if (!entry) return;
    const group = entry.group;
    const tabs = group ? panesOf(group.layout) : [tab];
    const from = entry.space;
    const units = this.unitsOf(from);
    if (units.length === 1) {
      await this.go(target, tabs);
      return;
    }

    const space = target === "new" ? this.makeSpace() : target;
    const saved = this.closed.get(space);
    if (saved || target === "new") {
      const into = saved ?? { tabs: [], shown: 0, closedAt: Date.now(), layouts: [] };
      const offset = into.tabs.length;
      for (const moved of tabs) {
        const movedEntry = this.entryOf(moved);
        if (movedEntry) into.tabs.push(keptOf(movedEntry));
      }
      if (group) into.layouts.push(mapPanes(group.layout, (t) => offset + tabs.indexOf(t)));
      this.closed.set(space, into);
      if (group) this.closeGroup(group);
      else this.close(tab);
      this.announce();
      return;
    }

    // Open: it goes on running there, out of sight.
    const element = this.unitOf(entry);
    const index = units.findIndex((unit) => unit.element === element);
    const moved = this.entries.filter((e) => tabs.includes(e.tab));
    const wasActive = moved.some((e) => e.tab === this.active);
    this.entries = this.entries.filter((e) => !moved.includes(e));
    this.entries.push(...moved);
    for (const e of moved) {
      e.space = space;
      placed(e);
    }
    element.hidden = true;
    this.options.list.append(element);
    const last = this.lastTab.get(from);
    if (last && tabs.includes(last)) {
      const left = this.unitsOf(from);
      const unit = left[Math.min(index, left.length - 1)];
      this.lastTab.set(from, unit.group?.last ?? unit.entries[0].tab);
    }
    if (!this.lastTab.has(space)) this.lastTab.set(space, group?.last ?? tab);
    const next = this.lastTab.get(from);
    if (wasActive && next) this.activate(next);
    else this.arrange();
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
    if (!focused) this.preview.leave();
    if (!this.active) return;
    focusTab(this.active, focused);
    if (focused) {
      this.look(this.active);
      this.options.onActiveChange(this.active);
    }
  }

  /** Refits every tab to the terminal area, hidden ones included. */
  resize(): void {
    this.arrange();
  }

  private tabsOf(place: Place): Entry[] {
    return this.entries.filter((entry) => entry.space === place);
  }

  private entryOf(tab: Tab | null): Entry | undefined {
    return this.entries.find((entry) => entry.tab === tab);
  }

  // What the sidebar has of `entry` among the rows of its place: its own
  // row, or the box of its group.
  private unitOf(entry: Entry): HTMLElement {
    return entry.group?.box ?? entry.row;
  }

  // The rows of `place` as the sidebar lists them: a group is one.
  private unitsOf(place: Place): Unit[] {
    const units: Unit[] = [];
    for (const entry of this.tabsOf(place)) {
      const last = units[units.length - 1];
      if (entry.group && last?.group === entry.group) last.entries.push(entry);
      else units.push({ element: this.unitOf(entry), entries: [entry], group: entry.group });
    }
    return units;
  }

  // The other tabs of the group of `entry`, from the one after it: the
  // first takes its place on screen when it goes.
  private matesOf(entry: Entry): Tab[] {
    if (!entry.group) return [];
    const tabs = panesOf(entry.group.layout);
    const at = tabs.indexOf(entry.tab);
    return [...tabs.slice(at + 1), ...tabs.slice(0, at).reverse()];
  }

  // Whether `tab` is on screen: the one shown, or a pane next to it.
  private onScreen(tab: Tab): boolean {
    if (tab === this.active) return true;
    const group = this.entryOf(this.active)?.group;
    return group !== undefined && group !== null && this.entryOf(tab)?.group === group;
  }

  private makeSpace(): Space {
    const space = createSpace(this.spaces);
    this.spaces.push(space);
    return space;
  }

  // Shows `target`, reopening it if closed or making it if new, with
  // `moving`, a tab or the panes of a group, at the end of its tabs. With
  // tabs open without a space, the user says first whether they come
  // along or close.
  private async go(target: Space | "new", moving: Tab[]): Promise<void> {
    const loose =
      this.space === null ? this.tabsOf(null).filter((entry) => !moving.includes(entry.tab)) : [];
    let choice: "bring" | "close" = "close";
    if (loose.length > 0) {
      const into = target === "new" ? "a new space" : target.name;
      const answer = await this.options.ask(loose.length, into);
      if (!answer) return;
      choice = answer;
    }

    const space = target === "new" ? this.makeSpace() : target;
    const brought = this.entries
      .filter(
        (entry) => moving.includes(entry.tab) || (choice === "bring" && loose.includes(entry)),
      )
      .map(({ tab }) => tab);
    // What was moved, or the tab that was in front, stays in front.
    const shownBefore = this.active && brought.includes(this.active) ? this.active : null;
    const front =
      (this.active && moving.includes(this.active) ? this.active : moving[0]) ?? shownBefore;
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
  // tabs; a space the tabs leave with none goes away. A group comes whole,
  // or the tabs that come leave it.
  private async gather(space: Space, tabs: Tab[], front: Tab): Promise<void> {
    const moved = this.entries.filter((entry) => tabs.includes(entry.tab));
    for (const entry of moved) {
      if (entry.group && !panesOf(entry.group.layout).every((tab) => tabs.includes(tab))) {
        this.detach(entry);
      }
    }
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
      this.options.list.append(this.unitOf(entry));
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

  // What is kept of an open space when it closes: its tabs as they are now,
  // and its groups, whose look goes with their first tab.
  private keep(space: Space): Saved {
    const entries = this.tabsOf(space);
    const last = this.lastTab.get(space);
    const groups = new Set(entries.map((entry) => entry.group).filter((group) => group !== null));
    const position = (tab: Tab) => entries.findIndex((entry) => entry.tab === tab);
    return {
      tabs: entries.map(keptOf),
      shown: Math.max(
        0,
        entries.findIndex((entry) => entry.tab === last),
      ),
      closedAt: Date.now(),
      layouts: [...groups].map((group) => mapPanes(group.layout, position)),
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
  // was in and with the look it had, in the groups they were in, on the
  // one that was shown; with `front` false, on the one already in front.
  private async reopen(space: Space, front = true): Promise<void> {
    const saved = this.closed.get(space);
    if (!saved) return;
    this.closed.delete(space);
    this.show(space);
    const opened: (Tab | null)[] = [];
    for (const tab of saved.tabs) {
      try {
        opened.push(
          await this.openIn(space, { cwd: tab.cwd ?? space.folder, shell: space.shell }, tab),
        );
      } catch {
        // A tab that cannot start again is left out: the others still can.
        opened.push(null);
      }
    }
    for (const layout of saved.layouts) {
      // A tab that did not start leaves its room to the others.
      const tabs = without<Tab | null>(
        mapPanes(layout, (index) => opened[index] ?? null),
        null,
      ) as Layout<Tab> | null;
      if (tabs?.type === "split" && panesOf(tabs).every((tab) => this.placeOf(tab) === space)) {
        this.makeGroup(tabs, panesOf(tabs)[0].look);
      }
    }
    const shown = front ? (opened[saved.shown] ?? undefined) : undefined;
    if (shown && this.placeOf(shown) !== space) {
      // Closed meanwhile: whatever is in front stays.
    } else if (shown && space === this.space) this.activate(shown);
    else if (shown) this.lastTab.set(space, shown);
    else this.arrange();
    // Not one of them started: a space with no tab goes away.
    this.leaveIfEmpty(space);
  }

  // Puts the rows of `place` in the sidebar and shows the tab it was left
  // on. With no space and no tab, nothing is shown: the launcher is.
  private show(place: Space | null): void {
    if (place !== null && place === this.space) return;
    closeForm();
    closeMenu();
    this.preview.leave();
    this.space = place;
    for (const entry of this.entries) {
      this.unitOf(entry).hidden = entry.space !== place && entry.space !== PINNED;
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
    this.arrange();
    this.options.onActiveChange(null);
  }

  private activate(tab: Tab): void {
    if (this.active && this.active !== tab) focusTab(this.active, false);
    focusTab(tab, this.focused);
    this.active = tab;
    this.preview.forget(tab);
    const group = this.entryOf(tab)?.group ?? null;
    if (group) group.last = tab;
    for (const entry of this.entries) {
      const isActive = entry.tab === tab;
      entry.row.classList.toggle("active", isActive);
      entry.row.title = isActive ? tooltipOf(entry.tab) : "";
      if (isActive) this.lastTab.set(entry.space, tab);
      if (entry.group) {
        entry.group.box.classList.toggle("current", entry.group === group);
        entry.group.head.classList.toggle("active", entry.group === group);
      }
    }
    this.arrange();
    if (this.focused) this.look(tab);
    this.options.onActiveChange(tab);
    this.changed();
  }

  // Puts every pane where it goes: those of the group of the tab shown next
  // to each other, any other over the whole area, which it takes when it is
  // shown. Only those on screen are seen, but every one keeps the size it
  // will have then: a session is resized only when that size changes.
  private arrange(): void {
    const { screens } = this.options;
    const width = screens.clientWidth;
    const height = screens.clientHeight;
    const group = this.entryOf(this.active)?.group ?? null;
    screens.classList.toggle("split", group !== null);
    const boxes = new Map<Tab, ReturnType<typeof boxOf>>();
    for (const { group: of } of this.entries) {
      if (!of || boxes.has(of.last)) continue;
      for (const { item, rect } of rectsOf(of.layout)) {
        boxes.set(item, boxOf(rect, width, height, PANE_GAP));
      }
    }
    const whole = { left: 0, top: 0, width, height };
    for (const entry of this.entries) {
      const { tab } = entry;
      const box = (entry.group && boxes.get(tab)) || whole;
      tab.pane.hidden = !(tab === this.active || (group !== null && entry.group === group));
      tab.pane.classList.toggle("active", tab === this.active);
      tab.pane.style.left = `${box.left}px`;
      tab.pane.style.top = `${box.top}px`;
      tab.pane.style.width = `${box.width}px`;
      tab.pane.style.height = `${box.height}px`;
      if (box.width !== entry.size.width || box.height !== entry.size.height) {
        entry.size = { width: box.width, height: box.height };
        resizeTab(tab, box.width, box.height);
      }
    }
    if (!this.resizing) this.placeDividers(group, width, height);
  }

  // Puts a divider over each line between the halves of a split of
  // `group`, in an area of `width` x `height`; none without a group.
  private placeDividers(group: Group | null, width: number, height: number): void {
    for (const element of this.dividers) element.remove();
    this.dividers = [];
    if (!group) return;
    for (const divider of dividersOf(group.layout)) {
      const element = document.createElement("div");
      element.className = `divider ${divider.direction}`;
      element.title = "Drag to resize · double-click for half and half";
      placeDivider(element, divider, width, height);
      // The keys stay in the terminal.
      element.addEventListener("mousedown", (e) => e.preventDefault());
      element.addEventListener("pointerdown", (e) => this.dragDivider(group, divider, element, e));
      element.addEventListener("dblclick", () => this.setRatio(group, divider, 0.5, true));
      this.options.screens.append(element);
      this.dividers.push(element);
    }
  }

  // A press on the divider of a split of `group`: dragged, its halves
  // follow the pointer, a frame at a time, each keeping its minimum. The
  // ratio is kept on release.
  private dragDivider(group: Group, divider: Divider, element: HTMLElement, e: PointerEvent): void {
    if (e.button !== 0) return;
    const { screens } = this.options;
    const bounds = screens.getBoundingClientRect();
    const row = divider.direction === "row";
    const start = row ? divider.rect.x * bounds.width : divider.rect.y * bounds.height;
    const size = row ? divider.rect.w * bounds.width : divider.rect.h * bounds.height;
    const min = row ? MIN_PANE.width : MIN_PANE.height;
    let ratio = divider.ratio;
    let moved = false;
    let frame = 0;
    this.resizing = true;
    element.classList.add("dragging");
    document.body.classList.add(row ? "resizing-row" : "resizing-column");

    const move = (m: PointerEvent) => {
      const at = (row ? m.clientX - bounds.left : m.clientY - bounds.top) - start;
      ratio = clampRatio(at / size, size, min);
      moved = true;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        this.setRatio(group, divider, ratio, false);
        placeDivider(element, { ...divider, ratio }, bounds.width, bounds.height);
      });
    };
    const end = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
      cancelAnimationFrame(frame);
      this.resizing = false;
      element.classList.remove("dragging");
      document.body.classList.remove("resizing-row", "resizing-column");
      // A press without a move leaves the divider where it is, for a
      // double click to find it there.
      if (moved) this.setRatio(group, divider, ratio, true);
    };
    element.setPointerCapture(e.pointerId);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  }

  // Gives `ratio` to the split of `group` that `divider` divides, if the
  // group still has it; `done`: the drag is over, the layout is kept.
  private setRatio(group: Group, divider: Divider, ratio: number, done: boolean): void {
    // A pane that closed meanwhile changes the splits: the drag is over.
    const same = (d: Divider) =>
      d.direction === divider.direction && d.path.join() === divider.path.join();
    if (!this.entries.some((entry) => entry.group === group)) return;
    if (!dividersOf(group.layout).some(same)) return;
    group.layout = withRatio(group.layout, divider.path, ratio);
    this.arrange();
    if (done) this.changed();
  }

  private retitle(tab: Tab): void {
    const entry = this.entryOf(tab);
    if (!entry) return;
    this.paintRow(entry);
    // The others have their card instead.
    entry.row.title = tab === this.active ? tooltipOf(tab) : "";
    if (entry.group) this.paintGroup(entry.group);
    if (tab === this.active) this.options.onActiveChange(tab);
    this.changed();
  }

  // What the card of `tab` says: `null` once it is on screen or gone.
  private async previewOf(tab: Tab): Promise<PreviewContent | null> {
    if (this.onScreen(tab) || !this.entryOf(tab)) return null;
    const lines = await outputTail(tab, PREVIEW_LINES).catch(() => []);
    const now = Date.now();
    const title = this.nameOf(tab);
    return {
      title: tab.cwd === null ? title : `${title} · ${tab.cwd}`,
      status: shown(tab.status, now),
      statusText: describe(tab.status, now),
      command: tab.command,
      lines,
    };
  }

  // Where popovers open: past the edge of the sidebar, over the terminal.
  private popoverLeft(): number {
    const { list } = this.options;
    return (list.closest("aside") ?? list).getBoundingClientRect().right + 6;
  }

  // Opens the menu of what can be done with `tab`, next to its row. A pane
  // has none: what is done is done to its group.
  private menu(tab: Tab): void {
    const entry = this.entryOf(tab);
    if (!entry || entry.group) return;
    this.preview.leave();
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
          : [
              {
                label: "Move to space…",
                icon: "›",
                onSelect: () => this.moveMenu(tab, entry.row),
              },
            ]),
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

  // The menu of a group, next to its row: as the one of a tab, without the
  // pin, which a group cannot have.
  private groupMenu(group: Group): void {
    this.preview.leave();
    openMenu({
      title: groupTitle(group),
      left: this.popoverLeft(),
      top: group.head.getBoundingClientRect().top - 6,
      items: [
        { label: "Rename…", icon: RENAME_ICON, onSelect: () => this.renameGroup(group) },
        {
          label: "Move to space…",
          icon: "›",
          onSelect: () => this.moveMenu(group.last, group.head),
        },
        {
          label: "Close tab",
          icon: "×",
          danger: true,
          line: true,
          onSelect: () => this.closeGroup(group),
        },
      ],
      onClose: () => {
        this.inMenu = null;
        group.head.classList.remove("in-menu");
      },
    });
    this.inMenu = group;
    group.head.classList.add("in-menu");
  }

  // The spaces `tab`, with its group if in one, can go to, next to `anchor`,
  // where its menu was.
  private moveMenu(tab: Tab, anchor: HTMLElement): void {
    const entry = this.entryOf(tab);
    if (!entry) return;
    const others = this.spaces.filter((space) => space !== entry.space);
    openMenu({
      title: "Move to",
      left: this.popoverLeft(),
      top: anchor.getBoundingClientRect().top - 6,
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
  // one, and its group, and stays in front if it was. The only tab of a
  // space leaves a new one there in its folder: a space with no tab would
  // go away.
  private async pin(tab: Tab): Promise<void> {
    const entry = this.entryOf(tab);
    if (!entry || entry.space === PINNED) return;
    const from = entry.space;
    this.detach(entry);
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
    const entry = this.entryOf(tab);
    if (!entry || entry.space !== PINNED) return;
    this.relocate(entry, this.space);
    if (this.active === null) this.activate(tab);
  }

  // Moves `entry`, session alive and on its own, to the end of `target`,
  // whose rows are the ones seen: the space shown, the tabs without one,
  // or the pinned.
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
    this.arrange();
    this.changed();
  }

  private placeOf(tab: Tab | null): Place | undefined {
    return this.entryOf(tab)?.space;
  }

  // Opens the popover next to the row of `tab`, on the side of the terminal.
  private rename(tab: Tab): void {
    const entry = this.entryOf(tab);
    if (!entry) return;
    this.preview.leave();
    const { textarea } = this.options;
    openRename({
      row: entry.row.getBoundingClientRect(),
      left: this.popoverLeft(),
      look: tab.look,
      placeholder: defaultTitle(tab) ?? UNTITLED,
      cwd: tab.cwd,
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

  // Opens the popover next to the row of `group`: its name, color and icon.
  private renameGroup(group: Group): void {
    this.preview.leave();
    const first = panesOf(group.layout)[0];
    const { textarea } = this.options;
    openRename({
      row: group.head.getBoundingClientRect(),
      left: this.popoverLeft(),
      look: group.look,
      placeholder: defaultTitle(first) ?? UNTITLED,
      cwd: first.cwd,
      onChange: (look) => {
        group.look = look;
        this.paintGroup(group);
        if (this.active && this.entryOf(this.active)?.group === group) {
          this.options.onActiveChange(this.active);
        }
        this.changed();
      },
      onClose: () => {
        this.renaming = null;
        textarea.focus();
      },
    });
    this.renaming = group;
  }

  // A press on `element`, the row of a tab or the box of a group: moved
  // past the threshold, it drags it among the others of its place, which
  // make room for it; released, it takes that place and is shown, as a
  // click would.
  private press(element: HTMLElement, e: PointerEvent): void {
    if (e.button !== 0 || (e.target as Element).closest(".tab-actions")) return;
    const owner = this.entries.find((entry) => this.unitOf(entry) === element);
    if (!owner) return;
    const place = owner.space;
    // The list it is in: the tabs of the space, or the pinned ones.
    const box = element.parentElement;
    const rows = this.unitsOf(place).map((unit) => unit.element);
    if (rows.length < 2) return;
    const from = rows.indexOf(element);
    if (from < 0) return;
    // Measured once: the rows that make room only move by transforms. A
    // group may be taller than a row: the others move by its height.
    const boxes = rows.map((r) => r.getBoundingClientRect());
    const centers = boxes.map((box) => box.top + box.height / 2);
    const step = boxes[from].height + (boxes[1].top - boxes[0].bottom);
    const min = boxes[0].top - boxes[from].top;
    const max = boxes[boxes.length - 1].bottom - boxes[from].bottom;
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
        element.classList.add("dragging");
      }
      element.style.transform = `translateY(${dy}px)`;
      to = dropIndex(centers, from, centers[from] + dy);
      rows.forEach((r, index) => {
        if (index === from) return;
        const shift = makeRoom(index, from, to, step);
        r.style.transform = shift === 0 ? "" : `translateY(${shift}px)`;
      });
    };
    const end = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
      if (!dragging) return;
      // Without the transition first, the rows would slide back from where
      // they already are.
      box?.classList.remove("reordering");
      element.classList.remove("dragging");
      for (const r of rows) r.style.transform = "";
      // A tab that opened or closed meanwhile, or a space that changed,
      // makes the places counted at the start wrong: nothing moves.
      const now = this.unitsOf(place);
      const unit = now.find((u) => u.element === element);
      if (owner.space !== place || now.length !== rows.length || !unit) return;
      this.place(unit, to);
      if (place === this.space || place === PINNED) {
        this.activate(unit.group?.last ?? unit.entries[0].tab);
      }
    };
    element.setPointerCapture(e.pointerId);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  }

  // Puts `unit` at `index` among the rows of its place, in the list and in
  // the sidebar.
  private place(unit: Unit, index: number): void {
    const units = this.unitsOf(unit.entries[0].space);
    if (units.findIndex((u) => u.element === unit.element) === index) return;
    const others = units.filter((u) => u.element !== unit.element);
    this.entries = this.entries.filter((entry) => !unit.entries.includes(entry));
    const before = others[index];
    if (before) {
      this.entries.splice(this.entries.indexOf(before.entries[0]), 0, ...unit.entries);
      before.element.before(unit.element);
    } else {
      const after = others[others.length - 1];
      const last = after.entries[after.entries.length - 1];
      this.entries.splice(this.entries.indexOf(last) + 1, 0, ...unit.entries);
      after.element.after(unit.element);
    }
    this.changed();
  }

  // Closing the visible tab shows the one that takes its place: the pane
  // next to it in its group, or the one that takes its place in the list
  // of its space, or the last one.
  private close(tab: Tab): void {
    const entry = this.entryOf(tab);
    if (!entry) return;
    const { space: place } = entry;
    const mates = this.matesOf(entry);
    const group = entry.group;
    this.detach(entry);
    const index = this.tabsOf(place).indexOf(entry);
    // A group that is no more takes its popover or menu with it.
    const gone = group !== null && !this.entries.some((e) => e.group === group);
    if (tab === this.renaming || (gone && group === this.renaming)) closeForm();
    if (tab === this.inMenu || (gone && group === this.inMenu)) closeMenu();
    this.preview.forget(tab);
    this.entries.splice(this.entries.indexOf(entry), 1);
    this.waiting.delete(tab);
    window.clearTimeout(this.statusTimers.get(tab));
    this.statusTimers.delete(tab);
    entry.row.remove();
    closeTab(tab);
    this.changed();

    const left = this.tabsOf(place);
    if (this.lastTab.get(place) === tab) {
      const next = mates[0] ?? left[Math.min(index, left.length - 1)]?.tab;
      if (next) this.lastTab.set(place, next);
      else this.lastTab.delete(place);
    }
    if (tab !== this.active) {
      // The group on screen may be the one it left.
      this.arrange();
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
  return {
    look: tab.look,
    cwd: tab.cwd,
    command: tab.command,
    restart: tab.restart ?? tab.offer,
    favorites: tab.favorites,
  };
}

/**
 * What is kept of the tab of `entry`: the first of a group has the look of
 * the group, which comes back with it.
 */
function keptOf({ tab, group }: Entry): Kept {
  const first = group && panesOf(group.layout)[0] === tab;
  return first ? { ...kept(tab), look: group.look } : kept(tab);
}

/** What the row of a group says: its name, or the folder of its first pane. */
function groupTitle(group: Group): string {
  const first = panesOf(group.layout)[0];
  return group.look.name ?? defaultTitle(first) ?? UNTITLED;
}

/**
 * What the row of a pane says: the folder it works in, and the last
 * command it ran.
 */
function paneText(tab: Tab): string {
  const where = defaultTitle(tab) ?? UNTITLED;
  return tab.command ? `${where} · ${tab.command}` : where;
}

function toSaved({ look, cwd, command, restart, favorites }: Kept): SavedTab {
  return { ...look, cwd, command, restart, favorites };
}

// A file from before the commands were kept has none; one from before the
// icons of Untitled UI names those of Lucide.
function fromSaved({ cwd, command, restart, favorites, ...look }: SavedTab): Kept {
  return {
    look: { ...look, icon: iconName(look.icon) },
    cwd,
    command: command ?? null,
    restart: restart ?? null,
    favorites: favorites ?? [],
  };
}

// The groups of a space of the state file, among `count` tabs. One that
// cannot be read is left out: its tabs come back on their own.
function readLayouts(saved: SavedLayout[], count: number): Layout<number>[] {
  const used = new Set<number>();
  return saved
    .map((layout) => fromSavedLayout(layout, count, used))
    .filter((layout) => layout !== null);
}

// Tells the session of `entry` the space its tab is in now, for the
// commands it records in the history.
function placed({ tab, space }: Entry): void {
  setTabSpace(tab, space === null || space === PINNED ? null : space.id);
}

// Puts the band of `divider` over the line it moves, in an area of
// `width` x `height`: across the gap, as long as the split.
function placeDivider(element: HTMLElement, divider: Divider, width: number, height: number): void {
  const { rect, ratio } = divider;
  const row = divider.direction === "row";
  const at = row ? (rect.x + rect.w * ratio) * width : (rect.y + rect.h * ratio) * height;
  element.style.left = `${row ? at - DIVIDER_HIT / 2 : rect.x * width}px`;
  element.style.top = `${row ? rect.y * height : at - DIVIDER_HIT / 2}px`;
  element.style.width = `${row ? DIVIDER_HIT : rect.w * width}px`;
  element.style.height = `${row ? rect.h * height : DIVIDER_HIT}px`;
}

function button(className: string, title: string, text: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.className = className;
  element.title = title;
  element.textContent = text;
  return element;
}

// One hover away on the row of the tab shown: its name, what the program
// says of itself, and the whole path with its branch.
function tooltipOf(tab: Tab): string {
  const branch = tab.git && `${tab.git.branch}${tab.git.dirty ? " (changes to commit)" : ""}`;
  return [titleOf(tab), tab.title, tab.cwd, branch].filter((line) => line !== null).join("\n");
}
