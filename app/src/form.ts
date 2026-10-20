import { CHECK_ICON } from "./icons";

// The small forms that open over the window: the one that renames a tab,
// the settings of a space. One at a time, each with a field for a name.

export type FormOptions = {
  /** Added to the class of the popover, to style what is in it. */
  className: string;
  /** Left edge of the form, in CSS pixels. */
  left: number;
  /** Where its top goes, once its height is known. */
  top(height: number): number;
  /** The field that has the focus when the form opens. */
  field: HTMLInputElement;
  /** What the form holds, its fields included, from top to bottom. */
  content: HTMLElement[];
  /** Enter in one of its fields: the form is done. */
  onSubmit(): void;
  /** The form is gone, submitted or not. */
  onClose(): void;
};

// Opening a form closes the one that is there.
let close: (() => void) | null = null;

/** Whether a form is open: the keyboard is its own while it is. */
export function isFormOpen(): boolean {
  return close !== null;
}

/** Closes the form without submitting, if one is open. */
export function closeForm(): void {
  close?.();
}

/** Opens a form and gives the focus to its field. */
export function openForm(options: FormOptions): void {
  closeForm();
  const { field } = options;
  const listeners = new AbortController();
  const { signal } = listeners;

  // Covers the window: a click anywhere else cancels.
  const backdrop = document.createElement("div");
  backdrop.className = "popover-backdrop";
  const form = document.createElement("div");
  form.className = `popover form ${options.className}`;
  form.append(...options.content);

  function dismiss(): void {
    close = null;
    listeners.abort();
    backdrop.remove();
    form.remove();
    options.onClose();
  }

  backdrop.addEventListener("mousedown", dismiss);
  // A click on a button must not take the focus away from the fields.
  form.addEventListener("mousedown", (e) => {
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
  });
  form.addEventListener("keydown", (e) => {
    if (e.isComposing || !(e.target instanceof HTMLInputElement)) return;
    if (e.key === "Enter") options.onSubmit();
    else if (e.key === "Escape") dismiss();
  });
  // The window gives the focus back to the terminal: here it is the form's.
  let focused = field;
  form.addEventListener("focusin", (e) => {
    if (e.target instanceof HTMLInputElement) focused = e.target;
  });
  window.addEventListener("focus", () => focused.focus(), { signal });

  document.body.append(backdrop, form);
  form.style.left = `${options.left}px`;
  form.style.top = `${options.top(form.offsetHeight)}px`;
  close = dismiss;
  field.focus();
}

/** The field for a name. */
export function nameField(value: string, placeholder: string): HTMLInputElement {
  const field = document.createElement("input");
  field.className = "field";
  field.value = value;
  field.placeholder = placeholder;
  field.spellcheck = false;
  field.maxLength = 64;
  return field;
}

export function button(className: string, text: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  return element;
}

/** A row of things laid side by side. */
export function row(className: string, ...children: HTMLElement[]): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.append(...children);
  return element;
}

/**
 * Rows of colors to pick one from. `onPick` is called with the one picked,
 * and once at the start with `picked`.
 */
export function swatches(
  rows: string[][],
  picked: string,
  onPick: (color: string) => void,
): HTMLElement {
  const buttons = rows.map((colors) =>
    colors.map((color) => {
      const swatch = button("swatch", "");
      swatch.style.background = color;
      // The ring of the one picked is in its own color.
      swatch.style.setProperty("--swatch", color);
      swatch.innerHTML = CHECK_ICON;
      swatch.title = color;
      swatch.addEventListener("click", () => pick(color));
      return { color, swatch };
    }),
  );

  function pick(color: string): void {
    for (const each of buttons.flat()) each.swatch.classList.toggle("picked", each.color === color);
    onPick(color);
  }

  pick(picked);
  return row(
    "swatch-rows",
    ...buttons.map((line) => row("swatches", ...line.map(({ swatch }) => swatch))),
  );
}
