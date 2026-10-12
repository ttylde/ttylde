/** What the user chose for a tab: it wins over what the program says. */
export type Look = {
  /** `null`: the tab shows the title of its program. */
  name: string | null;
  color: string;
  icon: string;
};

export const COLORS = ["#e8846b", "#7aa7ff", "#8fcf8a", "#f0c050", "#c58af9", "#9fb0bf"];
export const ICONS = ["▣", "⚙", "☁", "◆", "✦", "⌁"];

/** A tab nobody has touched: the neutral color, the first icon. */
export function defaultLook(): Look {
  return { name: null, color: COLORS[5], icon: ICONS[0] };
}

/** The name typed in the popover; nothing but spaces means "no name". */
export function cleanName(text: string): string | null {
  return text.trim() || null;
}

/** Distance between the popover and the edges of the window. */
const MARGIN = 8;

/**
 * Where the popover goes, from the top of the window: a little above the
 * row it edits, moved up when it would not fit.
 */
export function popoverTop(rowTop: number, height: number, viewport: number): number {
  return Math.max(MARGIN, Math.min(rowTop - 32, viewport - height - MARGIN));
}
