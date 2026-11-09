// The keys that edit the line typed at the prompt on macOS: Cmd and Option
// with the arrows and Backspace, as in every terminal there. Off macOS
// Home, End and the Ctrl keys already do it, and Alt keeps its meaning.

import { IS_MAC, type KeyStroke } from "./shortcuts";

/** An edit of the line, in the shape the core deserializes as `LineEdit`. */
export type LineEdit = "Start" | "End" | "DeleteLine" | "WordBack" | "WordForward" | "DeleteWord";

const WITH_CMD: Record<string, LineEdit> = {
  ArrowLeft: "Start",
  ArrowRight: "End",
  Backspace: "DeleteLine",
};

// Only the arrows and Backspace: Option with a letter or a digit types what
// the layout gives (@, #, [, |).
const WITH_OPTION: Record<string, LineEdit> = {
  ArrowLeft: "WordBack",
  ArrowRight: "WordForward",
  Backspace: "DeleteWord",
};

/** The line edit a key stroke asks for, or `null`. */
export function lineEditOf(e: KeyStroke, mac: boolean = IS_MAC): LineEdit | null {
  if (!mac || e.ctrlKey || e.shiftKey) return null;
  if (e.metaKey && !e.altKey) return WITH_CMD[e.key] ?? null;
  if (e.altKey && !e.metaKey) return WITH_OPTION[e.key] ?? null;
  return null;
}
