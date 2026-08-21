import { describe, expect, it } from "vitest";
import {
  encodeAgentEventCursor,
  parseAgentEventQuery,
  parseAgentRunQuery,
  parseCalendarMonth,
  parsePromptQuery
} from "./query-input";

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

describe("parseAgentRunQuery", () => {
  it("parses bounded run-level search and all trajectory filters", () => {
    expect(parseAgentRunQuery(new URLSearchParams({
      page: "2",
      pageSize: "25",
      q: "  工具结果  ",
      source: "DSH",
      from: "2026-08-01",
      to: "2026-08-21",
      projectId: "project-1",
      eventKind: "TOOL_RESULT",
      completeness: "PARTIAL"
    }))).toEqual({
      page: 2,
      pageSize: 25,
      q: "工具结果",
      source: "DSH",
      from: "2026-08-01",
      to: "2026-08-21",
      projectId: "project-1",
      eventKind: "TOOL_RESULT",
      completeness: "PARTIAL"
    });
  });

  it("rejects unsupported source, event kind, reversed dates, and oversized terms", () => {
    for (const params of [
      new URLSearchParams({ source: "OTHER" }),
      new URLSearchParams({ eventKind: "PROMPT" }),
      new URLSearchParams({ from: "2026-08-22", to: "2026-08-21" }),
      new URLSearchParams({ q: "x".repeat(501) })
    ]) {
      expect(() => parseAgentRunQuery(params)).toThrow(
        "agent run query"
      );
    }
  });
});

describe("parseAgentEventQuery", () => {
  it("round-trips a stable sequence/event cursor", () => {
    const cursor = encodeAgentEventCursor({
      sequence: 42,
      eventId: "a".repeat(64)
    });
    expect(parseAgentEventQuery(new URLSearchParams({
      cursor,
      pageSize: "50"
    }))).toEqual({
      cursor: { sequence: 42, eventId: "a".repeat(64) },
      pageSize: 50
    });
  });

  it("rejects malformed and overlarge cursors", () => {
    expect(() => parseAgentEventQuery(
      new URLSearchParams({ cursor: "not-a-cursor" })
    )).toThrow("event query");
    expect(() => parseAgentEventQuery(
      new URLSearchParams({ cursor: "x".repeat(2_001) })
    )).toThrow("event query");
  });
});
