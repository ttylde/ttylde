import { FORMER_NAMES, TAB_ICONS } from "./untitled/icons";

/** What the user chose for a tab: it wins over what the program says. */
export type Look = {
  /** `null`: the tab shows the title of its program. */
  name: string | null;
  color: string;
  icon: string;
};

/**
 * The colors of the icon of a tab, in two rows: the grays and blues of the
 * app, from the neutral one, then one of each hue.
 */
export const COLOR_ROWS = [
  ["#5f6f68", "#15211c", "#123dba", "#1f52d6", "#2466ff", "#5a8bff", "#7fb0ff"],
  ["#d04a42", "#c9661a", "#b8860b", "#8a7d12", "#1f9a6a", "#1a8fa0", "#7c5cf0", "#c0479a"],
];
export const COLORS = COLOR_ROWS.flat();
/** The icons a tab can have, by name. */
export const ICONS = Object.keys(TAB_ICONS);

/**
 * The icon `name` is now: a tab saved with an icon of before, from Lucide,
 * gets the one that took its place.
 */
export function iconName(name: string): string {
  return FORMER_NAMES[name] ?? name;
}

/** The `<svg>` of the icon called `name`; the first one for a name nobody knows. */
export function iconMarkup(name: string): string {
  const shapes = TAB_ICONS[name] ?? TAB_ICONS[ICONS[0]];
  return `<svg class="line-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`;
}

/** A tab nobody has touched: the neutral color, the first icon. */
export function defaultLook(): Look {
  return { name: null, color: COLOR_ROWS[0][0], icon: ICONS[0] };
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
  return Math.max(MARGIN, Math.min(rowTop - 12, viewport - height - MARGIN));
}
