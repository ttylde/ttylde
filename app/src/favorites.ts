import { invoke } from "@tauri-apps/api/core";

/** Mirror of `Favorite` in core/src/favorites.rs: a saved command. */
export type Favorite = {
  /** What the tabs name it by: see `Tab.favorites`. */
  id: number;
  name: string;
  command: string;
  /** The id of the space it is for; `null`: every space, and no space. */
  space: number | null;
};

/**
 * The name a command is saved under unless the user gives another: its
 * first word after the runner, capitalized. `pnpm dev` → `Dev`, `docker
 * compose up` → `Up`, `git pull --rebase` → `Pull`.
 */
export function guessName(command: string): string {
  const rest = command
    .trim()
    .replace(/^(pnpm|npm run|npm|yarn|bun|docker compose|git|cargo|make)\s+/, "");
  const word = rest.split(/\s+/)[0] || command.trim();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Whether `favorite` holds in `space` (`null`: a tab in no space, or a
 * pinned one): it is for that space, or for every one.
 */
export function holdsIn(favorite: Favorite, space: number | null): boolean {
  return favorite.space === null || favorite.space === space;
}

/**
 * The saved commands a tab of `space` has, split as its menu lists them:
 * those of the space in its header, in the order of `header` (the ids the
 * tab keeps), then the other ones of the space, then the global ones, in
 * the order they were saved. A global one is everywhere: it has no place
 * among those of a space, and is not dragged.
 */
export function menuOf(
  list: Favorite[],
  space: number | null,
  header: number[],
): { header: Favorite[]; others: Favorite[]; globals: Favorite[] } {
  const own = space === null ? [] : list.filter((favorite) => favorite.space === space);
  const shown = header.flatMap((id) => own.filter((f) => f.id === id));
  return {
    header: shown,
    others: own.filter((f) => !shown.includes(f)),
    globals: list.filter((f) => f.space === null),
  };
}

/**
 * The chips of the header of a tab: first those of its space, in its
 * order, then the global ones it has, in the order they were put there.
 */
export function pinnedOf(list: Favorite[], space: number | null, header: number[]): Favorite[] {
  const menu = menuOf(list, space, header);
  const globals = header.flatMap((id) => menu.globals.filter((f) => f.id === id));
  return [...menu.header, ...globals];
}

/** The header of a tab once `id` is put in it, or taken out if it is there. */
export function toggled(header: number[], id: number): number[] {
  return header.includes(id) ? header.filter((other) => other !== id) : [...header, id];
}

/**
 * The header of a tab after a row of its menu is dragged: the ids of the
 * commands of the space above the line, in their order, then the global
 * ones it had. The rows are those of the space with the line between
 * header and not in between: `from` and `to` count that line as a row
 * too, `to` being the place of the row once dropped.
 */
export function rearrange(
  list: Favorite[],
  space: number | null,
  header: number[],
  from: number,
  to: number,
): number[] {
  const menu = menuOf(list, space, header);
  const globals = header.filter((id) => menu.globals.some((f) => f.id === id));
  const LINE = null;
  const rows: (Favorite | null)[] = [...menu.header, LINE, ...menu.others];
  if (rows[from] === LINE || from === to) return [...menu.header.map((f) => f.id), ...globals];
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);
  const own = rows.slice(0, rows.indexOf(LINE)).flatMap((row) => (row ? [row.id] : []));
  return [...own, ...globals];
}

export function load(): Promise<Favorite[]> {
  return invoke<{ favorite: Favorite[] }>("favorites_load").then((saved) => saved.favorite);
}

export function save(list: Favorite[]): Promise<void> {
  return invoke("favorites_save", { favorites: { favorite: list } });
}

/**
 * The saved commands while the app runs: every change is written to the
 * file a moment later, and told to whoever listens.
 */
export class FavoriteStore {
  private items: Favorite[] = [];
  private timer: number | undefined;
  private listeners: (() => void)[] = [];

  get list(): Favorite[] {
    return this.items;
  }

  async load(): Promise<void> {
    this.items = await load().catch(() => []);
    this.changed(false);
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Whether `command` is saved for `space`, or for every space. */
  has(command: string, space: number | null): boolean {
    return this.items.some((f) => f.command === command && holdsIn(f, space));
  }

  /** Saves a command: in no header yet, every tab puts it in its own. */
  add(favorite: Omit<Favorite, "id">): Favorite {
    const id = this.items.reduce((max, f) => Math.max(max, f.id), 0) + 1;
    const saved = { ...favorite, id };
    this.items = [...this.items, saved];
    this.changed();
    return saved;
  }

  /** Changes the command `id`: its name, command or space. */
  update(id: number, fields: Omit<Favorite, "id">): void {
    this.items = this.items.map((f) => (f.id === id ? { ...fields, id } : f));
    this.changed();
  }

  remove(favorite: Favorite): void {
    this.items = this.items.filter((f) => f.id !== favorite.id);
    this.changed();
  }

  /** The space `id` is gone: its saved commands go with it. */
  removeSpace(id: number): void {
    if (!this.items.some((f) => f.space === id)) return;
    this.items = this.items.filter((f) => f.space !== id);
    this.changed();
  }

  private changed(write = true): void {
    for (const listener of this.listeners) listener();
    if (!write) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      save(this.items).catch((error) => console.error("ttylde: cannot save the commands", error));
    }, 300);
  }
}
