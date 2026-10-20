import { describe, expect, test } from "vitest";

import { asked } from "./filters";

describe("filters of the actions", () => {
  test("text without @ is a plain search", () => {
    expect(asked("  Rename ")).toEqual({ kind: "all", text: "rename" });
    expect(asked("")).toEqual({ kind: "all", text: "" });
  });

  test("@ alone, or part of a filter, offers the filters", () => {
    expect(asked("@")).toMatchObject({ kind: "choosing", filters: [{ token: "@space" }] });
    expect(asked("@sp")).toMatchObject({ kind: "choosing", filters: [{ token: "@space" }] });
    expect(asked("@tab")).toEqual({ kind: "choosing", filters: [] });
  });

  test("a filter and what follows narrows it", () => {
    expect(asked("@space")).toEqual({ kind: "filter", token: "@space", text: "" });
    expect(asked("@space ")).toEqual({ kind: "filter", token: "@space", text: "" });
    expect(asked("@Space Col")).toEqual({ kind: "filter", token: "@space", text: "col" });
  });

  test("an unknown filter followed by text is none", () => {
    expect(asked("@nope rename")).toEqual({ kind: "choosing", filters: [] });
  });
});
