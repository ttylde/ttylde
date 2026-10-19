import { type Favorite, guessName } from "./favorites";
import { BOOKMARK_ICON } from "./icons";

export type SaveCommandOptions = {
  /** The command to save; empty: the user writes one. */
  command: string;
  /** The space of the tab; `null`: none, it can only hold everywhere. */
  space: { id: number; name: string } | null;
  onSave(favorite: Favorite): void;
  /** The dialog is gone, saved or not. */
  onClose(): void;
};

let open: { close(): void } | null = null;

export function isSaveCommandOpen(): boolean {
  return open !== null;
}

/**
 * The dialog that saves a command: the command, its name (guessed from the
 * command until the user writes one), and where it holds, this space or
 * everywhere. Enter saves, Escape or a click outside does not.
 */
export function openSaveCommand(options: SaveCommandOptions): void {
  open?.close();
  const backdrop = div("save-backdrop");
  const panel = div("save-command");
  const title = div("save-title");
  const icon = document.createElement("span");
  icon.className = "save-icon";
  icon.innerHTML = BOOKMARK_ICON;
  const heading = document.createElement("b");
  heading.textContent = options.command ? "Save command" : "New saved command";
  title.append(icon, heading);

  const command = field("e.g. docker compose up -d", options.command);
  command.classList.add("save-command-field");
  const commandBox = div("save-box");
  const dollar = document.createElement("span");
  dollar.className = "save-dollar";
  dollar.textContent = "$";
  commandBox.append(dollar, command);

  const name = field("e.g. Dev, Test, Migrate", guessName(options.command));
  let named = false;
  command.addEventListener("input", () => {
    if (!named) name.value = guessName(command.value);
  });
  name.addEventListener("input", () => {
    named = true;
  });

  let everywhere = options.space === null;
  const where = div("save-segments");
  const choices: [boolean, string][] = [
    [false, options.space ? `This space · ${options.space.name}` : "This space"],
    [true, "Everywhere"],
  ];
  const segments = choices.map(([value, label]) => {
    const segment = document.createElement("button");
    segment.type = "button";
    segment.className = "save-segment";
    segment.textContent = label;
    segment.disabled = !value && options.space === null;
    segment.addEventListener("click", () => {
      everywhere = value;
      paint();
    });
    where.append(segment);
    return { segment, value };
  });
  const paint = () => {
    for (const { segment, value } of segments)
      segment.classList.toggle("current", value === everywhere);
  };
  paint();

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "save-cancel";
  cancel.textContent = "Cancel";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "save-confirm";
  confirm.textContent = "Save ↵";
  const actions = div("save-actions");
  actions.append(cancel, confirm);

  panel.append(
    title,
    labelled("Command", commandBox),
    labelled("Name", name),
    labelled("Holds in", where),
    actions,
  );
  document.body.append(backdrop, panel);

  const close = () => {
    backdrop.remove();
    panel.remove();
    open = null;
    options.onClose();
  };
  const save = () => {
    const text = command.value.trim();
    if (!text) {
      command.focus();
      return;
    }
    const favorite: Favorite = {
      name: name.value.trim() || guessName(text),
      command: text,
      space: everywhere ? null : (options.space?.id ?? null),
      pinned: false,
    };
    close();
    options.onSave(favorite);
  };
  open = { close };
  backdrop.addEventListener("mousedown", (e) => {
    e.preventDefault();
    close();
  });
  cancel.addEventListener("click", close);
  confirm.addEventListener("click", save);
  panel.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  (options.command ? name : command).focus();
  (options.command ? name : command).select();
}

function div(className: string): HTMLElement {
  const node = document.createElement("div");
  node.className = className;
  return node;
}

function field(placeholder: string, value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "save-field";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = placeholder;
  input.value = value;
  return input;
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const row = div("save-row");
  const label = document.createElement("span");
  label.className = "save-label";
  label.textContent = text;
  row.append(label, control);
  return row;
}
