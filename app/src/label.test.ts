import { describe, expect, test } from "vitest";

import { folderName } from "./label";

describe("folderName", () => {
  test("is the last folder of the path", () => {
    expect(folderName("/Users/me/Developer/Ttylde")).toBe("Ttylde");
    expect(folderName("/tmp")).toBe("tmp");
  });

  test("ignores a slash at the end", () => {
    expect(folderName("/Users/me/")).toBe("me");
  });

  // The root has no name of its own.
  test("the root is a slash", () => {
    expect(folderName("/")).toBe("/");
  });

  test("keeps spaces and dots", () => {
    expect(folderName("/Users/me/My Files")).toBe("My Files");
    expect(folderName("/Users/me/.config")).toBe(".config");
  });
});
