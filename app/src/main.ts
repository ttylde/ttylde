import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { isFormOpen } from "./form";
import { Header } from "./header";
import { SIDEBAR_ICON } from "./icons";
import { attachKeyboard } from "./input";
import { Launcher } from "./launcher";
import { isMenuOpen, openMenu } from "./menu";
import { OfferBanner } from "./offer";
import { fontStack } from "./renderer";
import { actionOf, NEW_TAB_HINT } from "./shortcuts";
import { ago, tabCount } from "./space";
import { openSpaceSettings } from "./space-settings";
import { defaultTitle, type Tab, titleOf } from "./tab";
import { Tabs } from "./tabs";
import type { Font, SavedState } from "./types";

// The elements of index.html the app is built on: one missing is a bug in
// the page, not something to recover from.
function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`index.html has no ${selector}`);
  return found;
}

const sidebar = element("#sidebar");
const list = element("#tabs");
const pinned = element("#pinned");
const newTab = element("#new-tab");
const toggle = element("#toggle-sidebar");
// The space that is shown, by name over the tabs and as a dot in the rail.
const spaceName = element("#space");
const spaceDot = element("#space-dot");
const closeSpace = element("#close-space");
const terminal = element("#terminal");
const screens = element("#screens");
const appWindow = getCurrentWindow();
const DEFAULT_TITLE = "Ttylde";

// The sidebar as a rail of two-letter labels. The choice is remembered, but
// the app works the same where the storage is not available.
const COLLAPSED_KEY = "sidebar-collapsed";
function isCollapsed(): boolean {
  return document.body.classList.contains("collapsed");
}
function showCollapsed(collapsed: boolean): void {
  document.body.classList.toggle("collapsed", collapsed);
  toggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
}
function setCollapsed(collapsed: boolean): void {
  showCollapsed(collapsed);
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {}
}
// The icon is the same in both states: the style sheet turns it around.
toggle.innerHTML = SIDEBAR_ICON;
element("#new-tab .hint").textContent = NEW_TAB_HINT;
try {
  showCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1");
} catch {
  showCollapsed(false);
}

const font = await invoke<Font>("config_font");
// The folder in the header writes the home `~`.
const home = await homeDir().catch(() => null);
// The canvas measures and draws with the font as soon as a tab opens: the
// one shipped with the app must be loaded by then. A font of the system is
// already there, and a name nobody knows falls back to the next in line.
await Promise.allSettled(
  ["", "bold ", "italic ", "bold italic "].map((style) =>
    document.fonts.load(`${style}${font.size}px ${fontStack(font.family)}`),
  ),
);
// The spaces and tabs of last time, and what keeps them for next time:
// one write a moment after a change, however many changes come at once.
const saved = await invoke<SavedState>("state_load");
let saveTimer: number | undefined;
// Nothing is saved before the spaces of last time are read back: until
// then the app has less than there is to keep.
let started = false;
function saveSoon(): void {
  if (!started) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    invoke<void>("state_save", { state: tabs.snapshot() }).catch((error) =>
      console.error("ttylde: cannot save the state", error),
    );
  }, 500);
}

const keyboard = attachKeyboard(() => tabs.activeId());
const header = new Header({
  root: element("#header"),
  home,
  onSpaceMenu: (anchor) => openSpaceMenu(anchor),
});
// The tab the window shows, for the header to follow it.
let shown: Tab | null = null;
function showHeader(): void {
  header.show(
    shown && {
      place: tabs.activePlace(),
      title: titleOf(shown),
      git: shown.git,
      cwd: shown.cwd,
    },
  );
}

const tabs = new Tabs({
  list,
  pinned,
  screens,
  textarea: keyboard,
  font,
  // The window follows the visible tab. The frame around the canvas takes
  // the background of what is drawn in it. With no tab, the launcher.
  onActiveChange(tab) {
    shown = tab;
    showHeader();
    document.body.classList.toggle("empty", tab === null);
    offer.show(tab?.offer ?? null);
    if (!tab) {
      void appWindow.setTitle(DEFAULT_TITLE);
      terminal.style.background = "";
      launcher.show(tabs.closedSpaces());
      return;
    }
    launcher.hide();
    void appWindow.setTitle(tab.look.name ?? defaultTitle(tab) ?? DEFAULT_TITLE);
    if (tab.background !== null) {
      terminal.style.background = `#${tab.background.toString(16).padStart(6, "0")}`;
    }
    // A form edits the tab while it changes: the keys stay in the form.
    if (!isFormOpen()) keyboard.focus();
  },
  onSpaceChange(space) {
    // Its name or its color may have changed.
    showHeader();
    document.body.classList.toggle("no-space", space === null);
    const name = space?.name ?? "Open a space";
    element("#space .name").textContent = name;
    spaceName.title = name;
    spaceDot.title = space?.name ?? "No space open";
    if (space) sidebar.style.setProperty("--space-color", space.color);
  },
  // Next to the space menu, where the space was asked for.
  ask: (count, into) =>
    new Promise((resolve) => {
      const them = count === 1 ? "it" : "them";
      openMenu({
        ...underSpace(),
        title: count === 1 ? "1 tab without a space" : `${count} tabs without a space`,
        items: [
          {
            label: `Bring ${them} into ${into}`,
            icon: "↵",
            primary: true,
            onSelect: () => resolve("bring"),
          },
          { label: `Close ${them}`, icon: "×", danger: true, onSelect: () => resolve("close") },
        ],
        // A choice comes right after the menu closes: only without one is
        // the answer "no".
        onClose: () => queueMicrotask(() => resolve(null)),
      });
    }),
  onChange: saveSoon,
});

const launcher = new Launcher({
  root: element("#launcher"),
  onOpen: (index) => tabs.selectSpace(index),
  onNew: () => void tabs.open(),
  // The command is typed into the new shell, as if the user had.
  onRun: (command) =>
    void tabs.open().then((tab) => {
      if (tab) void invoke("session_write", { id: tab.id, text: `${command}\r` });
    }),
});
const offer = new OfferBanner({
  root: element("#offer"),
  onAccept: () => tabs.acceptOffer(),
  onDismiss: () => tabs.dismissOffer(),
});

// Keys that are only modifiers, pressed on their own on the way to another.
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

// The window gives the focus back to the terminal: with no tab, it is the
// prompt of the launcher that wants it.
window.addEventListener("focus", () => launcher.focus());

// Where what belongs to the space opens: under its name, or beside the rail.
function underSpace(): { left: number; top: number; width: number } {
  const collapsed = isCollapsed();
  const anchor = (collapsed ? spaceDot : spaceName).getBoundingClientRect();
  const bounds = sidebar.getBoundingClientRect();
  return {
    left: collapsed ? bounds.right + 6 : bounds.left + 10,
    top: collapsed ? anchor.top : anchor.bottom + 6,
    width: collapsed ? 240 : bounds.width - 20,
  };
}

// The settings of the space that is shown.
function openSettings(): void {
  const current = tabs.spaceList().find((info) => info.current);
  if (!current) return;
  const { left, top } = underSpace();
  openSpaceSettings({
    space: current.space,
    tabs: current.tabs,
    left,
    top,
    onSave: (changes) => tabs.editSpace(changes),
    onDelete: () => tabs.deleteSpace(),
    onClose: () => keyboard.focus(),
  });
}

// Under the space in the header, where it is asked for with the sidebar
// collapsed.
function under(anchor: HTMLElement): { left: number; top: number; width: number } {
  const bounds = anchor.getBoundingClientRect();
  return { left: bounds.left, top: bounds.bottom + 6, width: 240 };
}

// The menu of the spaces, under the space in the sidebar, or under `anchor`.
function openSpaceMenu(anchor?: HTMLElement): void {
  if (anchor) header.setMenuOpen(true);
  else spaceName.classList.add("open");
  openMenu({
    ...(anchor ? under(anchor) : underSpace()),
    items: [
      ...tabs.spaceList().map(({ space, tabs: count, current, closedAt }, index) => ({
        label: space.name,
        // The color is one of the palette, never text typed by someone.
        icon: `<span class="dot" style="background:${space.color}"></span>`,
        meta: closedAt === null ? tabCount(count) : `closed · ${ago(closedAt, Date.now())}`,
        hint: index < 9 ? `⌃${index + 1}` : undefined,
        current,
        quiet: closedAt !== null,
        onSelect: () => void tabs.selectSpace(index),
      })),
      {
        label: "New space",
        icon: "+",
        quiet: true,
        line: true,
        onSelect: () => void tabs.newSpace(),
      },
      ...(tabs.spaceList().some((info) => info.current)
        ? [{ label: "Space settings…", icon: "›", quiet: true, onSelect: openSettings }]
        : []),
      ...(tabs.looseCount() > 0
        ? [
            {
              label: "Save tabs as space",
              icon: "↧",
              quiet: true,
              onSelect: () => void tabs.saveAsSpace(),
            },
          ]
        : []),
    ],
    onClose: () => {
      spaceName.classList.remove("open");
      header.setMenuOpen(false);
    },
  });
}

// Clicks in the sidebar must not take the focus away from the keyboard.
sidebar.addEventListener("mousedown", (e) => e.preventDefault());
newTab.addEventListener("click", () => void tabs.open());
spaceName.addEventListener("click", () => openSpaceMenu());
spaceDot.addEventListener("click", () => openSpaceMenu());
closeSpace.addEventListener("click", () => tabs.closeSpace());
// The terminal area changes size: the observer below refits the tabs.
toggle.addEventListener("click", () => setCollapsed(!isCollapsed()));

// Without the focus the visible tab draws a hollow cursor.
window.addEventListener("focus", () => tabs.setFocused(true));
window.addEventListener("blur", () => tabs.setFocused(false));

// App shortcuts are caught before the keyboard sees the key.
window.addEventListener(
  "keydown",
  (e) => {
    // While a tab is being renamed the keys are for its name, and a menu
    // takes them for itself.
    if (isFormOpen() || isMenuOpen()) return;
    const action = actionOf(e);
    if (!action) {
      answerOffer(e);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    switch (action.type) {
      case "new-tab":
        void tabs.open();
        break;
      case "select-tab":
        tabs.select(action.index);
        break;
      case "select-space":
        void tabs.selectSpace(action.index);
        break;
      case "step-space":
        tabs.stepSpace(action.step);
        break;
      case "toggle-sidebar":
        setCollapsed(!isCollapsed());
        break;
    }
  },
  { capture: true },
);

// With the banner of a command to start again: Enter starts it, Escape
// leaves the tab at its prompt, and any other key for the terminal does
// too, on its way there.
function answerOffer(e: KeyboardEvent): void {
  if (!offer.visible || e.metaKey || e.isComposing || MODIFIERS.has(e.key)) return;
  const plain = !e.shiftKey && !e.altKey && !e.ctrlKey;
  if (plain && (e.key === "Enter" || e.key === "Escape")) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Enter") tabs.acceptOffer();
    else tabs.dismissOffer();
    return;
  }
  tabs.dismissOffer();
}

tabs.restore(saved);
started = true;
saveSoon();

// When the terminal area changes size every canvas refits and the core
// resizes PTY and grid; the full frame that follows redraws everything.
let resizeTimer: number | undefined;
let observed = false;
new ResizeObserver(() => {
  // The observer fires once on `observe`: the tabs are already that size.
  if (!observed) {
    observed = true;
    return;
  }
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => tabs.resize(), 50);
}).observe(screens);
