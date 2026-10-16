import { expect, describe as group, test } from "vitest";

import {
  ACTIVE_AFTER,
  aged,
  describe,
  ended,
  READY,
  SHOWN_AFTER,
  seen,
  shown,
  started,
} from "./status";

group("status", () => {
  test("a command runs, then is done or failed", () => {
    const running = started(READY, 1000);
    expect(running).toEqual({ status: "running", since: 1000 });
    expect(ended(running, 0, 2000, false)).toEqual({ status: "done", since: 2000 });
    expect(ended(running, 1, 2000, false)).toEqual({ status: "error", since: 2000 });
  });

  // Done is news only where the user was not looking; an error is news anywhere.
  test("in the tab looked at, done leaves no dot, an error does", () => {
    const running = started(READY, 0);
    expect(ended(running, 0, 10, true)).toBe(READY);
    expect(ended(running, 2, 10, true).status).toBe("error");
  });

  // `q` in the pager of a long `git log`: git dies of SIGPIPE.
  test("a closed pipe is not an error", () => {
    expect(ended(started(READY, 0), 141, 10, false).status).toBe("done");
    expect(ended(started(READY, 0), 143, 10, false).status).toBe("error");
  });

  test("Ctrl+C is not an error", () => {
    expect(ended(started(READY, 0), 130, 10, false).status).toBe("done");
    expect(ended(started(READY, 0), 130, 10, true)).toBe(READY);
  });

  test("looking at the tab clears done, not an error", () => {
    expect(seen(ended(started(READY, 0), 0, 10, false))).toBe(READY);
    const failed = ended(started(READY, 0), 1, 10, false);
    expect(seen(failed)).toBe(failed);
  });

  // `ls` ends before its dot would show.
  test("a command that just started has no dot yet", () => {
    const running = started(READY, 0);
    expect(shown(running, SHOWN_AFTER - 1)).toBe("ready");
    expect(shown(running, SHOWN_AFTER)).toBe("running");
    expect(describe(running, 10)).toBe("");
  });

  // fish marks the start itself, then the script adds the text.
  test("a second start keeps the time of the first", () => {
    const running = started(READY, 1000);
    expect(started(running, 1500)).toBe(running);
  });

  test("an end without a status is done", () => {
    expect(ended(started(READY, 0), null, 10, false).status).toBe("done");
  });

  test("an end with nothing running changes nothing", () => {
    expect(ended(READY, 1, 10, false)).toBe(READY);
  });

  // An error stays until the next command; a new one replaces done too.
  test("a new command starts over from done and from error", () => {
    const failed = ended(started(READY, 0), 2, 10, false);
    expect(started(failed, 20)).toEqual({ status: "running", since: 20 });
  });

  test("a command still running after a while is active", () => {
    const running = started(READY, 0);
    expect(aged(running, ACTIVE_AFTER - 1)).toBe(running);
    expect(aged(running, ACTIVE_AFTER)).toEqual({ status: "active", since: 0 });
    // It ends as any other.
    expect(ended(aged(running, ACTIVE_AFTER), 0, ACTIVE_AFTER + 5, false).status).toBe("done");
  });

  test("the tooltip says how long it has been running", () => {
    const running = started(READY, 0);
    expect(describe(running, 30_000)).toBe("running · now");
    expect(describe(running, 10)).toBe("");
    expect(describe(running, 3 * 60_000)).toBe("running · 3m");
    expect(describe(aged(running, ACTIVE_AFTER), 2 * 3600_000)).toBe("active · 2h");
    expect(describe(READY, 0)).toBe("");
    expect(describe(ended(running, 1, 5, false), 5)).toBe("exited with error");
  });
});
