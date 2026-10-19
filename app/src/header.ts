import type { Favorite } from "./favorites";
import { BOOKMARK_ICON, BRANCH_ICON, FOLDER_ICON, PLAY_ICON } from "./icons";
import { folderName } from "./label";
import type { Space } from "./space";
import { describe, shown, type TabStatus } from "./status";
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
  status: TabStatus;
  /** The saved commands of the folder in the header, in their order. */
  favorites: Favorite[];
  /** The command running in the tab, if one is: its chip is tinted. */
  running: string | null;
};

export type HeaderOptions = {
  root: HTMLElement;
  /** The space is clicked with the sidebar collapsed: its menu opens. */
  onSpaceMenu(anchor: HTMLElement): void;
  /** A chip of a saved command: it runs in the tab. */
  onRunFavorite(favorite: Favorite): void;
  /** The button next to the chips: the menu of the saved commands opens. */
  onFavoritesMenu(anchor: HTMLElement): void;
};

/**
 * The line above the terminal: the space of the visible tab, the tab, then
 * the folder it works in and the branch of that folder, then the saved
 * commands of that folder in the header, and the button of their menu. The
 * right end is kept for what comes next (split buttons).
 *
 * With the sidebar collapsed the rail has no space name: the one here is
 * the button that opens the space menu.
 */
export class Header {
  /** The space: with the sidebar collapsed, the button of the space menu. */
  readonly spaceButton: HTMLButtonElement;
  private readonly spaceDot: HTMLElement;
  private readonly spaceName: HTMLElement;
  private readonly tab: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly folder: HTMLElement;
  private readonly folderName: HTMLElement;
  private readonly branch: HTMLElement;
  private readonly branchName: HTMLElement;
  private readonly changes: HTMLElement;
  private readonly chips: HTMLElement;
  /** Opens the menu of the saved commands. */
  readonly favoritesButton: HTMLButtonElement;
  // The whole path of the folder, which a click copies.
  private cwd: string | null = null;

  constructor(private options: HeaderOptions) {
    const { root } = options;
    this.spaceButton = document.createElement("button");
    this.spaceButton.type = "button";
    this.spaceButton.className = "header-space";
    this.spaceDot = span("header-dot");
    this.spaceName = span("header-space-name");
    const chevron = span("header-chevron");
    chevron.innerHTML =
      '<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>';
    this.spaceButton.append(this.spaceDot, this.spaceName, chevron);

    this.tab = span("header-tab");
    this.dot = span("status-dot header-status");

    this.folder = span("header-chip header-folder");
    this.folderName = span("header-chip-text");
    this.folder.append(icon(FOLDER_ICON), this.folderName);

    this.branch = span("header-chip header-branch");
    this.branchName = span("header-chip-text");
    this.changes = span("header-changes");
    this.branch.append(icon(BRANCH_ICON), this.branchName, this.changes);

    const where = span("header-where");
    where.append(this.folder, this.branch);

    this.chips = span("header-chips");
    this.favoritesButton = document.createElement("button");
    this.favoritesButton.type = "button";
    this.favoritesButton.className = "header-favorites-button";
    this.favoritesButton.title = "Saved commands of this folder";
    this.favoritesButton.innerHTML = BOOKMARK_ICON;
    const favorites = span("header-favorites");
    favorites.append(this.chips, this.favoritesButton);

    root.append(
      this.spaceButton,
      span("header-separator", "›"),
      this.tab,
      this.dot,
      span("header-rule"),
      where,
      span("header-rule"),
      favorites,
    );

    // The keyboard stays in the terminal.
    for (const button of [this.spaceButton, this.folder, this.favoritesButton]) {
      button.addEventListener("mousedown", (e) => e.preventDefault());
    }
    this.spaceButton.addEventListener("click", () => {
      if (document.body.classList.contains("collapsed")) options.onSpaceMenu(this.spaceButton);
    });
    this.folder.addEventListener("click", () => {
      if (this.cwd !== null) copy(this.cwd);
    });
    this.favoritesButton.addEventListener("click", () =>
      options.onFavoritesMenu(this.favoritesButton),
    );
  }

  /**
   * Shows what `view` says, or nothing with `null`: no tab. The line keeps
   * its place either way, so that the terminal under it keeps its size.
   */
  show(view: HeaderView | null): void {
    this.options.root.classList.toggle("empty", view === null);
    if (!view) return;

    const { place } = view;
    const space = place !== null && place !== "pinned" ? place : null;
    this.spaceName.textContent = space?.name ?? (place === "pinned" ? "Pinned" : "No space");
    // The color is one of the palette, never text typed by someone.
    this.spaceDot.style.background = space?.color ?? "";
    this.spaceButton.classList.toggle("none", space === null);
    this.spaceButton.title = space ? "Switch space (⌃1…9)" : "";

    this.tab.textContent = view.title;
    this.dot.dataset.status = shown(view.status, Date.now());
    this.dot.title = describe(view.status, Date.now());

    this.cwd = view.cwd;
    this.folder.hidden = view.cwd === null;
    if (view.cwd !== null) {
      this.folderName.textContent = folderName(view.cwd);
      this.folder.title = `${view.cwd} · click to copy the path`;
    }

    this.branch.hidden = view.git === null;
    if (view.git) {
      const { branch, dirty } = view.git;
      this.branchName.textContent = branch;
      // `main*`: changes to commit, as prompts and editors write it.
      this.changes.textContent = dirty ? "*" : "";
      this.branch.title = `${branch}: ${dirty ? "changes to commit" : "nothing to commit"}`;
    }

    this.chips.replaceChildren(
      ...view.favorites.map((favorite) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "header-chip-favorite";
        chip.classList.toggle("running", favorite.command === view.running);
        chip.title = favorite.command;
        const play = span("header-play");
        play.innerHTML = PLAY_ICON;
        chip.append(play, favorite.name);
        chip.addEventListener("mousedown", (e) => e.preventDefault());
        chip.addEventListener("click", () => this.options.onRunFavorite(favorite));
        return chip;
      }),
    );
  }

  /** The menu of the saved commands is open: the button shows it. */
  setFavoritesOpen(open: boolean): void {
    this.favoritesButton.classList.toggle("open", open);
  }

  /** The space menu opened from here is open: the button shows it. */
  setMenuOpen(open: boolean): void {
    this.spaceButton.classList.toggle("open", open);
  }
}

function span(className: string, text = ""): HTMLElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

function icon(markup: string): HTMLElement {
  const element = span("header-icon");
  element.innerHTML = markup;
  return element;
}

// Puts `text` on the clipboard. A click is enough for the webview to allow it.
function copy(text: string): void {
  navigator.clipboard.writeText(text).catch((error) => {
    console.error("ttylde: cannot copy the path", error);
  });
}
