import { describe, expect, test } from "vitest";

import { COLORS, cleanName, defaultLook, ICONS, popoverTop } from "./look";

describe("defaultLook", () => {
  test("has no name and picks from the lists", () => {
    const look = defaultLook();
    expect(look.name).toBeNull();
    expect(COLORS).toContain(look.color);
    expect(ICONS).toContain(look.icon);
  });

  // Editing the look of one tab must not change the others.
  test("is a new object every time", () => {
    expect(defaultLook()).not.toBe(defaultLook());
  });
});

describe("cleanName", () => {
  test("drops the spaces around the name", () => {
    expect(cleanName("  api server ")).toBe("api server");
  });

  // An empty name gives the tab back to the title of its program.
  test("nothing but spaces is no name", () => {
    expect(cleanName("")).toBeNull();
    expect(cleanName("   ")).toBeNull();
  });
});

describe("popoverTop", () => {
  test("sits a little above its row", () => {
    expect(popoverTop(200, 180, 800)).toBe(168);
  });

  test("moves up when it would leave the window", () => {
    expect(popoverTop(780, 180, 800)).toBe(612);
  });

  test("the lift can be chosen", () => {
    expect(popoverTop(200, 180, 800, 6)).toBe(194);
  });

  test("never goes above the window", () => {
    expect(popoverTop(10, 180, 800)).toBe(8);
    expect(popoverTop(100, 180, 150)).toBe(8);
  });
});
