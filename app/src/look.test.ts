import { describe, expect, test } from "vitest";

import { COLORS, cleanName, defaultLook, ICONS, iconName, popoverTop } from "./look";

describe("defaultLook", () => {
  test("has no name and picks from the lists", () => {
    const look = defaultLook();
    expect(look.name).toBeNull();
    expect(COLORS).toContain(look.color);
    expect(ICONS).toContain(look.icon);
  });

  // Every tab starts the same, whatever the color of its space.
  test("is the neutral color", () => {
    expect(defaultLook().color).toBe("#5f6f68");
  });

  // Editing the look of one tab must not change the others.
  test("is a new object every time", () => {
    expect(defaultLook()).not.toBe(defaultLook());
  });
});

// A tab saved with an icon of Lucide gets the one of Untitled UI in its place.
describe("iconName", () => {
  test("an icon of before becomes the one that took its place", () => {
    expect(iconName("server")).toBe("server-01");
    expect(iconName("house")).toBe("home-02");
    expect(ICONS).toContain(iconName("square-terminal"));
  });

  test("an icon of now stays as it is", () => {
    expect(iconName("terminal")).toBe("terminal");
    expect(iconName("cube-02")).toBe("cube-02");
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

  test("never goes above the window", () => {
    expect(popoverTop(10, 180, 800)).toBe(8);
    expect(popoverTop(100, 180, 150)).toBe(8);
  });
});
