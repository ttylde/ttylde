import { describe, expect, test } from "vitest";

import { DOUBLE_ESCAPE, isDoubleTap } from "./focus";

describe("isDoubleTap", () => {
  // Two presses close together leave; one alone, or two far apart, do not.
  test("pairs two presses close together", () => {
    expect(isDoubleTap(null, 1000)).toBe(false);
    expect(isDoubleTap(1000, 1000 + DOUBLE_ESCAPE)).toBe(true);
    expect(isDoubleTap(1000, 1001 + DOUBLE_ESCAPE)).toBe(false);
  });
});
