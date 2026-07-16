import { describe, expect, it } from "vitest";
import { summaryPeriod } from "./periods";

describe("summaryPeriod", () => {
  it("uses Monday through Sunday across a year boundary", () => {
    expect(summaryPeriod("WEEK", "2025-12-29")).toEqual({
      periodType: "WEEK",
      periodStart: "2025-12-29",
      periodEnd: "2026-01-04"
    });
  });

  it("uses the full natural month including leap day", () => {
    expect(summaryPeriod("MONTH", "2024-02-01")).toEqual({
      periodType: "MONTH",
      periodStart: "2024-02-01",
      periodEnd: "2024-02-29"
    });
  });

  it("rejects non-canonical starts even when called internally", () => {
    expect(() => summaryPeriod("WEEK", "2026-07-12")).toThrow(
      /Monday/u
    );
    expect(() => summaryPeriod("MONTH", "2026-07-02")).toThrow(
      /first day/u
    );
  });
});
