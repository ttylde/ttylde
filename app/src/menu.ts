import { popoverTop } from "./look";

export type MenuItem = {
  label: string;
  /** SVG markup or a character, shown before the label. */
  icon: string;
  /** Drawn in red: the item takes something away. */
  danger?: boolean;
  onSelect(): void;
};

export type MenuOptions = {
  /** What the menu is about: shown at its top. */
  title: string;
  /** The row the menu belongs to: it opens next to it. */
  row: DOMRect;
  /** Left edge of the menu, in CSS pixels. */
  left: number;
  items: MenuItem[];
  /** The menu is gone, with or without a choice. */
  onClose(): void;
};

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

/** Opens a menu of actions on a row of the sidebar. */
export function openMenu(options: MenuOptions): void {
  closeMenu();
  const listeners = new AbortController();
  const { signal } = listeners;

  // Covers the window: a click anywhere else closes the menu.
  const backdrop = document.createElement("div");
  backdrop.className = "popover-backdrop";
  const menu = document.createElement("div");
  menu.className = "popover menu";

  const title = document.createElement("div");
  title.className = "menu-title";
  title.textContent = options.title;
  menu.append(title);

  function dismiss(): void {
    close = null;
    listeners.abort();
    backdrop.remove();
    menu.remove();
    options.onClose();
  }

  for (const item of options.items) {
    if (item.danger) {
      const line = document.createElement("div");
      line.className = "menu-line";
      menu.append(line);
    }
    const row = document.createElement("button");
    row.type = "button";
    row.className = item.danger ? "menu-item danger" : "menu-item";
    const icon = document.createElement("span");
    icon.className = "menu-icon";
    // Markup written in this app, never text that comes from outside.
    icon.innerHTML = item.icon;
    row.append(icon, item.label);
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
  menu.style.left = `${options.left}px`;
  menu.style.top = `${popoverTop(options.row.top, menu.offsetHeight, window.innerHeight, 6)}px`;
  close = dismiss;
}
