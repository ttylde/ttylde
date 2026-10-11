import { describe, expect, test } from "vitest";

import { shortLabel } from "./label";

describe("shortLabel", () => {
  test("a single word gives its first two letters", () => {
    expect(shortLabel("shell")).toBe("sh");
    expect(shortLabel("vim")).toBe("vi");
  });

  test("several words give the initials of the first two", () => {
    expect(shortLabel("npm run dev")).toBe("nr");
    expect(shortLabel("Claude Code")).toBe("CC");
  });

  // The start of a path is the same for every tab: the end is not.
  test("a path counts for its last folder", () => {
    expect(shortLabel("~/Developer/Ttylde")).toBe("Tt");
    expect(shortLabel("me@mac:~/work/api")).toBe("ap");
    expect(shortLabel("/usr/local/")).toBe("lo");
  });

  // Symbols around a word are not its letters.
  test("symbols are skipped", () => {
    expect(shortLabel("✳ Claude Code")).toBe("CC");
    expect(shortLabel("[build]")).toBe("bu");
    expect(shortLabel("~")).toBe("··");
  });

  test("a one-letter title stays one letter", () => {
    expect(shortLabel("x")).toBe("x");
  });

  // Two code points, not two UTF-16 units.
  test("letters outside ASCII count as letters", () => {
    expect(shortLabel("école")).toBe("éc");
    expect(shortLabel("日本語")).toBe("日本");
  });

  test("an empty title has a placeholder", () => {
    expect(shortLabel("")).toBe("··");
    expect(shortLabel("   ")).toBe("··");
  });
});
