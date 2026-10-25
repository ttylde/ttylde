import type { Status } from "./status";

/**
 * How long the pointer rests on a row before its card shows: moving across
 * the sidebar shows none. The settings will make it configurable (#43).
 */
export const PREVIEW_DELAY = 450;

/** How many lines of output the card shows. */
export const PREVIEW_LINES = 3;

/** How often, at most, an open card follows the output of its tab. */
const REFRESH_EVERY = 250;

/** What the card of a tab says. */
export type PreviewContent = {
  /** Its name, and the folder it works in. */
  title: string;
  status: Status;
  /** How the command went, as the dot says it; empty at the prompt. */
  statusText: string;
  /** The last command it ran, `null` when not known. */
  command: string | null;
  /** The last lines of the output of that command. */
  lines: string[];
};

export type PreviewOptions<T> = {
  /** What the card of `item` says now; `null`: it has none any more. */
  content(item: T): Promise<PreviewContent | null>;
  /** Where the card of the row goes, from the top left of the window. */
  place(row: HTMLElement, height: number): { left: number; top: number };
};

/**
 * The card next to the row the pointer rests on, over the terminal: what
 * the tab is doing without leaving the one shown. It takes no pointer
 * events, the row under it keeps them.
 */
export class Preview<T> {
  private item: T | null = null;
  private row: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private delay = 0;
  private refresh = 0;
  // Each card shown counts one more: an answer for an older one is late.
  private shown = 0;

  constructor(private options: PreviewOptions<T>) {}

  /** The pointer is on the row of `item`: its card shows after a while. */
  hover(item: T, row: HTMLElement): void {
    if (item === this.item) return;
    this.leave();
    this.item = item;
    this.row = row;
    this.delay = window.setTimeout(() => void this.render(), PREVIEW_DELAY);
  }

  /** The pointer left the row, or the row is busy otherwise: no card. */
  leave(): void {
    window.clearTimeout(this.delay);
    window.clearTimeout(this.refresh);
    this.refresh = 0;
    this.item = null;
    this.row = null;
    this.card?.remove();
    this.card = null;
    this.shown++;
  }

  /** `item` is gone: its card goes with it. */
  forget(item: T): void {
    if (item === this.item) this.leave();
  }

  /** What `item` shows changed: its card, if open, follows soon. */
  changed(item: T): void {
    if (item !== this.item || !this.card || this.refresh) return;
    this.refresh = window.setTimeout(() => {
      this.refresh = 0;
      void this.render();
    }, REFRESH_EVERY);
  }

  private async render(): Promise<void> {
    const { item, row } = this;
    if (item === null || !row) return;
    const shown = this.shown;
    const content = await this.options.content(item);
    if (shown !== this.shown) return;
    if (!content || !row.isConnected || row.hidden) {
      this.leave();
      return;
    }
    const card = previewCard(content);
    if (this.card) this.card.replaceWith(card);
    else document.body.append(card);
    this.card = card;
    const { left, top } = this.options.place(row, card.offsetHeight);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }
}

/** The card itself: name and state, the command, its last lines. */
export function previewCard(content: PreviewContent): HTMLElement {
  const card = element("div", "popover preview");
  const head = element("div", "preview-head");
  head.append(
    element("b", "preview-title", content.title),
    element("span", "preview-status", content.statusText),
  );
  head.lastElementChild?.setAttribute("data-status", content.status);
  card.append(head);
  if (content.command !== null) {
    card.append(element("div", "preview-command", `$ ${content.command}`));
  }
  for (const line of content.lines) card.append(element("div", "preview-line", line));
  if (content.lines.length === 0) card.append(element("div", "preview-empty", "No output"));
  const hints = element("div", "preview-hints");
  hints.append(element("span", "", "click · open"), element("span", "", "double-click · rename"));
  card.append(hints);
  return card;
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
