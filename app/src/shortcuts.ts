// The one place that knows which modifier the platform uses for app
// shortcuts: Cmd on macOS, Ctrl+Shift elsewhere (plain Ctrl belongs to the
// programs running in the terminal).

export type Action =
  | { type: "new-tab" }
  | { type: "select-tab"; index: number }
  | { type: "select-space"; index: number }
  /** `step` is 1 for the next space, -1 for the one before. */
  | { type: "step-space"; step: number }
  | { type: "toggle-sidebar" }
  /** The palette, open on Recent or on Actions, as in VS Code. */
  | { type: "palette"; tab: "recent" | "actions" }
  /** The dialog of a new saved command. */
  | { type: "new-command" }
  /** The prompt above the first line shown, or below it, to the top. */
  | { type: "jump-prompt"; up: boolean }
  /** A new pane next to the one shown: on its right in a row, below in a column. */
  | { type: "split"; direction: "row" | "column" }
  /** The pane on that side of the one shown. */
  | { type: "focus-pane"; side: "left" | "right" | "up" | "down" };

/** The parts of a `KeyboardEvent` a shortcut depends on. */
export type KeyStroke = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** How the shortcut for a new tab is written on this platform. */
export const NEW_TAB_HINT = IS_MAC ? "⌘T" : "Ctrl+Shift+T";

/** How the shortcut of the palette on its commands is written here. */
export const PALETTE_HINT = IS_MAC ? "⌘P" : "Ctrl+Shift+R";

/** How the shortcut of the palette on its actions is written here. */
export const ACTIONS_HINT = IS_MAC ? "⌘⇧P" : "Ctrl+Shift+P";

/** How the shortcut of a new saved command is written here. */
export const NEW_COMMAND_HINT = IS_MAC ? "⌘⇧S" : "Ctrl+Shift+S";

/** How the shortcuts of a new pane are written here. */
export const SPLIT_RIGHT_HINT = IS_MAC ? "⌘D" : "Ctrl+Shift+E";
export const SPLIT_DOWN_HINT = IS_MAC ? "⌘⇧D" : "Ctrl+Shift+O";

const SIDES = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
} as const;

function hasAppModifier(e: KeyStroke, mac: boolean): boolean {
  if (e.altKey) return false;
  return mac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey;
}

/** The app action a key stroke asks for, or `null` if it is not a shortcut. */
export function actionOf(e: KeyStroke, mac: boolean = IS_MAC): Action | null {
  // Spaces are on Ctrl on every platform, as in browsers. With Shift the
  // digits are taken where Ctrl+Shift is the modifier of the app.
  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === "Tab") return { type: "step-space", step: e.shiftKey ? -1 : 1 };
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && !e.shiftKey) return { type: "select-space", index: Number(digit[1]) - 1 };
  }
  // Cmd+Shift+P opens the palette on its actions, as in VS Code. Off macOS
  // Shift is already part of the modifier of the app: there Ctrl+Shift+P is
  // the actions, as the command palette of VS Code, and Ctrl+Shift+R the
  // commands, as Ctrl+R searches the history of the shell.
  if (mac && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "p") {
    return { type: "palette", tab: "actions" };
  }
  // Cmd+Shift+S, as in the mockup: a new saved command. Off macOS it is
  // Ctrl+Shift+S, the modifier of the app.
  if (mac && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "s") {
    return { type: "new-command" };
  }
  // Cmd+D on the right, Cmd+Shift+D below, as iTerm2. Off macOS, as
  // Terminator: Ctrl+Shift+E side by side, Ctrl+Shift+O one over the other.
  if (mac && e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "d") {
    return { type: "split", direction: e.shiftKey ? "column" : "row" };
  }
  // Cmd+Option and an arrow, as iTerm2: Option and an arrow alone move by
  // words in the shell. Off macOS, Ctrl+Shift+Alt and an arrow.
  const modified = mac
    ? e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey
    : e.ctrlKey && e.shiftKey && e.altKey && !e.metaKey;
  if (modified && e.key in SIDES) {
    return { type: "focus-pane", side: SIDES[e.key as keyof typeof SIDES] };
  }
  if (!hasAppModifier(e, mac)) return null;
  if (e.key.toLowerCase() === "t") return { type: "new-tab" };
  // Cmd+Up and Cmd+Down, as Terminal.app; Ctrl+Shift with the arrows off macOS.
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    return { type: "jump-prompt", up: e.key === "ArrowUp" };
  }
  if (e.key.toLowerCase() === "p") return { type: "palette", tab: mac ? "recent" : "actions" };
  if (!mac && e.key.toLowerCase() === "r") return { type: "palette", tab: "recent" };
  if (!mac && e.key.toLowerCase() === "s") return { type: "new-command" };
  if (!mac && e.key.toLowerCase() === "e") return { type: "split", direction: "row" };
  if (!mac && e.key.toLowerCase() === "o") return { type: "split", direction: "column" };
  // `key`, not `code`: the backslash sits on different keys across layouts.
  // With Shift held it is the bar.
  if (e.key === "\\" || e.key === "|") return { type: "toggle-sidebar" };
  // `code`, not `key`: with Shift held the key is a symbol, not a digit.
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) return { type: "select-tab", index: Number(digit[1]) - 1 };
  return null;
}
