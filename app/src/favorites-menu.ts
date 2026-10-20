import { type Favorite, type FavoriteStore, menuOf, rearrange, toggled } from "./favorites";
import {
  BOOKMARK_ICON,
  EDIT_ICON,
  GLOBAL_ICON,
  GRIP_ICON,
  MORE_ICON,
  PIN_ICON,
  PLAY_ICON,
  PLUS_ICON,
  TRASH_ICON,
} from "./icons";
import { closeMenu, isMenuOpen, openMenu } from "./menu";
import { dropIndex } from "./reorder";
import { NEW_COMMAND_HINT } from "./shortcuts";
import { toast } from "./toast";

export type FavoritesMenuOptions = {
  /** What it opens under, its right edge on the one of the menu. */
  anchor: HTMLElement;
  store: FavoriteStore;
  /** The space of the tab shown; `null`: none, or a pinned tab. */
  space: { id: number; name: string } | null;
  /** The ids of the saved commands in the header of the tab, in order. */
  header(): number[];
  /** The tab now has the saved commands `ids` in its header. */
  arrange(ids: number[]): void;
  /** The last command of the tab, offered to save if it is not saved. */
  lastCommand: string | null;
  run(favorite: Favorite): void;
  /** Opens the dialog that saves `command`; empty: a new one, to write. */
  save(command: string): void;
  /** Opens the dialog that changes `favorite`. */
  edit(favorite: Favorite): void;
  onClose(): void;
};

/** How far the pointer moves, in pixels, before a press on a handle is a drag. */
const DRAG_THRESHOLD = 4;

/** The width of the menu of a row, as in the mockup. */
const MORE_WIDTH = 200;

let current: { options: FavoritesMenuOptions; root: HTMLElement; close(): void } | null = null;

export function isFavoritesMenuOpen(): boolean {
  return current !== null;
}

export function closeFavoritesMenu(): void {
  current?.close();
}

/**
 * The menu of the saved commands of the tab: first those of its space in
 * its header, then, under a line, the other ones of the space, then the
 * global ones. A row of the space dragged by its handle above the line goes
 * in the header of this tab, below leaves it; the order is the order of its
 * chips. The global ones are the same everywhere and are not dragged: the
 * menu of each row puts them in the header, after those of the space.
 */
export function openFavoritesMenu(options: FavoritesMenuOptions): void {
  current?.close();
  const root = document.createElement("div");
  root.className = "favorites-menu";
  document.body.append(root);

  // While the menu of a row is open, clicks and keys are its own.
  const outside = (e: MouseEvent) => {
    if (isMenuOpen()) return;
    if (!root.contains(e.target as Node) && !options.anchor.contains(e.target as Node)) close();
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !isMenuOpen()) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const close = () => {
    closeMenu();
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
  heading.append(element("span", "", "SHORTCUTS"));
  heading.append(element("span", "favorites-folder", options.space?.name ?? "no space"));
  root.append(heading);

  const menu = menuOf(store.list, space, options.header());
  const own = menu.header.length + menu.others.length;
  // The rows as `rearrange` counts them: the line between header and not is one.
  const rows: HTMLElement[] =
    own === 0
      ? []
      : [
          ...menu.header.map((f) => favoriteRow(f, true)),
          line("OTHERS"),
          ...menu.others.map((f) => favoriteRow(f, false)),
        ];
  root.append(...rows);
  rows.forEach((row, index) => {
    row.querySelector(".favorites-grip")?.addEventListener("pointerdown", (e) => {
      press(rows, index, e as PointerEvent);
    });
  });

  if (own === 0) {
    root.append(
      element(
        "div",
        "favorites-empty",
        options.space
          ? "No saved command in this space."
          : "A tab in no space has the global ones.",
      ),
    );
  }

  if (menu.globals.length > 0) {
    root.append(line("GLOBAL"));
    const header = options.header();
    root.append(...menu.globals.map((f) => favoriteRow(f, header.includes(f.id))));
  }

  root.append(element("div", "favorites-rule"));
  root.append(
    action(PLUS_ICON, "New command…", NEW_COMMAND_HINT, () => {
      current?.close();
      options.save("");
    }),
  );
  const last = options.lastCommand;
  if (last && !store.has(last, space)) {
    const save = action(BOOKMARK_ICON, "Save last", "", () => {
      current?.close();
      options.save(last);
    });
    save.append(element("span", "favorites-last", last));
    root.append(save);
  }

  // Under the anchor, its right edge on the one of the anchor.
  const anchor = options.anchor.getBoundingClientRect();
  root.style.top = `${anchor.bottom + 6}px`;
  root.style.right = `${Math.max(8, window.innerWidth - anchor.right)}px`;
}

function line(text: string): HTMLElement {
  const row = element("div", "favorites-line");
  row.append(element("span", "favorites-line-rule"), element("span", "", text));
  row.append(element("span", "favorites-line-rule"));
  return row;
}

// A row at the bottom: a new command, the last one to save.
function action(icon: string, text: string, hint: string, onClick: () => void): HTMLElement {
  const row = element("div", "favorites-save");
  const mark = element("span", "favorites-plus");
  mark.innerHTML = icon;
  row.append(mark, element("span", "favorites-save-label", text));
  if (hint) row.append(element("span", "favorites-key", hint));
  row.addEventListener("click", onClick);
  return row;
}

function favoriteRow(favorite: Favorite, inHeader: boolean): HTMLElement {
  if (!current) throw new Error("no menu");
  const { options } = current;
  const global = favorite.space === null;
  const row = element("div", "favorites-row");
  row.classList.toggle("pinned", inHeader);
  row.classList.toggle("global", global);
  row.title = favorite.command;
  const mark = element("span", global ? "favorites-global" : "favorites-grip");
  mark.innerHTML = global ? GLOBAL_ICON : GRIP_ICON;
  mark.title = global
    ? "Global · the same everywhere"
    : "Drag to reorder · above the line = shortcut";
  const run = button("favorites-run", `Run ${favorite.command}`, PLAY_ICON);
  run.addEventListener("click", () => {
    current?.close();
    options.run(favorite);
  });
  const more = button("favorites-more", "More", MORE_ICON);
  more.addEventListener("click", () => moreMenu(favorite, inHeader, more));
  row.append(
    mark,
    element("b", "favorites-name", favorite.name),
    element("span", "favorites-command", favorite.command),
    run,
    more,
  );
  return row;
}

// What else can be done with a row: change it, make it global or of the
// space, put it in the header or take it out, delete it.
function moreMenu(favorite: Favorite, inHeader: boolean, anchor: HTMLElement): void {
  if (!current) return;
  const { options } = current;
  const { store } = options;
  const space = options.space;
  const fields = { name: favorite.name, command: favorite.command };
  const global = favorite.space === null;
  // A global one becomes of the space of the tab: a tab in no space has none to give.
  const rescope =
    global && !space
      ? []
      : [
          {
            label: global ? "Make it of the space" : "Make it global",
            icon: GLOBAL_ICON,
            onSelect: () => {
              store.update(favorite.id, { ...fields, space: global ? (space?.id ?? null) : null });
              toast(
                global
                  ? `"${favorite.name}" now holds only in ${space?.name}`
                  : `"${favorite.name}" is now global`,
              );
            },
          },
        ];
  const box = anchor.getBoundingClientRect();
  anchor.classList.add("open");
  openMenu({
    left: box.right - MORE_WIDTH,
    top: box.bottom + 4,
    width: MORE_WIDTH,
    over: true,
    items: [
      {
        label: "Edit…",
        icon: EDIT_ICON,
        onSelect: () => {
          current?.close();
          options.edit(favorite);
        },
      },
      ...rescope,
      {
        label: inHeader ? "Remove from shortcuts" : "Add to shortcuts",
        icon: PIN_ICON,
        onSelect: () => options.arrange(toggled(options.header(), favorite.id)),
      },
      {
        label: "Delete",
        icon: TRASH_ICON,
        danger: true,
        line: true,
        onSelect: () => store.remove(favorite),
      },
    ],
    onClose: () => anchor.classList.remove("open"),
  });
}

// Drags the row at `from` by its handle; on release the tab gets the header
// where it was dropped, the line counted as a row.
function press(rows: HTMLElement[], from: number, e: PointerEvent): void {
  if (e.button !== 0 || !current) return;
  e.preventDefault();
  const { options } = current;
  const space = options.space?.id ?? null;
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
    if (dragging) options.arrange(rearrange(options.store.list, space, options.header(), from, to));
  };
  grip.setPointerCapture(e.pointerId);
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}

function button(className: string, title: string, icon: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.title = title;
  node.innerHTML = icon;
  return node;
}

function element(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}
