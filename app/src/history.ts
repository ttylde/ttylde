import { invoke } from "@tauri-apps/api/core";

/** Mirror of `Entry` in core/src/history.rs: a command that ended. */
export type HistoryEntry = {
  id: number;
  command: string;
  cwd: string | null;
  space: number | null;
  branch: string | null;
  /** Milliseconds since 1970. */
  started: number;
  ended: number;
  exit: number | null;
};

/** Mirror of `Command`: a command once, with its last run. */
export type HistoryCommand = { last: HistoryEntry; runs: number };

/** How many commands the palette asks for at a time. */
const LIMIT = 300;

/**
 * The commands of `space` (`null`: of every space), the newest first, or
 * matched against `text` as a fuzzy search does, the best first.
 */
export function commands(space: number | null, text: string): Promise<HistoryCommand[]> {
  return invoke<HistoryCommand[]>("history_commands", { space, text, limit: LIMIT });
}

/** Lets every run of `command` in `space` go from the history. */
export function forget(command: string, space: number | null): Promise<void> {
  return invoke("history_forget", { command, space });
}

/** Empties the history of `space`; how many commands went. */
export function clear(space: number | null): Promise<number> {
  return invoke<number>("history_clear", { space });
}

/** How many commands `space` has, one each. */
export function count(space: number | null): Promise<number> {
  return invoke<number>("history_count", { space });
}

/** Whether a command ended badly: an exit status other than 0. */
export function failed(entry: HistoryEntry): boolean {
  return entry.exit !== null && entry.exit !== 0;
}

/**
 * The heading of the day `at` falls in, both in milliseconds: TODAY,
 * YESTERDAY, the weekday within the week, then the date.
 */
export function dayOf(at: number, now: number): string {
  const day = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return "TODAY";
  if (days === 1) return "YESTERDAY";
  const date = new Date(at);
  if (days < 7) return date.toLocaleDateString("en", { weekday: "long" }).toUpperCase();
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" }).toUpperCase();
}

/** `14:05`: the time of `at`, on the 24-hour clock. */
export function timeOf(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Commands in groups by day, in the order they come. */
export function byDay(
  list: HistoryCommand[],
  now: number,
): { day: string; commands: HistoryCommand[] }[] {
  const groups: { day: string; commands: HistoryCommand[] }[] = [];
  for (const command of list) {
    const day = dayOf(command.last.ended, now);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.commands.push(command);
    else groups.push({ day, commands: [command] });
  }
  return groups;
}
