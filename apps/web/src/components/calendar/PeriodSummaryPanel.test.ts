import { describe, expect, it } from "vitest";

import {
  canonicalPeriodStart,
  movePeriodStart,
  periodExportHref,
  periodRangeLabel,
  periodSummaryPath
} from "./period-summary-helpers";

describe("period summary calendar helpers", () => {
  it("normalizes weekly periods to Monday and monthly periods to the first day", () => {
    expect(canonicalPeriodStart("2026-07-15", "WEEK")).toBe("2026-07-13");
    expect(canonicalPeriodStart("2026-07-19", "WEEK")).toBe("2026-07-13");
    expect(canonicalPeriodStart("2026-07-15", "MONTH")).toBe("2026-07-01");
  });

  it("moves canonical periods across year boundaries", () => {
    expect(movePeriodStart("2025-12-29", "WEEK", 1)).toBe("2026-01-05");
    expect(movePeriodStart("2026-01-01", "MONTH", -1)).toBe("2025-12-01");
  });

  it("formats compact, human-readable period ranges", () => {
    expect(periodRangeLabel("WEEK", "2026-07-13", "2026-07-19")).toBe(
      "2026 年 7 月 13 日 – 7 月 19 日"
    );
    expect(periodRangeLabel("MONTH", "2026-07-01", "2026-07-31")).toBe(
      "2026 年 7 月"
    );
  });

  it("uses the canonical API and Markdown export query contract", () => {
    expect(periodSummaryPath("WEEK", "2026-07-13")).toBe(
      "/api/v1/period-summaries?periodType=WEEK&periodStart=2026-07-13"
    );
    expect(periodExportHref("MONTH", "2026-07-01")).toBe(
      "/api/v1/period-summaries/export?periodType=MONTH&periodStart=2026-07-01"
    );
  });
});
