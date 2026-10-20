import type { Favorite, FavoriteStore } from "./favorites";
import { type Asked, asked } from "./filters";
import {
  byDay,
  clear,
  commands,
  count,
  failed,
  forget,
  type HistoryCommand,
  timeOf,
} from "./history";
import { BOOKMARK_ICON, SEARCH_ICON } from "./icons";
import { COLORS, cleanName } from "./look";
import { SHELLS, type Space, type SpaceChanges, tabCount } from "./space";
import type { ClosedSpace } from "./tabs";

export type PaletteOptions = {
  /** The space shown, `null` with none open: the scope "this space". */
  space(): Space | null;
  /** How many tabs the space shown has: deleting it closes them. */
  spaceTabs(): number;
  closedSpaces(): ClosedSpace[];
  /** The name of the space `id`, if it is still there. */
  spaceName(id: number): string | null;
  /** Where a command ran, for its row: a tab open there, or the folder. */
  whereOf(cwd: string | null): string;
  favorites: FavoriteStore;
  /**
   * Opens the dialog that saves `command`, for the space `space` (`null`:
   * the one shown) or everywhere.
   */
  saveCommand(command: string, space: number | null): void;
  collapsed(): boolean;
  /** Runs `command` in the tab shown, or in a new one if there is none. */
  run(command: string): void;
  newTab(): void;
  closeSpace(): void;
  toggleSidebar(): void;
  /** Reopens the space at `index` among every space. */
  reopen(index: number): void;
  editSpace(changes: SpaceChanges): void;
  deleteSpace(): void;
  toast(text: string): void;
  /** The palette closed: the keyboard goes back where it was. */
  onClose(): void;
};

export type Tab = "recent" | "saved" | "actions";
type Scope = "space" | "all";
type Setting = "rename" | "color" | "folder" | "shell" | "delete";

/** What a row of the palette does when it is picked. */
type Item =
  | { kind: "command"; command: HistoryCommand }
  | { kind: "favorite"; favorite: Favorite }
  /** Saves the text typed as a command, or a new one from scratch. */
  | { kind: "save"; command: string }
  /** A filter of the actions: picked, it is typed in. */
  | { kind: "filter"; token: string }
  | { kind: "action"; label: string; hint: string; run(): void }
  | { kind: "setting"; setting: Setting }
  | { kind: "clear" };

const TABS: { id: Tab; label: string }[] = [
  { id: "recent", label: "Recent" },
  { id: "saved", label: "Saved" },
  { id: "actions", label: "Actions" },
];

/**
 * The palette (`Cmd+P`, `Cmd+Shift+P` on its actions): the commands run before, from the history, and the
 * actions of the app, searched by typing. Recent lists each command once,
 * by day; typed text finds them as a fuzzy search does. Actions include
 * the settings of the space shown, which change as they are edited.
 */
export class Palette {
  private readonly backdrop: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly scopeButton: HTMLButtonElement;
  private readonly input: HTMLInputElement;
  /** The filter applied to the actions, shown as a chip before the text. */
  private readonly chip: HTMLElement;
  private readonly list: HTMLElement;

  private tab: Tab = "recent";
  // The filter of the actions once applied: `@space`, or none.
  private filter: string | null = null;
  private scope: Scope = "space";
  private found: HistoryCommand[] = [];
  private total = 0;
  private items: Item[] = [];
  private selected = 0;
  // A setting being edited in place, or a step that asks first.
  private editing: "rename" | "folder" | null = null;
  private confirming: "delete" | "clear" | null = null;
  // Answers to older questions are dropped: only the last one shows.
  private asked = 0;

  constructor(private options: PaletteOptions) {
    this.backdrop = element("div", "palette-backdrop");
    this.panel = element("div", "palette");
    this.tabs = element("div", "palette-tabs");
    this.scopeButton = document.createElement("button");
    this.scopeButton.type = "button";
    this.scopeButton.className = "palette-scope";
    this.scopeButton.title = "Scope";
    const search = element("label", "palette-search");
    const icon = element("span", "palette-search-icon");
    icon.innerHTML = SEARCH_ICON;
    this.input = document.createElement("input");
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.chip = element("span", "palette-chip");
    this.chip.hidden = true;
    search.append(icon, this.chip, this.input);
    this.list = element("div", "palette-list");
    this.panel.append(this.tabs, search, this.list);
    this.backdrop.hidden = true;
    this.panel.hidden = true;
    document.body.append(this.backdrop, this.panel);

    this.backdrop.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.close();
    });
    this.scopeButton.addEventListener("click", () => {
      if (!this.options.space()) return;
      this.scope = this.scope === "space" ? "all" : "space";
      this.confirming = null;
      void this.refresh();
      this.input.focus();
    });
    this.input.addEventListener("input", () => {
      this.selected = 0;
      this.confirming = null;
      // `@space ` typed in full becomes the chip of the filter.
      const typed = asked(this.input.value);
      if (this.tab === "actions" && typed.kind === "filter" && /\s/.test(this.input.value)) {
        this.applyFilter(typed.token, typed.text);
      }
      void this.refresh();
    });
    this.input.addEventListener("keydown", (e) => this.key(e));
    // The window gives the focus to the terminal when it comes back: while
    // the palette is open, it is the palette that wants it.
    window.addEventListener("focus", () => {
      if (this.isOpen && !this.editing) queueMicrotask(() => this.input.focus());
    });
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  /** Draws again, if open: the saved commands changed. */
  redraw(): void {
    if (this.isOpen && !this.editing) this.draw();
  }

  /** The tab shown, while it is open. */
  get shownTab(): Tab {
    return this.tab;
  }

  /** Opens on `tab`, with `filter` applied to the actions: `@space` from the space menu. */
  open(tab: Tab = "recent", filter: string | null = null): void {
    this.tab = tab;
    this.scope = this.options.space() ? "space" : "all";
    this.input.value = "";
    this.applyFilter(tab === "actions" ? filter : null, "");
    this.selected = 0;
    this.editing = null;
    this.confirming = null;
    this.backdrop.hidden = false;
    this.panel.hidden = false;
    void this.refresh();
    this.input.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.backdrop.hidden = true;
    this.panel.hidden = true;
    this.options.onClose();
  }

  private get text(): string {
    return this.input.value.trim();
  }

  private get spaceId(): number | null {
    return this.scope === "space" ? (this.options.space()?.id ?? null) : null;
  }

  // Asks the history again, then draws.
  private async refresh(): Promise<void> {
    if (this.tab === "recent") {
      const asked = ++this.asked;
      const [found, total] = await Promise.all([
        commands(this.spaceId, this.text).catch(() => []),
        count(this.spaceId).catch(() => 0),
      ]);
      if (asked !== this.asked) return;
      this.found = found;
      this.total = total;
    }
    this.draw();
  }

  private key(e: KeyboardEvent): void {
    if (e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    // Backspace with nothing left to delete takes the filter away.
    if (
      e.key === "Backspace" &&
      this.filter &&
      this.input.selectionStart === 0 &&
      this.input.selectionEnd === 0
    ) {
      e.preventDefault();
      this.applyFilter(null, this.input.value);
      this.selected = 0;
      this.draw();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (!this.confirming) {
        this.close();
        return;
      }
      this.confirming = null;
      this.draw();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      this.select(this.selected + step);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const at = TABS.findIndex((t) => t.id === this.tab);
      this.switchTo(TABS[(at + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.pick(this.items[this.selected]);
    } else if (mod && e.key === "Backspace") {
      e.preventDefault();
      const item = this.items[this.selected];
      if (item?.kind === "command") void this.forget(item.command);
      if (item?.kind === "favorite") this.options.favorites.remove(item.favorite);
    } else if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      const item = this.items[this.selected];
      if (item?.kind === "command") this.save(item.command.last.command, item.command.last.space);
    }
  }

  // Applies `token` as the filter of the actions, with `text` left to type;
  // `null` takes the filter away.
  private applyFilter(token: string | null, text: string): void {
    this.filter = token;
    this.chip.hidden = token === null;
    this.chip.textContent = token ?? "";
    this.chip.title = token ? "Filter · Backspace to take it away" : "";
    this.input.value = text;
  }

  // What the actions are asked for: the filter applied, or the text typed.
  private query(): Asked {
    if (this.filter) {
      return { kind: "filter", token: this.filter, text: this.input.value.trim().toLowerCase() };
    }
    return asked(this.input.value);
  }

  private switchTo(tab: Tab): void {
    this.tab = tab;
    // A filter is of the actions only.
    if (tab !== "actions") this.applyFilter(null, this.input.value);
    this.selected = 0;
    this.editing = null;
    this.confirming = null;
    void this.refresh();
    this.input.focus();
  }

  private select(index: number): void {
    if (this.items.length === 0) return;
    this.selected = Math.max(0, Math.min(index, this.items.length - 1));
    this.draw();
  }

  // What Enter, or a click, does with a row; with none, typed text runs.
  private pick(item: Item | undefined): void {
    if (!item) {
      if (this.text && this.tab === "recent") this.runAndClose(this.text);
      return;
    }
    switch (item.kind) {
      case "command":
        this.runAndClose(item.command.last.command);
        break;
      case "favorite":
        this.runAndClose(item.favorite.command);
        break;
      case "save":
        this.save(item.command, null);
        break;
      case "filter":
        this.applyFilter(item.token, "");
        this.selected = 0;
        this.draw();
        this.input.focus();
        break;
      case "action":
        this.close();
        item.run();
        break;
      case "clear":
        if (this.confirming === "clear") {
          void this.clearHistory();
        } else {
          this.confirming = "clear";
          this.draw();
        }
        break;
      case "setting":
        this.setting(item.setting);
        break;
    }
  }

  // Closes, and opens the dialog that saves `command`.
  private save(command: string, space: number | null): void {
    this.close();
    this.options.saveCommand(command, space);
  }

  private runAndClose(command: string): void {
    this.close();
    this.options.run(command);
  }

  private async forget(command: HistoryCommand): Promise<void> {
    await forget(command.last.command, this.spaceId).catch(() => {});
    await this.refresh();
    this.select(this.selected);
  }

  private async clearHistory(): Promise<void> {
    const gone = await clear(this.spaceId).catch(() => 0);
    this.confirming = null;
    this.selected = 0;
    this.options.toast(`History cleared · ${commandCount(gone)} deleted`);
    await this.refresh();
  }

  // A setting of the space shown: the text ones are edited in their row,
  // color and shell take the next value, delete asks first.
  private setting(setting: Setting): void {
    const space = this.options.space();
    if (!space) return;
    switch (setting) {
      case "rename":
      case "folder":
        this.editing = setting;
        this.draw();
        break;
      case "color": {
        const next = COLORS[(COLORS.indexOf(space.color) + 1) % COLORS.length];
        this.change({ color: next });
        break;
      }
      case "shell": {
        const choices: (string | null)[] = [null, ...SHELLS];
        const next = choices[(choices.indexOf(space.shell) + 1) % choices.length];
        this.change({ shell: next });
        break;
      }
      case "delete":
        if (this.confirming === "delete") {
          this.close();
          this.options.deleteSpace();
        } else {
          this.confirming = "delete";
          this.draw();
        }
        break;
    }
  }

  // Applies `changes` to the space shown at once, keeping the rest.
  private change(changes: Partial<SpaceChanges>): void {
    const space = this.options.space();
    if (!space) return;
    const { name, color, folder, shell } = space;
    this.options.editSpace({ name, color, folder, shell, ...changes });
    this.draw();
  }

  private draw(): void {
    this.drawTabs();
    this.input.placeholder = {
      recent: "Search a command…",
      saved: "Filter saved commands…",
      actions: this.filter ? "Narrow the actions of this space…" : "Search an action, or @space…",
    }[this.tab];
    this.list.replaceChildren();
    this.items = [];
    if (this.tab === "recent") this.drawRecent();
    else if (this.tab === "saved") this.drawSaved();
    else this.drawActions();
    if (this.items.length === 0 && this.list.childElementCount === 0) {
      this.list.append(element("div", "palette-empty", this.emptyText()));
    }
    this.selected = Math.max(0, Math.min(this.selected, this.items.length - 1));
    const row = this.list.querySelector<HTMLElement>(`[data-index="${this.selected}"]`);
    row?.classList.add("selected");
    row?.scrollIntoView({ block: "nearest" });
  }

  private emptyText(): string {
    if (this.tab === "actions") {
      return this.query().kind === "choosing"
        ? "No such filter: @space is the one there is."
        : "No action matches.";
    }
    if (this.tab === "saved") return "No saved command matches.";
    if (this.text) return `No results · Enter to run "${this.text}"`;
    return "No command in this scope yet.";
  }

  private drawTabs(): void {
    this.tabs.replaceChildren(
      ...TABS.map(({ id, label }) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "palette-tab";
        tab.classList.toggle("active", id === this.tab);
        tab.textContent = label;
        tab.addEventListener("mousedown", (e) => e.preventDefault());
        tab.addEventListener("click", () => this.switchTo(id));
        return tab;
      }),
      this.scopeButton,
    );
    const space = this.options.space();
    this.scopeButton.textContent = `${this.scope === "space" && space ? space.name : "All spaces"} ▾`;
    this.scopeButton.disabled = !space;
  }

  private drawRecent(): void {
    if (this.text) {
      // Ranked by how well they match: one list, no days.
      for (const command of this.found) this.commandRow(command);
      if (!this.found.some((c) => c.last.command === this.text)) this.saveRow(this.text);
    } else {
      for (const group of byDay(this.found, Date.now())) {
        this.heading(group.day, commandCount(group.commands.length));
        for (const command of group.commands) this.commandRow(command);
      }
      if (this.total > 0) this.clearRow();
    }
  }

  private commandRow(command: HistoryCommand): void {
    const { last } = command;
    const row = this.row({ kind: "command", command }, "palette-row palette-command-row");
    const bad = failed(last);
    const mark = element("span", `palette-mark ${bad ? "failed" : "ok"}`, bad ? "✕" : "✓");
    mark.title = bad ? `exited with ${last.exit}` : "done";
    const text = element("span", "palette-command", last.command);
    // How many runs and the branch are kept, not shown: the row stays short.
    row.append(mark, text);
    // Where and when, together at the right end.
    const where = this.options.whereOf(last.cwd);
    const when = element("span", "palette-when");
    if (where)
      when.append(element("span", "palette-where", where), element("span", "palette-dot", "·"));
    when.append(element("span", "palette-time", timeOf(last.ended)));
    row.append(when);
    const saved = this.options.favorites.has(last.command, last.space);
    const bookmark = document.createElement("button");
    bookmark.type = "button";
    bookmark.className = "palette-bookmark";
    bookmark.classList.toggle("saved", saved);
    bookmark.title = saved ? "Saved" : "Save command (⌘S)";
    bookmark.innerHTML = BOOKMARK_ICON;
    bookmark.addEventListener("mousedown", (e) => e.preventDefault());
    bookmark.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!saved) this.save(last.command, last.space);
    });
    row.append(bookmark);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "palette-forget";
    remove.title = "Delete from the history (⌘⌫)";
    remove.textContent = "×";
    remove.addEventListener("mousedown", (e) => e.preventDefault());
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.forget(command);
    });
    row.append(remove);
  }

  // The saved commands in the scope, those the text is part of.
  private drawSaved(): void {
    const text = this.text.toLowerCase();
    const space = this.spaceId;
    const inScope = (f: Favorite) => space === null || f.space === null || f.space === space;
    const shown = this.options.favorites.list.filter(
      (f) =>
        inScope(f) &&
        (!text || f.name.toLowerCase().includes(text) || f.command.toLowerCase().includes(text)),
    );
    if (shown.length > 0) this.heading("SAVED", String(shown.length));
    for (const favorite of shown) this.favoriteRow(favorite);
    if (text) {
      if (!shown.some((f) => f.command === this.text)) this.saveRow(this.text);
    } else {
      const row = this.row({ kind: "save", command: "" }, "palette-row palette-new");
      row.append(element("span", "palette-mark"), element("span", "", "+ New saved command…"));
    }
  }

  private favoriteRow(favorite: Favorite): void {
    const row = this.row({ kind: "favorite", favorite }, "palette-row palette-command-row");
    const mark = element("span", "palette-mark saved");
    mark.innerHTML = BOOKMARK_ICON;
    row.append(mark, element("span", "palette-command", favorite.command));
    row.append(element("span", "palette-name", favorite.name));
    const when = element("span", "palette-when");
    const where =
      favorite.space === null ? "global" : (this.options.spaceName(favorite.space) ?? "");
    when.append(element("span", "palette-where", where));
    row.append(when);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "palette-forget";
    remove.title = "Delete saved command (⌘⌫)";
    remove.textContent = "×";
    remove.addEventListener("mousedown", (e) => e.preventDefault());
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      this.options.favorites.remove(favorite);
    });
    row.append(remove);
  }

  // "Save ⟨text⟩ as a command…", for text that is not one yet.
  private saveRow(text: string): void {
    const row = this.row({ kind: "save", command: text }, "palette-row palette-save");
    const icon = element("span", "palette-mark saved");
    icon.innerHTML = BOOKMARK_ICON;
    const label = element("span", "palette-save-label", "Save ");
    label.append(element("span", "palette-save-text", text), " as a command…");
    row.append(icon, label);
  }

  private clearRow(): void {
    this.list.append(element("div", "palette-line"));
    const scope = this.scope === "space" ? (this.options.space()?.name ?? "") : "All spaces";
    const row = this.row({ kind: "clear" }, "palette-row palette-clear");
    if (this.confirming === "clear") {
      row.classList.add("asking");
      row.append(element("span", "", `Delete ${commandCount(this.total)} from «${scope}»?`));
      row.append(this.choice("Cancel", "ghost", () => this.cancel()));
      row.append(this.choice("Clear", "danger", () => void this.clearHistory()));
    } else {
      row.append(element("span", "", `Clear history · ${scope}`));
      row.append(element("span", "palette-hint", commandCount(this.total)));
    }
  }

  private drawActions(): void {
    const space = this.options.space();
    // `space`: one of the actions of the space shown, for `@space`.
    const actions: { label: string; hint: string; space?: boolean; run(): void }[] = [
      { label: "New tab", hint: "⌘T", run: () => this.options.newTab() },
      ...(space
        ? [
            {
              label: "Save and close space",
              hint: "",
              space: true,
              run: () => this.options.closeSpace(),
            },
          ]
        : []),
      {
        label: this.options.collapsed() ? "Expand sidebar" : "Collapse sidebar",
        hint: "⌘\\",
        run: () => this.options.toggleSidebar(),
      },
      ...this.options.closedSpaces().map(({ index, space: closed }) => ({
        label: `Reopen space "${closed.name}"`,
        hint: "space",
        run: () => this.options.reopen(index),
      })),
    ];
    const query = this.query();
    if (query.kind === "choosing") {
      for (const filter of query.filters) {
        const row = this.row({ kind: "filter", token: filter.token }, "palette-row palette-action");
        row.append(element("span", "palette-filter", filter.token));
        row.append(element("span", "palette-hint", filter.label));
      }
      return;
    }
    // `@space` keeps the actions of the space and its settings.
    const shown = query.kind === "filter" ? (space ? actions.filter((a) => a.space) : []) : actions;
    const text = query.text;
    for (const action of shown.filter((a) => a.label.toLowerCase().includes(text))) {
      const row = this.row({ kind: "action", ...action }, "palette-row palette-action");
      row.append(element("span", "palette-label", action.label));
      if (action.hint) row.append(element("span", "palette-hint", action.hint));
    }
    if (space) this.drawSettings(space, text, query.kind === "filter");
  }

  // The settings of the space shown, those whose name the text matches;
  // the name of the space or "space" matches them all. Under `@space` the
  // text narrows them by their names alone.
  private drawSettings(space: Space, text: string, filtered: boolean): void {
    const all =
      !text || (!filtered && ("space".includes(text) || space.name.toLowerCase().includes(text)));
    const settings: { id: Setting; label: string }[] = [
      { id: "rename", label: "rename space" },
      { id: "color", label: "space color" },
      { id: "folder", label: "base folder" },
      { id: "shell", label: "shell" },
      { id: "delete", label: "delete space" },
    ];
    const shown = settings.filter((s) => all || s.label.includes(text));
    if (shown.length === 0) return;
    this.heading(`SPACE · ${space.name.toUpperCase()}`, "changes are saved at once");
    for (const { id } of shown) this.settingRow(space, id);
  }

  private settingRow(space: Space, setting: Setting): void {
    const row = this.row({ kind: "setting", setting }, "palette-row palette-setting");
    switch (setting) {
      case "rename":
      case "folder": {
        const label = setting === "rename" ? "Rename space" : "Base folder";
        const value = setting === "rename" ? space.name : space.folder;
        if (this.editing === setting) {
          row.append(element("span", "palette-label", label), this.fieldFor(setting, value));
        } else {
          row.append(element("span", "palette-label", `${label}…`));
          row.append(element("span", "palette-value", value));
        }
        break;
      }
      case "color": {
        row.append(element("span", "palette-label", "Space color"));
        const swatches = element("span", "palette-swatches");
        // The colors of the tabs, as in the mockup: the brand, then the spectrum.
        for (const color of COLORS) {
          const swatch = element("span", "palette-swatch");
          // One of the palette, never text typed by someone.
          swatch.style.background = color;
          swatch.classList.toggle("current", color === space.color);
          swatch.addEventListener("click", (e) => {
            e.stopPropagation();
            this.change({ color });
          });
          swatches.append(swatch);
        }
        row.append(swatches);
        break;
      }
      case "shell": {
        row.append(element("span", "palette-label", "Shell"));
        const choices = element("span", "palette-segments");
        for (const shell of [null, ...SHELLS]) {
          const choice = element("span", "palette-segment", shell ?? "System");
          choice.classList.toggle("current", shell === space.shell);
          choice.addEventListener("click", (e) => {
            e.stopPropagation();
            this.change({ shell });
          });
          choices.append(choice);
        }
        row.append(choices);
        break;
      }
      case "delete":
        row.classList.add("danger");
        if (this.confirming === "delete") {
          row.classList.add("asking");
          const tabs = tabCount(this.options.spaceTabs());
          row.append(element("span", "", `Delete "${space.name}" and its ${tabs}?`));
          row.append(this.choice("Cancel", "ghost", () => this.cancel()));
          row.append(
            this.choice("Delete", "danger", () => {
              this.close();
              this.options.deleteSpace();
            }),
          );
        } else {
          row.append(element("span", "palette-label", "Delete space…"));
        }
        break;
    }
  }

  // The field of a setting edited in place: Enter keeps it, Escape does not.
  private fieldFor(setting: "rename" | "folder", value: string): HTMLInputElement {
    const field = document.createElement("input");
    field.className = "palette-field";
    field.value = value;
    field.spellcheck = false;
    const done = (keep: boolean) => {
      if (keep) {
        const text = field.value.trim();
        if (setting === "rename") {
          const name = cleanName(field.value);
          if (name) this.options.editSpace({ ...changesOf(this.options.space()), name });
        } else {
          this.options.editSpace({ ...changesOf(this.options.space()), folder: text || "~" });
        }
      }
      this.editing = null;
      this.draw();
      this.input.focus();
    };
    field.addEventListener("click", (e) => e.stopPropagation());
    field.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        done(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        done(false);
      }
    });
    field.addEventListener("blur", () => {
      if (this.editing === setting) done(false);
    });
    queueMicrotask(() => {
      field.focus();
      field.select();
    });
    return field;
  }

  private cancel(): void {
    this.confirming = null;
    this.draw();
    this.input.focus();
  }

  private choice(text: string, kind: "ghost" | "danger", onClick: () => void): HTMLElement {
    const button = element("span", `palette-choice ${kind}`, text);
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return button;
  }

  private heading(title: string, meta: string): void {
    const heading = element("div", "palette-heading");
    heading.append(element("span", "", title), element("span", "palette-meta", meta));
    this.list.append(heading);
  }

  // A row that can be selected and picked: its place among the items.
  private row(item: Item, className: string): HTMLElement {
    const index = this.items.length;
    this.items.push(item);
    const row = element("div", className);
    row.dataset.index = String(index);
    row.addEventListener("mousedown", (e) => {
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    });
    row.addEventListener("mousemove", () => {
      if (this.selected === index) return;
      this.list.querySelector(".selected")?.classList.remove("selected");
      this.selected = index;
      row.classList.add("selected");
    });
    row.addEventListener("click", () => this.pick(item));
    this.list.append(row);
    return row;
  }
}

function changesOf(space: Space | null): SpaceChanges {
  if (!space) throw new Error("no space to change");
  const { name, color, folder, shell } = space;
  return { name, color, folder, shell };
}

function commandCount(count: number): string {
  return count === 1 ? "1 command" : `${count} commands`;
}

function element(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}
