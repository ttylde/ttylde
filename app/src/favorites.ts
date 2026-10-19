import { invoke } from "@tauri-apps/api/core";

/** Mirror of `Favorite` in core/src/favorites.rs: a saved command. */
export type Favorite = {
  name: string;
  command: string;
  /** The id of the space it is for; `null`: every space, and no space. */
  space: number | null;
  /** A chip in the header, not only in the menu. */
  pinned: boolean;
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
 * The saved commands of `space` as the menu lists them: those in the header
 * first, then the others, each part in the order of `list`.
 */
export function menuOf(list: Favorite[], space: number | null): Favorite[] {
  const here = list.filter((favorite) => holdsIn(favorite, space));
  return [...here.filter((f) => f.pinned), ...here.filter((f) => !f.pinned)];
}

/**
 * `list` after a row of the menu of `space` is dragged. The menu is its rows
 * with the line between pinned and not in between: `from` and `to` count
 * that line as a row too, `to` being the place of the row once dropped.
 * A row above the line ends up in the header. The commands of other
 * spaces keep their places in `list`.
 */
export function rearrange(
  list: Favorite[],
  space: number | null,
  from: number,
  to: number,
): Favorite[] {
  const menu = menuOf(list, space);
  const pinned = menu.filter((f) => f.pinned).length;
  const LINE = null;
  const rows: (Favorite | null)[] = [...menu.slice(0, pinned), LINE, ...menu.slice(pinned)];
  if (rows[from] === LINE || from === to) return list;
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);
  const line = rows.indexOf(LINE);
  const arranged = rows
    .filter((row): row is Favorite => row !== LINE)
    .map((favorite) => ({ ...favorite, pinned: rows.indexOf(favorite) < line }));

  // The places these commands had in `list`, filled in their new order.
  const result = [...list];
  const places = list.flatMap((favorite, index) => (menu.includes(favorite) ? [index] : []));
  places.forEach((place, i) => {
    result[place] = arranged[i];
  });
  return result;
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

  /** Adds `favorite` at the end of those in the header, or of the others. */
  add(favorite: Favorite): void {
    this.items = [...this.items, favorite];
    this.changed();
  }

  remove(favorite: Favorite): void {
    this.items = this.items.filter((f) => f !== favorite);
    this.changed();
  }

  /** Applies a drag in the menu of `space`: see `rearrange`. */
  move(space: number | null, from: number, to: number): void {
    const next = rearrange(this.items, space, from, to);
    if (next === this.items) return;
    this.items = next;
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
