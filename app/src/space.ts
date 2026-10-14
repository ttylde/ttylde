/** A named group of tabs: the sidebar shows one at a time. */
export type Space = {
  id: number;
  name: string;
  /** The color of the dot that stands for it. */
  color: string;
  /** Where its new tabs start, as the user typed it: `~` is the home. */
  folder: string;
  /** The shell its new tabs run, `null` for the one of the system. */
  shell: string | null;
};

/** What the settings of a space can change. */
export type SpaceChanges = Pick<Space, "name" | "color" | "folder" | "shell">;

/** The colors a space can have: its own list, apart from those of the tabs. */
export const SPACE_COLORS = ["#2466ff", "#7fb0ff", "#123dba", "#1f9a6a", "#7c5cf0", "#c9661a"];

/** The shells a space can choose among, besides the one of the system. */
export const SHELLS = ["zsh", "bash", "fish"];

/**
 * A space to add to `existing`: the first `Space N` that is not taken, in
 * the first color of the palette no other space has. Its tabs start in
 * the home, with the shell of the system.
 */
export function createSpace(existing: Space[]): Space {
  const names = new Set(existing.map((space) => space.name));
  let number = 1;
  while (names.has(`Space ${number}`)) number += 1;

  const used = new Set(existing.map((space) => space.color));
  const free = SPACE_COLORS.find((color) => !used.has(color));
  // With every color taken they go around again.
  const color = free ?? SPACE_COLORS[existing.length % SPACE_COLORS.length];

  const id = existing.reduce((max, space) => Math.max(max, space.id), 0) + 1;
  return { id, name: `Space ${number}`, color, folder: "~", shell: null };
}

/** The position `step` places after `current` among `count`, going around. */
export function stepIndex(current: number, count: number, step: number): number {
  return (((current + step) % count) + count) % count;
}

/**
 * How long ago `then` was, both in milliseconds, as the menu says it of a
 * closed space: minutes, hours or days, never less than a minute.
 */
export function ago(then: number, now: number): string {
  const minutes = Math.max(1, Math.round((now - then) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
}

/** How many tabs a space has, as the menu says it. */
export function tabCount(count: number): string {
  return count === 1 ? "1 tab" : `${count} tabs`;
}
