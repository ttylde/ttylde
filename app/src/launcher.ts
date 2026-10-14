import { ago } from "./space";
import type { ClosedSpace } from "./tabs";

export type LauncherOptions = {
  /** Where the launcher is drawn: it fills it while no space is open. */
  root: HTMLElement;
  /** A closed space is asked for, by its position among every space. */
  onOpen(index: number): void;
  /** A new space with one tab in it. */
  onNew(): void;
  /** A command typed in the prompt: it runs in a new space. */
  onRun(command: string): void;
};

/**
 * What the terminal area shows when no space is open: the space to resume,
 * the other closed ones, a new session, and a prompt that already has the
 * keyboard.
 */
export class Launcher {
  private readonly list: HTMLElement;
  private readonly input: HTMLInputElement;
  // The space Enter resumes when nothing is typed.
  private last: ClosedSpace | null = null;

  constructor(private options: LauncherOptions) {
    const { root } = options;
    this.list = document.createElement("div");
    this.list.className = "launcher-spaces";

    const prompt = document.createElement("label");
    prompt.className = "launcher-prompt";
    const sign = document.createElement("span");
    sign.className = "launcher-sign";
    sign.innerHTML = '<span class="arrow">➜</span> <b>~</b> ';
    this.input = document.createElement("input");
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.input.placeholder = "Type a command: a session starts here, no click needed";
    prompt.append(sign, this.input);

    this.input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const command = this.input.value.trim();
      if (command) options.onRun(command);
      else if (this.last) options.onOpen(this.last.index);
      else options.onNew();
    });
    // A click anywhere but on a choice puts the keyboard back in the prompt.
    root.addEventListener("mousedown", (e) => {
      if (e.target !== this.input) e.preventDefault();
    });
    root.addEventListener("click", () => this.input.focus());

    root.append(this.list, prompt);
  }

  /** Whether it is the one shown. */
  get visible(): boolean {
    return !this.options.root.hidden;
  }

  /** Shows the launcher with `spaces`, the one to resume first. */
  show(spaces: ClosedSpace[]): void {
    const { root } = this.options;
    const now = Date.now();
    const [last, ...others] = spaces;
    this.last = last ?? null;
    this.list.replaceChildren();

    if (last) {
      this.list.append(
        heading("Resume where you were"),
        this.card(last, now),
        line(),
        heading("Other spaces"),
      );
    }
    const rows = document.createElement("div");
    rows.className = "launcher-rows";
    for (const closed of others) {
      const row = choice("launcher-row", () => this.options.onOpen(closed.index));
      row.append(
        dot(closed.space.color),
        bold(closed.space.name),
        text("launcher-tabs", closed.tabs.join(" · ")),
        text("launcher-ago", ago(closed.closedAt, now)),
        text("launcher-go", "›"),
      );
      rows.append(row);
    }
    const fresh = choice("launcher-row launcher-new", () => this.options.onNew());
    fresh.append(text("launcher-plus", "+"), bold("New session"), text("launcher-tabs", "~"));
    rows.append(fresh);
    this.list.append(rows);

    this.input.value = "";
    root.hidden = false;
    this.focus();
  }

  hide(): void {
    this.options.root.hidden = true;
  }

  /** Gives the keyboard to the prompt, if the launcher is shown. */
  focus(): void {
    if (this.visible) this.input.focus();
  }

  // The space to resume, larger than the others, with its button.
  private card(last: ClosedSpace, now: number): HTMLElement {
    const card = document.createElement("div");
    card.className = "launcher-card";
    const title = document.createElement("div");
    title.className = "launcher-title";
    title.append(
      dot(last.space.color),
      text("launcher-name", last.space.name),
      text("launcher-ago", `closed ${ago(last.closedAt, now)} ago`),
    );
    const resume = choice("launcher-resume", () => this.options.onOpen(last.index));
    resume.textContent = "Resume ↵";
    card.append(title, text("launcher-tabs", last.tabs.join(" · ")), resume);
    return card;
  }
}

function heading(label: string): HTMLElement {
  return text("launcher-heading", label);
}

function line(): HTMLElement {
  return text("launcher-line", "");
}

function dot(color: string): HTMLElement {
  const element = text("dot", "");
  element.style.background = color;
  return element;
}

function bold(label: string): HTMLElement {
  const element = document.createElement("b");
  element.textContent = label;
  return element;
}

function text(className: string, content: string): HTMLElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = content;
  return element;
}

function choice(className: string, onChoose: () => void): HTMLElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `launcher-choice ${className}`;
  element.addEventListener("click", (e) => {
    // The click on the launcher would take the keyboard back to the prompt.
    e.stopPropagation();
    onChoose();
  });
  return element;
}
