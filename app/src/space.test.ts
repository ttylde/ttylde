import { describe, expect, test } from "vitest";

import { COLORS } from "./look";
import { ago, createSpace, SPACE_COLORS, type Space, stepIndex, tabCount } from "./space";

function spaces(count: number): Space[] {
  const list: Space[] = [];
  for (let i = 0; i < count; i += 1) list.push(createSpace(list));
  return list;
}

describe("createSpace", () => {
  test("the first one is Space 1, in the first color", () => {
    expect(createSpace([])).toEqual({
      id: 1,
      name: "Space 1",
      color: SPACE_COLORS[0],
      folder: "~",
      shell: null,
    });
  });

  test("each one takes the next number and the next color", () => {
    const [, second, third] = spaces(3);
    expect(second).toMatchObject({ id: 2, name: "Space 2", color: SPACE_COLORS[1] });
    expect(third).toMatchObject({ id: 3, name: "Space 3", color: SPACE_COLORS[2] });
  });

  // A space that went away leaves its number and its color to the next one.
  test("a number and a color that are free again are taken first", () => {
    const [first, , third] = spaces(3);
    const created = createSpace([first, third]);

    expect(created.name).toBe("Space 2");
    expect(created.color).toBe(SPACE_COLORS[1]);
  });

  // The id tells two spaces apart even when one took the name of another.
  test("the id is never one in use", () => {
    const [first, , third] = spaces(3);
    expect(createSpace([first, third]).id).toBe(4);
  });

  test("a renamed space does not hold its number", () => {
    const [first] = spaces(1);
    expect(createSpace([{ ...first, name: "Work" }]).name).toBe("Space 1");
  });

  test("with every color taken they go around again", () => {
    const all = spaces(SPACE_COLORS.length);
    expect(createSpace(all).color).toBe(SPACE_COLORS[0]);
  });
});

describe("ago", () => {
  const MINUTE = 60_000;

  test("less than a minute counts as one", () => {
    expect(ago(0, 10_000)).toBe("1m");
  });

  test("minutes, then hours, then days", () => {
    expect(ago(0, 59 * MINUTE)).toBe("59m");
    expect(ago(0, 60 * MINUTE)).toBe("1h");
    expect(ago(0, 23 * 60 * MINUTE)).toBe("23h");
    expect(ago(0, 24 * 60 * MINUTE)).toBe("1d");
    expect(ago(0, 5 * 24 * 60 * MINUTE)).toBe("5d");
  });

  test("rounds to the nearest", () => {
    expect(ago(0, 90 * MINUTE)).toBe("2h");
  });
});

describe("stepIndex", () => {
  test("goes forward and back", () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, -1)).toBe(1);
  });

  test("goes around at both ends", () => {
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
  });

  test("with one there is nowhere to go", () => {
    expect(stepIndex(0, 1, 1)).toBe(0);
  });
});

describe("tabCount", () => {
  test("says one tab and several tabs", () => {
    expect(tabCount(1)).toBe("1 tab");
    expect(tabCount(0)).toBe("0 tabs");
    expect(tabCount(4)).toBe("4 tabs");
  });
});

describe("SPACE_COLORS", () => {
  test("are the colors of the tabs, the first spaces in blue", () => {
    expect([...SPACE_COLORS].sort()).toEqual([...COLORS].sort());
    expect(SPACE_COLORS[0]).toBe("#2466ff");
  });
});
