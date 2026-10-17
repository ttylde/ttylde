import { describe, expect, test } from "vitest";

import { byDay, dayOf, failed, type HistoryCommand, timeOf } from "./history";

const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

function command(text: string, ended: number, exit: number | null = 0): HistoryCommand {
  return {
    runs: 1,
    last: {
      id: 1,
      command: text,
      cwd: null,
      space: null,
      branch: null,
      started: ended,
      ended,
      exit,
    },
  };
}

describe("history", () => {
  const now = at(2026, 10, 17, 18);

  test("the day is today, yesterday, a weekday, then a date", () => {
    expect(dayOf(at(2026, 10, 17, 0, 5), now)).toBe("TODAY");
    expect(dayOf(at(2026, 10, 16, 23, 59), now)).toBe("YESTERDAY");
    expect(dayOf(at(2026, 10, 13), now)).toBe("TUESDAY");
    expect(dayOf(at(2026, 10, 10), now)).toBe("10 OCT");
  });

  test("the time is on the 24-hour clock", () => {
    expect(timeOf(at(2026, 10, 17, 9, 5))).toBe("09:05");
    expect(timeOf(at(2026, 10, 17, 21, 40))).toBe("21:40");
  });

  test("commands are grouped by day in the order they come", () => {
    const groups = byDay(
      [
        command("a", at(2026, 10, 17)),
        command("b", at(2026, 10, 17)),
        command("c", at(2026, 10, 16)),
      ],
      now,
    );
    expect(groups.map((g) => [g.day, g.commands.length])).toEqual([
      ["TODAY", 2],
      ["YESTERDAY", 1],
    ]);
  });

  test("a command failed with an exit status other than 0", () => {
    expect(failed(command("x", 0, 1).last)).toBe(true);
    expect(failed(command("x", 0, 0).last)).toBe(false);
    expect(failed(command("x", 0, null).last)).toBe(false);
  });
});
