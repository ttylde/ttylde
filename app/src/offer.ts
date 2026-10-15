export type OfferOptions = {
  /** Where the banner is drawn: over the top of the terminal. */
  root: HTMLElement;
  /** Enter, or a click on the banner: the command starts again. */
  onAccept(): void;
  /** The ×: the tab stays at its prompt. */
  onDismiss(): void;
};

/**
 * The banner a resumed tab shows when a command was running in it when it
 * closed: Enter starts it again, any other key leaves the tab at its prompt.
 * Nothing starts again by itself unless the config file says so.
 */
export class OfferBanner {
  private readonly command: HTMLElement;

  constructor(private options: OfferOptions) {
    const { root } = options;
    const text = document.createElement("span");
    text.className = "offer-text";
    text.textContent = "Run again";
    this.command = document.createElement("code");
    this.command.className = "offer-command";
    const enter = document.createElement("span");
    enter.className = "offer-key";
    enter.textContent = "↵";
    const dismiss = document.createElement("button");
    dismiss.className = "offer-dismiss";
    dismiss.type = "button";
    dismiss.title = "Leave it at the prompt";
    dismiss.textContent = "×";
    root.append(text, this.command, enter, dismiss);

    // The keyboard stays in the terminal.
    root.addEventListener("mousedown", (e) => e.preventDefault());
    root.addEventListener("click", () => options.onAccept());
    dismiss.addEventListener("click", (e) => {
      e.stopPropagation();
      options.onDismiss();
    });
  }

  /** Whether it is the one shown. */
  get visible(): boolean {
    return !this.options.root.hidden;
  }

  /** Shows the banner for `command`, or hides it with `null`. */
  show(command: string | null): void {
    const { root } = this.options;
    root.hidden = command === null;
    if (command === null) return;
    this.command.textContent = command;
    root.title = command;
  }
}
