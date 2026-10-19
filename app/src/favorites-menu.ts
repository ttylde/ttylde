import { type Favorite, type FavoriteStore, menuOf } from "./favorites";
import { GRIP_ICON, PLAY_ICON, PLUS_ICON } from "./icons";
import { dropIndex } from "./reorder";

export type FavoritesMenuOptions = {
  /** What it opens under, its right edge on the one of the menu. */
  anchor: HTMLElement;
  store: FavoriteStore;
  /** The space of the tab shown; `null`: none, or a pinned tab. */
  space: { id: number; name: string } | null;
  /** The last command of the tab, offered to save if it is not saved. */
  lastCommand: string | null;
  run(favorite: Favorite): void;
  /** Opens the dialog that saves `command`. */
  save(command: string): void;
  onClose(): void;
};

/** How far the pointer moves, in pixels, before a press on a handle is a drag. */
const DRAG_THRESHOLD = 4;

let current: { options: FavoritesMenuOptions; root: HTMLElement; close(): void } | null = null;

export function isFavoritesMenuOpen(): boolean {
  return current !== null;
}

export function closeFavoritesMenu(): void {
  current?.close();
}

/**
 * The menu of the saved commands of the space of the tab: first those in
 * the header, then, under a line, those only here. A row dragged by its
 * handle above the line goes in the header, below leaves it; the order is
 * the order of the chips.
 */
export function openFavoritesMenu(options: FavoritesMenuOptions): void {
  current?.close();
  const root = document.createElement("div");
  root.className = "favorites-menu";
  document.body.append(root);

  const outside = (e: MouseEvent) => {
    if (!root.contains(e.target as Node) && !options.anchor.contains(e.target as Node)) close();
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const close = () => {
    root.remove();
    document.removeEventListener("mousedown", outside, true);
    window.removeEventListener("keydown", keys, true);
    current = null;
    options.onClose();
  };
  document.addEventListener("mousedown", outside, true);
  window.addEventListener("keydown", keys, true);
  current = { options, root, close };
  draw();
}

/** Draws the menu again: the saved commands changed. */
export function refreshFavoritesMenu(): void {
  if (current) draw();
}

function draw(): void {
  if (!current) return;
  const { options, root } = current;
  const { store } = options;
  const space = options.space?.id ?? null;
  root.replaceChildren();

  const heading = element("div", "favorites-heading");
  heading.append(element("span", "", "IN THE HEADER"));
  heading.append(element("span", "favorites-folder", options.space?.name ?? "everywhere"));
  root.append(heading);

  const menu = menuOf(store.list, space);
  const pinned = menu.filter((f) => f.pinned).length;
  // The rows as `rearrange` counts them: the line between pinned and not is one.
  const rows: HTMLElement[] = [];
  menu.forEach((favorite, i) => {
    if (i === pinned) rows.push(line());
    rows.push(favoriteRow(favorite));
  });
  if (menu.length > 0 && pinned === menu.length) rows.push(line());
  root.append(...rows);
  rows.forEach((row, index) => {
    row.querySelector(".favorites-grip")?.addEventListener("pointerdown", (e) => {
      press(rows, index, e as PointerEvent);
    });
  });

  if (menu.length === 0) {
    root.append(
      element(
        "div",
        "favorites-empty",
        "No saved command here yet. Save one from the recents, or with the bookmark in the palette.",
      ),
    );
  }

  root.append(element("div", "favorites-rule"));
  const last = options.lastCommand;
  if (last && !store.has(last, space)) {
    const save = element("div", "favorites-save");
    const plus = element("span", "favorites-plus");
    plus.innerHTML = PLUS_ICON;
    save.append(
      plus,
      element("span", "", "Save last command"),
      element("span", "favorites-last", last),
    );
    save.addEventListener("click", () => {
      current?.close();
      options.save(last);
    });
    root.append(save);
  }
  root.append(
    element("div", "favorites-hint", "▶ run · drag ⋮⋮ to reorder · above the line = in the header"),
  );

  // Under the anchor, its right edge on the one of the anchor.
  const anchor = options.anchor.getBoundingClientRect();
  root.style.top = `${anchor.bottom + 6}px`;
  root.style.right = `${Math.max(8, window.innerWidth - anchor.right)}px`;
}

function line(): HTMLElement {
  const row = element("div", "favorites-line");
  row.append(element("span", "favorites-line-rule"), element("span", "", "ONLY IN THE MENU"));
  row.append(element("span", "favorites-line-rule"));
  return row;
}

function favoriteRow(favorite: Favorite): HTMLElement {
  if (!current) throw new Error("no menu");
  const { options } = current;
  const row = element("div", "favorites-row");
  row.classList.toggle("pinned", favorite.pinned);
  row.title = favorite.space === null ? `${favorite.command} · everywhere` : favorite.command;
  const grip = element("span", "favorites-grip");
  grip.innerHTML = GRIP_ICON;
  grip.title = "Drag to reorder · above the line = in the header";
  const run = document.createElement("button");
  run.type = "button";
  run.className = "favorites-run";
  run.title = `Run ${favorite.command}`;
  run.innerHTML = PLAY_ICON;
  run.addEventListener("click", () => {
    current?.close();
    options.run(favorite);
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "favorites-remove";
  remove.title = "Delete saved command";
  remove.textContent = "×";
  remove.addEventListener("click", () => options.store.remove(favorite));
  row.append(
    grip,
    element("b", "favorites-name", favorite.name),
    element("span", "favorites-command", favorite.command),
    run,
    remove,
  );
  return row;
}

// Drags the row at `from` by its handle; on release the store moves it to
// where it was dropped, the line counted as a row.
function press(rows: HTMLElement[], from: number, e: PointerEvent): void {
  if (e.button !== 0 || !current) return;
  e.preventDefault();
  const { store } = current.options;
  const space = current.options.space?.id ?? null;
  const row = rows[from];
  const centers = rows.map((r) => {
    const box = r.getBoundingClientRect();
    return box.top + box.height / 2;
  });
  const start = e.clientY;
  let dragging = false;
  let to = from;
  const grip = e.currentTarget as HTMLElement;

  const move = (m: PointerEvent) => {
    const dy = m.clientY - start;
    if (!dragging) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return;
      dragging = true;
      row.classList.add("dragging");
    }
    row.style.transform = `translateY(${dy}px)`;
    to = dropIndex(centers, from, centers[from] + dy);
    rows.forEach((r, index) => {
      r.classList.toggle("drop-above", to < from && index === to);
      r.classList.toggle("drop-below", to > from && index === to);
    });
  };
  const end = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", end);
    grip.removeEventListener("pointercancel", end);
    for (const r of rows) {
      r.classList.remove("dragging", "drop-above", "drop-below");
      r.style.transform = "";
    }
    if (dragging) store.move(space, from, to);
  };
  grip.setPointerCapture(e.pointerId);
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}

function element(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}
