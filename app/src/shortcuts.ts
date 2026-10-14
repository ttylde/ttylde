// The one place that knows which modifier the platform uses for app
// shortcuts: Cmd on macOS, Ctrl+Shift elsewhere (plain Ctrl belongs to the
// programs running in the terminal).

export type Action =
  | { type: "new-tab" }
  | { type: "select-tab"; index: number }
  | { type: "select-space"; index: number }
  /** `step` is 1 for the next space, -1 for the one before. */
  | { type: "step-space"; step: number }
  | { type: "toggle-sidebar" };

/** The parts of a `KeyboardEvent` a shortcut depends on. */
export type KeyStroke = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** How the shortcut for a new tab is written on this platform. */
export const NEW_TAB_HINT = IS_MAC ? "⌘T" : "Ctrl+Shift+T";

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
  if (!hasAppModifier(e, mac)) return null;
  if (e.key.toLowerCase() === "t") return { type: "new-tab" };
  // `key`, not `code`: the backslash sits on different keys across layouts.
  // With Shift held it is the bar.
  if (e.key === "\\" || e.key === "|") return { type: "toggle-sidebar" };
  // `code`, not `key`: with Shift held the key is a symbol, not a digit.
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) return { type: "select-tab", index: Number(digit[1]) - 1 };
  return null;
}
