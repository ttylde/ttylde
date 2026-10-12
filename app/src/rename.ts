import { COLORS, cleanName, ICONS, type Look, popoverTop } from "./look";

export type RenameOptions = {
  /** The row being edited: the popover opens next to it. */
  row: DOMRect;
  /** Left edge of the popover, in CSS pixels. */
  left: number;
  look: Look;
  /** Shown while the name is empty: what the tab is called without one. */
  placeholder: string;
  onSave(look: Look): void;
  /** The popover is gone, saved or not. */
  onClose(): void;
};

// One popover at a time: opening another closes the one that is there.
let close: (() => void) | null = null;

/** Whether the popover is open: the keyboard is its own while it is. */
export function isRenaming(): boolean {
  return close !== null;
}

/** Closes the popover without saving, if it is open. */
export function closeRename(): void {
  close?.();
}

/** Opens the popover that edits name, color and icon of a tab. */
export function openRename(options: RenameOptions): void {
  closeRename();
  const draft = { color: options.look.color, icon: options.look.icon };
  const listeners = new AbortController();
  const { signal } = listeners;

  // Covers the window: a click anywhere else cancels.
  const backdrop = document.createElement("div");
  backdrop.className = "rename-backdrop";
  const popover = document.createElement("div");
  popover.className = "rename";

  const input = document.createElement("input");
  input.className = "rename-name";
  input.value = options.look.name ?? "";
  input.placeholder = options.placeholder;
  input.maxLength = 64;
  input.spellcheck = false;

  const colors = document.createElement("div");
  colors.className = "rename-colors";
  const swatches = COLORS.map((color) => {
    const swatch = button("rename-color", "");
    swatch.style.background = color;
    swatch.addEventListener("click", () => {
      draft.color = color;
      show();
    });
    return { color, swatch };
  });
  colors.append(...swatches.map(({ swatch }) => swatch));

  const icons = document.createElement("div");
  icons.className = "rename-icons";
  const glyphs = ICONS.map((icon) => {
    const glyph = button("rename-icon", icon);
    glyph.addEventListener("click", () => {
      draft.icon = icon;
      show();
    });
    return { icon, glyph };
  });
  icons.append(...glyphs.map(({ glyph }) => glyph));

  const actions = document.createElement("div");
  actions.className = "rename-actions";
  const cancel = button("rename-cancel", "Cancel");
  const save = button("rename-save", "Save");
  actions.append(cancel, save);

  popover.append(input, colors, icons, actions);

  function show(): void {
    // The icons are drawn in the color being picked.
    popover.style.setProperty("--tab-color", draft.color);
    for (const { color, swatch } of swatches) {
      swatch.classList.toggle("picked", color === draft.color);
    }
    for (const { icon, glyph } of glyphs) glyph.classList.toggle("picked", icon === draft.icon);
  }

  function dismiss(): void {
    close = null;
    listeners.abort();
    backdrop.remove();
    popover.remove();
    options.onClose();
  }

  function confirm(): void {
    const look = { name: cleanName(input.value), ...draft };
    dismiss();
    options.onSave(look);
  }

  backdrop.addEventListener("mousedown", dismiss);
  cancel.addEventListener("click", dismiss);
  save.addEventListener("click", confirm);
  // Picking a color must not take the focus away from the name.
  popover.addEventListener("mousedown", (e) => {
    if (e.target !== input) e.preventDefault();
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") confirm();
    else if (e.key === "Escape") dismiss();
  });
  // The window gives the focus back to the terminal: here it is the name's.
  window.addEventListener("focus", () => input.focus(), { signal });

  show();
  document.body.append(backdrop, popover);
  popover.style.left = `${options.left}px`;
  popover.style.top = `${popoverTop(options.row.top, popover.offsetHeight, window.innerHeight)}px`;
  close = dismiss;
  input.focus();
}

function button(className: string, text: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  return element;
}
