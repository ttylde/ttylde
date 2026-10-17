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
import { SEARCH_ICON } from "./icons";
import { cleanName } from "./look";
import { SHELLS, SPACE_COLORS, type Space, type SpaceChanges, tabCount } from "./space";
import type { ClosedSpace } from "./tabs";

export type PaletteOptions = {
  /** The space shown, `null` with none open: the scope "this space". */
  space(): Space | null;
  /** How many tabs the space shown has: deleting it closes them. */
  spaceTabs(): number;
  closedSpaces(): ClosedSpace[];
  /** Where a command ran, for its row: a tab open there, or the folder. */
  whereOf(cwd: string | null): string;
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

export type Tab = "recent" | "actions";
type Scope = "space" | "all";
type Setting = "rename" | "color" | "folder" | "shell" | "delete";

/** What a row of the palette does when it is picked. */
type Item =
  | { kind: "command"; command: HistoryCommand }
  | { kind: "action"; label: string; hint: string; run(): void }
  | { kind: "setting"; setting: Setting }
  | { kind: "clear" };

const TABS: { id: Tab; label: string }[] = [
  { id: "recent", label: "Recent" },
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
  private readonly list: HTMLElement;

  private tab: Tab = "recent";
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
    search.append(icon, this.input);
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

  /** The tab shown, while it is open. */
  get shownTab(): Tab {
    return this.tab;
  }

  /** Opens on `tab`, with nothing typed. */
  open(tab: Tab = "recent"): void {
    this.tab = tab;
    this.scope = this.options.space() ? "space" : "all";
    this.input.value = "";
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
    }
  }

  private switchTo(tab: Tab): void {
    this.tab = tab;
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
        const next = SPACE_COLORS[(SPACE_COLORS.indexOf(space.color) + 1) % SPACE_COLORS.length];
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
    this.input.placeholder = this.tab === "recent" ? "Search a command…" : "Search an action…";
    this.list.replaceChildren();
    this.items = [];
    if (this.tab === "recent") this.drawRecent();
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
    if (this.tab === "actions") return "No action matches.";
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
    const actions: { label: string; hint: string; run(): void }[] = [
      { label: "New tab", hint: "⌘T", run: () => this.options.newTab() },
      ...(space
        ? [{ label: "Save and close space", hint: "", run: () => this.options.closeSpace() }]
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
    const text = this.text.toLowerCase();
    for (const action of actions.filter((a) => a.label.toLowerCase().includes(text))) {
      const row = this.row({ kind: "action", ...action }, "palette-row palette-action");
      row.append(element("span", "palette-label", action.label));
      if (action.hint) row.append(element("span", "palette-hint", action.hint));
    }
    if (space) this.drawSettings(space, text);
  }

  // The settings of the space shown, those whose name the text matches;
  // the name of the space or "space" matches them all.
  private drawSettings(space: Space, text: string): void {
    const all = !text || "space".includes(text) || space.name.toLowerCase().includes(text);
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
        for (const color of SPACE_COLORS) {
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
