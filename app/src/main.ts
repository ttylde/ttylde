import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { attachKeyboard } from "./input";
import { actionOf } from "./shortcuts";
import { Tabs } from "./tabs";
import type { Font } from "./types";

const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const list = document.querySelector<HTMLElement>("#tabs")!;
const newTab = document.querySelector<HTMLElement>("#new-tab")!;
const terminal = document.querySelector<HTMLElement>("#terminal")!;
const screens = document.querySelector<HTMLElement>("#screens")!;
const appWindow = getCurrentWindow();
const DEFAULT_TITLE = "Ttylde";

const font = await invoke<Font>("config_font");
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
    void appWindow.setTitle(tab.title ?? DEFAULT_TITLE);
    if (tab.background !== null) {
      terminal.style.background = `#${tab.background.toString(16).padStart(6, "0")}`;
    }
    keyboard.focus();
  },
});

// Clicks in the sidebar must not take the focus away from the keyboard.
sidebar.addEventListener("mousedown", (e) => e.preventDefault());
newTab.addEventListener("click", () => void tabs.open());

// App shortcuts are caught before the keyboard sees the key.
window.addEventListener(
  "keydown",
  (e) => {
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
