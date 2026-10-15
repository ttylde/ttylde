import { describe, expect, test } from "vitest";

import { folderName, tildePath } from "./label";

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

describe("tildePath", () => {
  test("writes the home as a tilde", () => {
    expect(tildePath("/Users/me", "/Users/me")).toBe("~");
    expect(tildePath("/Users/me/Developer/Ttylde", "/Users/me")).toBe("~/Developer/Ttylde");
  });

  // `/Users/meg` is not under `/Users/me`.
  test("only a whole folder is the home", () => {
    expect(tildePath("/Users/meg/work", "/Users/me")).toBe("/Users/meg/work");
    expect(tildePath("/tmp", "/Users/me")).toBe("/tmp");
  });

  test("a slash at the end of the home changes nothing", () => {
    expect(tildePath("/Users/me/work", "/Users/me/")).toBe("~/work");
  });

  test("without a home the path stays as it is", () => {
    expect(tildePath("/Users/me/work", null)).toBe("/Users/me/work");
  });
});
