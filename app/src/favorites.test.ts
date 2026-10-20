import { describe, expect, test } from "vitest";

import {
  type Favorite,
  guessName,
  holdsIn,
  menuOf,
  pinnedOf,
  rearrange,
  toggled,
} from "./favorites";

const fav = (id: number, name: string, space: number | null): Favorite => ({
  id,
  name,
  command: name.toLowerCase(),
  space,
});

const names = (list: Favorite[]) => list.map((f) => f.name);

describe("favorites", () => {
  test("the name is the first word after the runner", () => {
    expect(guessName("pnpm dev")).toBe("Dev");
    expect(guessName("docker compose up -d")).toBe("Up");
    expect(guessName("git pull --rebase")).toBe("Pull");
    expect(guessName("npm run build")).toBe("Build");
    expect(guessName("htop")).toBe("Htop");
    expect(guessName("")).toBe("");
  });

  test("a command holds in its space, or in every one", () => {
    expect(holdsIn(fav(1, "A", 1), 1)).toBe(true);
    expect(holdsIn(fav(1, "A", 1), 2)).toBe(false);
    expect(holdsIn(fav(1, "A", null), 2)).toBe(true);
    // A tab in no space: only those for every space.
    expect(holdsIn(fav(1, "A", 1), null)).toBe(false);
  });

  const list = [fav(1, "A", 1), fav(2, "B", 1), fav(3, "C", 2), fav(4, "D", null)];

  test("the header of a tab is in its own order, the others in the order saved", () => {
    const menu = menuOf(list, 1, [4, 2]);
    expect(names(menu.header)).toEqual(["B"]);
    expect(names(menu.others)).toEqual(["A"]);
    expect(names(menu.globals)).toEqual(["D"]);
  });

  // The chips: those of the space first, then the global ones.
  test("the header shows those of the space, then the global ones", () => {
    expect(names(pinnedOf(list, 1, [4, 2]))).toEqual(["B", "D"]);
    // A tab in no space has only the global ones.
    expect(names(pinnedOf(list, null, [2, 4]))).toEqual(["D"]);
  });

  // A tab of space 1 cannot have C, of space 2, nor one deleted.
  test("ids of commands that do not hold, or are gone, are left out", () => {
    expect(names(pinnedOf(list, 1, [3, 9, 1]))).toEqual(["A"]);
  });

  test("a command goes in the header, and out of it", () => {
    expect(toggled([2], 4)).toEqual([2, 4]);
    expect(toggled([2, 4], 2)).toEqual([4]);
  });

  // Rows of space 1 with header [B, D]: B | A — the line is row 1.
  test("a row dragged above the line goes in the header", () => {
    expect(rearrange(list, 1, [2, 4], 2, 0)).toEqual([1, 2, 4]);
  });

  test("a row dragged below the line leaves the header", () => {
    expect(rearrange(list, 1, [2, 4], 0, 2)).toEqual([4]);
  });

  test("the order changes among those in the header", () => {
    const three = [...list, fav(5, "E", 1)];
    expect(rearrange(three, 1, [2, 5, 4], 1, 0)).toEqual([5, 2, 4]);
  });

  test("the line itself does not move", () => {
    expect(rearrange(list, 1, [2, 4], 1, 0)).toEqual([2, 4]);
  });

  test("a new tab starts with nothing in its header", () => {
    const menu = menuOf(list, 1, []);
    expect(menu.header).toEqual([]);
    expect(names(menu.others)).toEqual(["A", "B"]);
  });
});
