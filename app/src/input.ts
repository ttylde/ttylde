import { invoke } from "@tauri-apps/api/core";

// Special keys, in the shape the core deserializes as `Key`.
// `F(n)` and `Char(c)` are variants with data: `{ F: 5 }`, `{ Char: "c" }`.
type Key =
  | "Enter" | "Tab" | "Backspace" | "Escape"
  | "Up" | "Down" | "Left" | "Right"
  | "Home" | "End" | "PageUp" | "PageDown" | "Insert" | "Delete"
  | { F: number }
  | { Char: string };

type Mods = { shift: boolean; alt: boolean; ctrl: boolean };

const NAMED_KEYS: Record<string, Key> = {
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Escape: "Escape",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Delete",
};

/** Turns a `KeyboardEvent` into a core `Key`, or `null` if it is plain text. */
function keyOf(e: KeyboardEvent): Key | null {
  const named = NAMED_KEYS[e.key];
  if (named) return named;
  const fn = /^F(\d{1,2})$/.exec(e.key);
  if (fn) return { F: Number(fn[1]) };
  // Ctrl+char is a combination to encode; Alt+char is not: on macOS Option
  // produces characters (@, [, #) that must arrive as text.
  if (e.ctrlKey && e.key.length === 1) return { Char: e.key };
  return null;
}

/**
 * Wires the keyboard to a session.
 *
 * The hidden textarea has focus: the system composes text there (dead keys,
 * Option, IME) and we read it ready-made from the `input` event. Only
 * special keys and combinations go through `keydown`.
 *
 * Returns the textarea: it is the one that also receives `copy`.
 */
export function attachKeyboard(canvas: HTMLCanvasElement, sessionId: number): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  textarea.id = "keyboard";
  textarea.autocapitalize = "off";
  textarea.autocomplete = "off";
  textarea.spellcheck = false;
  document.body.appendChild(textarea);

  textarea.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    // Cmd+anything belongs to the system (menus, copy, paste).
    if (e.metaKey) return;
    const key = keyOf(e);
    if (!key) return;
    e.preventDefault();
    const mods: Mods = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey };
    void invoke("session_key", { id: sessionId, key, mods });
  });

  textarea.addEventListener("input", (e) => {
    if ((e as InputEvent).isComposing) return;
    flush();
  });
  textarea.addEventListener("compositionend", flush);

  textarea.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text") ?? "";
    if (text) void invoke("session_paste", { id: sessionId, text });
  });

  function flush(): void {
    const text = textarea.value;
    if (!text) return;
    textarea.value = "";
    void invoke("session_write", { id: sessionId, text });
  }

  // Focus stays on the textarea even when clicking the canvas.
  canvas.addEventListener("mousedown", (e) => {
    e.preventDefault();
    textarea.focus();
  });
  window.addEventListener("focus", () => textarea.focus());
  textarea.focus();
  return textarea;
}
