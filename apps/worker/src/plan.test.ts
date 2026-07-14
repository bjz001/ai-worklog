import { describe, expect, it } from "vitest";
import { workDatesToRefresh } from "./plan";

describe("workDatesToRefresh", () => {
  it("combines today with every persisted dirty date, including old dates", () => {
    expect(workDatesToRefresh({
      explicitWorkDate: null,
      dirtyWorkDates: ["2024-01-02", "2026-07-15", "2026-07-15"],
      timeZone: "Asia/Shanghai",
      now: new Date("2026-07-14T08:00:00.000Z")
    })).toEqual(["2024-01-02", "2026-07-14", "2026-07-15"]);
  });

  it("uses only an explicit backfill date when provided", () => {
    expect(workDatesToRefresh({
      explicitWorkDate: "2025-01-02",
      dirtyWorkDates: ["2026-07-14"],
      timeZone: "Asia/Shanghai"
    })).toEqual(["2025-01-02"]);
  });
});
