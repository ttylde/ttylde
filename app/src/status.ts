/**
 * The state of a tab, from the commands its shell runs (see the shell
 * integration in the core): at the prompt, running a command, still running
 * one after a while, or just done with one, well or not.
 */
export type Status = "ready" | "running" | "active" | "done" | "error";

export type TabStatus = {
  status: Status;
  /** When the command started, or ended; milliseconds since 1970. */
  since: number;
};

/**
 * How long a command runs before it counts as active: a server, `ssh`, a
 * watcher. There is no telling one from a long build: past this, a pulsing
 * dot would only be noise.
 */
export const ACTIVE_AFTER = 5 * 60_000;

/**
 * How long a command runs before its dot shows: `ls` and the like end
 * before, and a dot that flashes at every command would only be noise.
 */
export const SHOWN_AFTER = 1000;

/** The exit status of a command stopped with `Ctrl+C`: not an error. */
const INTERRUPTED = 130;

export const READY: TabStatus = { status: "ready", since: 0 };

/** A command started. A second start of one already running changes nothing. */
export function started(current: TabStatus, now: number): TabStatus {
  if (isRunning(current)) return current;
  return { status: "running", since: now };
}

/**
 * The command ended with `exit`. `null`: the shell did not say, as when a
 * prompt comes back without an end; that counts as done, as `Ctrl+C` does.
 *
 * Done is for a tab the user was not looking at: "I am finished". In the
 * tab they look at, the output says it already, and the dot goes away.
 * An error shows wherever it happens.
 */
export function ended(
  current: TabStatus,
  exit: number | null,
  now: number,
  seen: boolean,
): TabStatus {
  if (!isRunning(current)) return current;
  const failed = exit !== null && exit !== 0 && exit !== INTERRUPTED;
  if (failed) return { status: "error", since: now };
  return seen ? READY : { status: "done", since: now };
}

/** The user looks at the tab: done has been seen, and goes away. */
export function seen(current: TabStatus): TabStatus {
  return current.status === "done" ? READY : current;
}

/**
 * The state the dot shows: a command that started a moment ago has none
 * yet, see `SHOWN_AFTER`.
 */
export function shown(current: TabStatus, now: number): Status {
  if (current.status === "running" && now - current.since < SHOWN_AFTER) return "ready";
  return current.status;
}

/** A command still running after `ACTIVE_AFTER` is active. */
export function aged(current: TabStatus, now: number): TabStatus {
  if (current.status !== "running" || now - current.since < ACTIVE_AFTER) return current;
  return { status: "active", since: current.since };
}

export function isRunning({ status }: TabStatus): boolean {
  return status === "running" || status === "active";
}

/** What the dot says when the pointer is on it; empty when there is no dot. */
export function describe(current: TabStatus, now: number): string {
  const { since } = current;
  switch (shown(current, now)) {
    case "ready":
      return "";
    case "running":
      return `running · ${elapsed(now - since)}`;
    case "active":
      return `active · ${elapsed(now - since)}`;
    case "done":
      return "done";
    case "error":
      return "exited with error";
  }
}

// `now`, `3m`, `2h`: as long as it has been.
function elapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
