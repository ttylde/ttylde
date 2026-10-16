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

/** How long `done` stays once its tab is the one shown. */
export const DONE_FOR = 2500;

export const READY: TabStatus = { status: "ready", since: 0 };

/** A command started. A second start of one already running changes nothing. */
export function started(current: TabStatus, now: number): TabStatus {
  if (isRunning(current)) return current;
  return { status: "running", since: now };
}

/**
 * The command ended with `exit`. `null`: the shell did not say, as when a
 * prompt comes back without an end; that counts as done.
 */
export function ended(current: TabStatus, exit: number | null, now: number): TabStatus {
  if (!isRunning(current)) return current;
  return { status: exit === null || exit === 0 ? "done" : "error", since: now };
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
export function describe({ status, since }: TabStatus, now: number): string {
  switch (status) {
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
