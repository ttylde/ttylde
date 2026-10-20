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
  /** The folder of the tab, under its name; `null`: not known. */
  cwd: string | null;
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
  // On top, the tab as it will look: its icon, big, its name and its folder.
  const preview = element("span", "rename-preview");
  const folder = element("span", "rename-folder", options.cwd ?? "");
  folder.title = options.cwd ?? "";
  const head = row("rename-head", preview, row("rename-name", field, folder));
  const colorValue = element("span", "rename-value");
  const iconValue = element("span", "rename-value");
  function show(): void {
    head.style.setProperty("--tab-color", look.color);
    preview.innerHTML = iconMarkup(look.icon);
    colorValue.textContent = look.color;
    iconValue.textContent = look.icon;
  }
  function change(): void {
    show();
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
    // The icon picked is drawn in the color being picked.
    icons.style.setProperty("--tab-color", color);
    // The first call only shows the color the tab has.
    if (started) change();
  });
  started = true;
  show();

  openForm({
    className: "rename",
    left: options.left,
    top: (height) => popoverTop(options.row.top, height, window.innerHeight),
    field,
    content: [
      head,
      row("rename-body", section("Color", colorValue, colors), section("Icon", iconValue, icons)),
    ],
    onSubmit: closeForm,
    onClose: options.onClose,
  });
}

// A part of the form: its title and the value picked, then the choices.
function section(title: string, value: HTMLElement, choices: HTMLElement): HTMLElement {
  return row("rename-section", row("rename-label", element("span", "", title), value), choices);
}

function element(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
