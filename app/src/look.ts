/** What the user chose for a tab: it wins over what the program says. */
export type Look = {
  /** `null`: the tab shows the title of its program. */
  name: string | null;
  color: string;
  icon: string;
};

export const COLORS = ["#2466ff", "#7fb0ff", "#123dba", "#8a7d12", "#7c5cf0", "#5f6f68"];
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
 * Where a popover goes, from the top of the window: `lift` pixels above the
 * row it belongs to, moved up when it would not fit.
 */
export function popoverTop(rowTop: number, height: number, viewport: number, lift = 32): number {
  return Math.max(MARGIN, Math.min(rowTop - lift, viewport - height - MARGIN));
}
