export type MenuItem = {
  label: string;
  /** Markup written in this app (an icon, a dot) or a character, before the label. */
  icon: string;
  /** Said in small after the label: how many, how long ago. */
  meta?: string;
  /** The keys that do the same, at the end of the row. */
  hint?: string;
  /** The one the menu was opened from. */
  current?: boolean;
  /** Less to the eye than the choices above it. */
  quiet?: boolean;
  /** Drawn in red: the item takes something away. */
  danger?: boolean;
  /** A line above the item sets it apart from those before. */
  line?: boolean;
  onSelect(): void;
};

export type MenuOptions = {
  /** What the menu is about: shown at its top. */
  title?: string;
  /** Where the menu opens, in CSS pixels; it moves up if it would not fit. */
  left: number;
  top: number;
  /** In CSS pixels; a width of its own when left out. */
  width?: number;
  items: MenuItem[];
  /** The menu is gone, with or without a choice. */
  onClose(): void;
};

/** Distance between a menu and the edges of the window. */
const MARGIN = 8;

// One menu at a time: opening another closes the one that is there.
let close: (() => void) | null = null;

/** Whether a menu is open: the keyboard is its own while it is. */
export function isMenuOpen(): boolean {
  return close !== null;
}

/** Closes the menu without choosing, if it is open. */
export function closeMenu(): void {
  close?.();
}

/** Opens a menu of things to choose from. */
export function openMenu(options: MenuOptions): void {
  closeMenu();
  const listeners = new AbortController();
  const { signal } = listeners;

  // Covers the window: a click anywhere else closes the menu.
  const backdrop = document.createElement("div");
  backdrop.className = "popover-backdrop";
  const menu = document.createElement("div");
  menu.className = "popover menu";
  if (options.width !== undefined) menu.style.width = `${options.width}px`;

  if (options.title !== undefined) {
    const title = document.createElement("div");
    title.className = "menu-title";
    title.textContent = options.title;
    menu.append(title);
  }

  function dismiss(): void {
    close = null;
    listeners.abort();
    backdrop.remove();
    menu.remove();
    options.onClose();
  }

  for (const item of options.items) {
    if (item.line) {
      const line = document.createElement("div");
      line.className = "menu-line";
      menu.append(line);
    }
    const row = document.createElement("button");
    row.type = "button";
    row.className = "menu-item";
    row.classList.toggle("current", item.current ?? false);
    row.classList.toggle("quiet", item.quiet ?? false);
    row.classList.toggle("danger", item.danger ?? false);

    const icon = document.createElement("span");
    icon.className = "menu-icon";
    // Markup written in this app, never text that comes from outside.
    icon.innerHTML = item.icon;
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = item.label;
    row.append(icon, label);
    for (const [className, text] of [
      ["menu-meta", item.meta],
      ["menu-hint", item.hint],
    ]) {
      if (text === undefined) continue;
      const part = document.createElement("span");
      part.className = className ?? "";
      part.textContent = text;
      row.append(part);
    }

    row.addEventListener("click", () => {
      dismiss();
      item.onSelect();
    });
    menu.append(row);
  }

  backdrop.addEventListener("mousedown", dismiss);
  // The focus stays where it was: the menu is used with the pointer.
  menu.addEventListener("mousedown", (e) => e.preventDefault());
  // Nothing typed while the menu is open reaches the terminal.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") dismiss();
    },
    { capture: true, signal },
  );

  document.body.append(backdrop, menu);
  const lowest = window.innerHeight - menu.offsetHeight - MARGIN;
  menu.style.left = `${options.left}px`;
  menu.style.top = `${Math.max(MARGIN, Math.min(options.top, lowest))}px`;
  close = dismiss;
}
