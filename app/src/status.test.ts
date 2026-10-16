import { expect, describe as group, test } from "vitest";

import { ACTIVE_AFTER, aged, describe, ended, READY, started } from "./status";

group("status", () => {
  test("a command runs, then is done or failed", () => {
    const running = started(READY, 1000);
    expect(running).toEqual({ status: "running", since: 1000 });
    expect(ended(running, 0, 2000)).toEqual({ status: "done", since: 2000 });
    expect(ended(running, 1, 2000)).toEqual({ status: "error", since: 2000 });
  });

  // fish marks the start itself, then the script adds the text.
  test("a second start keeps the time of the first", () => {
    const running = started(READY, 1000);
    expect(started(running, 1500)).toBe(running);
  });

  test("an end without a status is done", () => {
    expect(ended(started(READY, 0), null, 10).status).toBe("done");
  });

  test("an end with nothing running changes nothing", () => {
    expect(ended(READY, 1, 10)).toBe(READY);
  });

  // An error stays until the next command; a new one replaces done too.
  test("a new command starts over from done and from error", () => {
    const failed = ended(started(READY, 0), 2, 10);
    expect(started(failed, 20)).toEqual({ status: "running", since: 20 });
  });

  test("a command still running after a while is active", () => {
    const running = started(READY, 0);
    expect(aged(running, ACTIVE_AFTER - 1)).toBe(running);
    expect(aged(running, ACTIVE_AFTER)).toEqual({ status: "active", since: 0 });
    // It ends as any other.
    expect(ended(aged(running, ACTIVE_AFTER), 0, ACTIVE_AFTER + 5).status).toBe("done");
  });

  test("the tooltip says how long it has been running", () => {
    const running = started(READY, 0);
    expect(describe(running, 30_000)).toBe("running · now");
    expect(describe(running, 3 * 60_000)).toBe("running · 3m");
    expect(describe(aged(running, ACTIVE_AFTER), 2 * 3600_000)).toBe("active · 2h");
    expect(describe(READY, 0)).toBe("");
    expect(describe(ended(running, 1, 5), 5)).toBe("exited with error");
  });
});
