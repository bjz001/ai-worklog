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
          source: "CODEX",
          projectId: "project_ABC-123"
        })
      )
    ).toEqual({
      page: 2,
      pageSize: 50,
      q: "同步",
      date: "2026-07-14",
      source: "CODEX",
      projectId: "project_ABC-123"
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

  it("rejects malformed project IDs instead of normalizing them", () => {
    for (const projectId of [
      " project-1 ",
      "project/1",
      "项目-1",
      "x".repeat(65)
    ]) {
      expect(() =>
        parsePromptQuery(new URLSearchParams({ projectId }))
      ).toThrow("query");
    }
  });
});

describe("parseCalendarMonth", () => {
  it("accepts real calendar months only", () => {
    expect(parseCalendarMonth("2026-07")).toBe("2026-07");
    expect(() => parseCalendarMonth("2026-13")).toThrow("month");
    expect(() => parseCalendarMonth("../../etc")).toThrow("month");
  });
});
