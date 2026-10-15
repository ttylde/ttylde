import { tildePath } from "./label";
import type { Space } from "./space";
import type { GitStatus } from "./types";

/** What the header says of the visible tab. */
export type HeaderView = {
  /** Where the tab belongs: a space, the pinned tabs, or none. */
  place: Space | "pinned" | null;
  /** What the tab is called, as the sidebar shows it. */
  title: string;
  git: GitStatus | null;
  /** The folder it works in, `null` until the core tells. */
  cwd: string | null;
};

export type HeaderOptions = {
  root: HTMLElement;
  /** The user's home, written `~` in the folder; `null` if not known. */
  home: string | null;
  /** The space is clicked with the sidebar collapsed: its menu opens. */
  onSpaceMenu(anchor: HTMLElement): void;
};

/**
 * The line above the terminal: the space of the visible tab, the tab, the
 * branch of its folder, the folder. The right end is kept for what comes
 * next (favorites, split buttons, status).
 *
 * With the sidebar collapsed the rail has no space name: the one here is
 * the button that opens the space menu.
 */
export class Header {
  private readonly space: HTMLButtonElement;
  private readonly spaceDot: HTMLElement;
  private readonly spaceName: HTMLElement;
  private readonly tab: HTMLElement;
  private readonly branch: HTMLElement;
  private readonly branchName: HTMLElement;
  private readonly branchMark: HTMLElement;
  private readonly folder: HTMLElement;

  constructor(private options: HeaderOptions) {
    const { root } = options;
    this.space = document.createElement("button");
    this.space.type = "button";
    this.space.className = "header-space";
    this.spaceDot = span("header-dot");
    this.spaceName = span("header-space-name");
    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("class", "header-chevron");
    chevron.setAttribute("viewBox", "0 0 10 6");
    chevron.setAttribute("width", "10");
    chevron.setAttribute("height", "6");
    chevron.innerHTML =
      '<path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" />';
    this.space.append(this.spaceDot, this.spaceName, chevron);

    const separator = span("header-separator", "›");
    this.tab = span("header-tab");

    this.branch = span("header-branch");
    const line = span("header-branch-line");
    const text = span("header-branch-text");
    this.branchName = span("header-branch-name");
    this.branchMark = span("header-branch-mark");
    text.append(span("header-branch-glyph", "⎇"), this.branchName, this.branchMark);
    this.branch.append(text, line);

    this.folder = span("header-folder");
    root.append(this.space, separator, this.tab, this.branch, this.folder);

    // The keyboard stays in the terminal.
    this.space.addEventListener("mousedown", (e) => e.preventDefault());
    this.space.addEventListener("click", () => {
      if (document.body.classList.contains("collapsed")) options.onSpaceMenu(this.space);
    });
  }

  /**
   * Shows what `view` says, or nothing with `null`: no tab. The line keeps
   * its place either way, so that the terminal under it keeps its size.
   */
  show(view: HeaderView | null): void {
    const { root, home } = this.options;
    root.classList.toggle("empty", view === null);
    if (!view) return;

    const { place } = view;
    const space = place !== null && place !== "pinned" ? place : null;
    this.spaceName.textContent = space?.name ?? (place === "pinned" ? "Pinned" : "No space");
    // The color is one of the palette, never text typed by someone.
    this.spaceDot.style.background = space?.color ?? "";
    this.space.classList.toggle("none", space === null);
    this.space.title = space?.name ?? "";

    this.tab.textContent = view.title;

    this.branch.hidden = view.git === null;
    if (view.git) {
      const { branch, dirty } = view.git;
      this.branchName.textContent = branch;
      this.branchMark.textContent = dirty ? "●" : "✓";
      this.branchMark.classList.toggle("dirty", dirty);
      this.branch.title = `${branch}: ${dirty ? "changes to commit" : "nothing to commit"}`;
    }

    this.folder.hidden = view.cwd === null;
    if (view.cwd !== null) {
      this.folder.textContent = tildePath(view.cwd, home);
      this.folder.title = view.cwd;
    }
  }

  /** The space menu opened from here is open: the button shows it. */
  setMenuOpen(open: boolean): void {
    this.space.classList.toggle("open", open);
  }
}

function span(className: string, text = ""): HTMLElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}
