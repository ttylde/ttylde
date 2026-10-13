import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { SIDEBAR_ICON } from "./icons";
import { attachKeyboard } from "./input";
import { isMenuOpen } from "./menu";
import { isRenaming } from "./rename";
import { fontStack } from "./renderer";
import { actionOf, NEW_TAB_HINT } from "./shortcuts";
import { defaultTitle } from "./tab";
import { Tabs } from "./tabs";
import type { Font } from "./types";

// The elements of index.html the app is built on: one missing is a bug in
// the page, not something to recover from.
function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`index.html has no ${selector}`);
  return found;
}

const sidebar = element("#sidebar");
const list = element("#tabs");
const newTab = element("#new-tab");
const toggle = element("#toggle-sidebar");
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
// The canvas measures and draws with the font as soon as a tab opens: the
// one shipped with the app must be loaded by then. A font of the system is
// already there, and a name nobody knows falls back to the next in line.
await Promise.allSettled(
  ["", "bold ", "italic ", "bold italic "].map((style) =>
    document.fonts.load(`${style}${font.size}px ${fontStack(font.family)}`),
  ),
);
const keyboard = attachKeyboard(() => tabs.activeId());
const tabs = new Tabs({
  list,
  screens,
  textarea: keyboard,
  font,
  // The window follows the visible tab, and goes away with the last one.
  // The frame around the canvas takes the background of what is drawn in it.
  onActiveChange(tab) {
    if (!tab) {
      void appWindow.close();
      return;
    }
    void appWindow.setTitle(tab.look.name ?? defaultTitle(tab) ?? DEFAULT_TITLE);
    if (tab.background !== null) {
      terminal.style.background = `#${tab.background.toString(16).padStart(6, "0")}`;
    }
    keyboard.focus();
  },
});

// Clicks in the sidebar must not take the focus away from the keyboard.
sidebar.addEventListener("mousedown", (e) => e.preventDefault());
newTab.addEventListener("click", () => void tabs.open());
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
    if (isRenaming() || isMenuOpen()) return;
    const action = actionOf(e);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    switch (action.type) {
      case "new-tab":
        void tabs.open();
        break;
      case "select-tab":
        tabs.select(action.index);
        break;
      case "toggle-sidebar":
        setCollapsed(!isCollapsed());
        break;
    }
  },
  { capture: true },
);

await tabs.open();

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
