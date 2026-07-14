import { describe, expect, it } from "vitest";
import { parseCalendarMonth, parsePromptQuery } from "./query-input";

describe("parsePromptQuery", () => {
  it("normalizes bounded pagination and supported filters", () => {
    expect(
      parsePromptQuery(
        new URLSearchParams({
          page: "2",
          pageSize: "50",
          q: "  同步  ",
          date: "2026-07-14",
          source: "CODEX"
        })
      )
    ).toEqual({
      page: 2,
      pageSize: 50,
      q: "同步",
      date: "2026-07-14",
      source: "CODEX"
    });
  });

  it("rejects oversized or unsupported filters", () => {
    expect(() =>
      parsePromptQuery(new URLSearchParams({ q: "x".repeat(501) }))
    ).toThrow("query");
    expect(() =>
      parsePromptQuery(new URLSearchParams({ source: "OTHER" }))
    ).toThrow("query");
  });
});

describe("parseCalendarMonth", () => {
  it("accepts real calendar months only", () => {
    expect(parseCalendarMonth("2026-07")).toBe("2026-07");
    expect(() => parseCalendarMonth("2026-13")).toThrow("month");
    expect(() => parseCalendarMonth("../../etc")).toThrow("month");
  });
});
