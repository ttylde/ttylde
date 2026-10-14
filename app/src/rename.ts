import { button, closeForm, nameField, openForm, row, swatches } from "./form";
import { COLOR_ROWS, cleanName, ICONS, iconMarkup, type Look, popoverTop } from "./look";

export type RenameOptions = {
  /** The row being edited: the form opens next to it. */
  row: DOMRect;
  /** Left edge of the form, in CSS pixels. */
  left: number;
  look: Look;
  /** Shown while the name is empty: what the tab is called without one. */
  placeholder: string;
  /** Every change, as it is made: there is nothing to confirm. */
  onChange(look: Look): void;
  /** The form is gone. */
  onClose(): void;
};

/**
 * Opens the form that edits name, color and icon of a tab. What is picked
 * shows on the tab at once; Enter, Esc or a click elsewhere close the form.
 */
export function openRename(options: RenameOptions): void {
  const look = { ...options.look };
  const field = nameField(look.name ?? "", options.placeholder);
  function change(): void {
    options.onChange({ ...look });
  }
  field.addEventListener("input", () => {
    look.name = cleanName(field.value);
    change();
  });

  const glyphs = ICONS.map((icon) => {
    const glyph = button("glyph", "");
    glyph.title = icon;
    // Markup of the icons shipped with the app.
    glyph.innerHTML = iconMarkup(icon);
    glyph.addEventListener("click", () => {
      look.icon = icon;
      showIcon();
      change();
    });
    return { icon, glyph };
  });
  const icons = row("glyphs", ...glyphs.map(({ glyph }) => glyph));
  function showIcon(): void {
    for (const { icon, glyph } of glyphs) glyph.classList.toggle("picked", icon === look.icon);
  }
  showIcon();

  let started = false;
  const colors = swatches(COLOR_ROWS, look.color, (color) => {
    look.color = color;
    // The icons are drawn in the color being picked.
    icons.style.setProperty("--tab-color", color);
    // The first call only shows the color the tab has.
    if (started) change();
  });
  started = true;

  openForm({
    className: "rename",
    left: options.left,
    top: (height) => popoverTop(options.row.top, height, window.innerHeight),
    field,
    content: [field, colors, icons],
    onSubmit: closeForm,
    onClose: options.onClose,
  });
}
