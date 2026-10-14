import {
  button,
  closeForm,
  labelled,
  nameField,
  openForm,
  row,
  segmented,
  swatches,
  textField,
} from "./form";
import { cleanName } from "./look";
import { SHELLS, SPACE_COLORS, type Space, type SpaceChanges, tabCount } from "./space";

export type SpaceSettingsOptions = {
  space: Space;
  /** How many tabs the space has: deleting it closes them. */
  tabs: number;
  /** Where the form opens, in CSS pixels. */
  left: number;
  top: number;
  onSave(changes: SpaceChanges): void;
  onDelete(): void;
  /** The form is gone, whatever was done with it. */
  onClose(): void;
};

/** Distance between the form and the bottom of the window. */
const MARGIN = 8;

/** Opens the form that edits a space, or deletes it. */
export function openSpaceSettings(options: SpaceSettingsOptions): void {
  const { space } = options;
  let color = space.color;
  const field = nameField(space.name, space.name);
  const colors = swatches([SPACE_COLORS], color, (picked) => {
    color = picked;
  });
  const folder = textField(space.folder, "~");
  let shell = space.shell;
  const shells = segmented(
    [{ label: "System", value: null }, ...SHELLS.map((name) => ({ label: name, value: name }))],
    shell,
    (picked) => {
      shell = picked;
    },
  );

  // Deleting closes sessions that may be at work: it asks once more.
  const remove = button("danger", "Delete space");
  let asked = false;
  remove.addEventListener("click", () => {
    if (!asked) {
      asked = true;
      remove.textContent = `Close ${tabCount(options.tabs)}?`;
      remove.classList.add("asked");
      return;
    }
    closeForm();
    options.onDelete();
  });

  const cancel = button("ghost", "Cancel");
  const save = button("primary", "Save");
  function confirm(): void {
    // A space always has a name: an empty field leaves the one it had.
    const name = cleanName(field.value) ?? space.name;
    // An empty folder is the home, where a shell starts anyway.
    const where = folder.value.trim() || "~";
    closeForm();
    options.onSave({ name, color, folder: where, shell });
  }
  cancel.addEventListener("click", closeForm);
  save.addEventListener("click", confirm);

  openForm({
    className: "space-settings",
    left: options.left,
    top: (height) => Math.max(MARGIN, Math.min(options.top, window.innerHeight - height - MARGIN)),
    field,
    content: [
      field,
      colors,
      labelled("Folder of new tabs", folder),
      labelled("Shell", shells),
      row("form-actions", remove, cancel, save),
    ],
    onSubmit: confirm,
    onClose: options.onClose,
  });
  field.select();
}
