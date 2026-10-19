import { describe, expect, test } from "vitest";

import { type Favorite, guessName, holdsIn, menuOf, rearrange } from "./favorites";

const fav = (name: string, space: number | null, pinned = false): Favorite => ({
  name,
  command: name.toLowerCase(),
  space,
  pinned,
});

const names = (list: Favorite[]) => list.map((f) => `${f.name}${f.pinned ? "*" : ""}`);

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
    expect(holdsIn(fav("A", 1), 1)).toBe(true);
    expect(holdsIn(fav("A", 1), 2)).toBe(false);
    expect(holdsIn(fav("A", null), 2)).toBe(true);
    expect(holdsIn(fav("A", null), null)).toBe(true);
    // A tab in no space: only those for every space.
    expect(holdsIn(fav("A", 1), null)).toBe(false);
  });

  test("the menu has those in the header first", () => {
    const list = [fav("A", 1), fav("B", 1, true), fav("C", 2), fav("D", null, true)];
    expect(names(menuOf(list, 1))).toEqual(["B*", "D*", "A"]);
  });

  // Menu of space 1: B* D* | A — the line is row 2.
  const list = [fav("A", 1), fav("B", 1, true), fav("C", 2), fav("D", null, true)];

  test("a row dragged above the line goes in the header", () => {
    // A (row 3) to the top.
    expect(names(rearrange(list, 1, 3, 0))).toEqual(["A*", "B*", "C", "D*"]);
  });

  test("a row dragged below the line leaves the header", () => {
    // B (row 0) after A.
    expect(names(rearrange(list, 1, 0, 3))).toEqual(["D*", "A", "C", "B"]);
  });

  test("the order changes among those in the header", () => {
    // D (row 1) before B.
    expect(names(rearrange(list, 1, 1, 0))).toEqual(["D*", "B*", "C", "A"]);
  });

  test("the commands of other spaces keep their places", () => {
    expect(rearrange(list, 1, 3, 0)[2].name).toBe("C");
  });

  test("the line itself does not move, nor does a row onto its own place", () => {
    expect(rearrange(list, 1, 2, 0)).toBe(list);
    expect(rearrange(list, 1, 1, 1)).toBe(list);
  });
});
