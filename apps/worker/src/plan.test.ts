import { describe, expect, it } from "vitest";
import {
  defaultSummaryJobWorkDates,
  MAX_BACKFILL_DATES,
  workDatesToRefresh
} from "./plan";

describe("workDatesToRefresh", () => {
  it("always refreshes today and adds only a queued yesterday", () => {
    expect(workDatesToRefresh({
      command: { mode: "today", workDate: null },
      dirtyWorkDates: [
        "2026-06-07",
        "2026-07-13",
        "2026-07-14",
        "2026-07-15"
      ],
      totalDirtyCount: 4,
      timeZone: "Asia/Shanghai",
      now: new Date("2026-07-14T08:00:00.000Z")
    })).toEqual({
      mode: "today",
      workDates: ["2026-07-13", "2026-07-14"],
      bounded: false,
      deferredJobCount: null
    });
  });

  it("does not add yesterday when only today or older dates are queued", () => {
    expect(workDatesToRefresh({
      command: { mode: "today", workDate: null },
      dirtyWorkDates: ["2026-06-07", "2026-07-14"],
      totalDirtyCount: 2,
      timeZone: "Asia/Shanghai",
      now: new Date("2026-07-14T08:00:00.000Z")
    }).workDates).toEqual(["2026-07-14"]);
  });

  it("calculates the previous calendar date across DST and year boundaries", () => {
    expect(defaultSummaryJobWorkDates({
      timeZone: "America/New_York",
      now: new Date("2026-03-09T04:30:00.000Z")
    })).toEqual(["2026-03-08", "2026-03-09"]);
    expect(defaultSummaryJobWorkDates({
      timeZone: "Asia/Shanghai",
      now: new Date("2025-12-31T16:30:00.000Z")
    })).toEqual(["2025-12-31", "2026-01-01"]);
  });

  it("uses only an explicitly requested date", () => {
    expect(workDatesToRefresh({
      command: { mode: "date", workDate: "2025-01-02" },
      dirtyWorkDates: ["2026-07-14"],
      totalDirtyCount: 1,
      timeZone: "Asia/Shanghai"
    })).toEqual({
      mode: "date",
      workDates: ["2025-01-02"],
      bounded: false,
      deferredJobCount: null
    });
  });

  it("bounds explicit backfill to 31 oldest queued dates and reports the remainder", () => {
    const queuedDates = Array.from({ length: MAX_BACKFILL_DATES }, (_, index) =>
      `2026-01-${String(index + 1).padStart(2, "0")}`
    );

    expect(workDatesToRefresh({
      command: { mode: "backfill", workDate: null },
      dirtyWorkDates: queuedDates,
      totalDirtyCount: MAX_BACKFILL_DATES + 4,
      timeZone: "Asia/Shanghai"
    })).toEqual({
      mode: "backfill",
      workDates: queuedDates,
      bounded: true,
      deferredJobCount: 4
    });
  });

  it("does not synthesize today's date when an explicit backfill queue is empty", () => {
    expect(workDatesToRefresh({
      command: { mode: "backfill", workDate: null },
      dirtyWorkDates: [],
      totalDirtyCount: 0,
      timeZone: "Asia/Shanghai",
      now: new Date("2026-07-14T08:00:00.000Z")
    })).toEqual({
      mode: "backfill",
      workDates: [],
      bounded: false,
      deferredJobCount: 0
    });
  });
});
