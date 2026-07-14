import { describe, expect, it } from "vitest";
import {
  inferEvidenceIntent,
  isoDateTime,
  projectDisplayName,
  utcRangeForWorkDate,
  workDateInTimeZone
} from "./presentation";

describe("presentation helpers", () => {
  it("derives a human project name from a normalized Git remote", () => {
    expect(projectDisplayName("github.com/acme/ai-worklog", undefined)).toBe(
      "ai-worklog"
    );
  });

  it("uses the account time zone at UTC day boundaries", () => {
    expect(
      workDateInTimeZone("2026-07-14T16:30:00.000Z", "Asia/Shanghai")
    ).toBe("2026-07-15");
  });

  it("builds DST-aware UTC bounds for one account work date", () => {
    const shanghai = utcRangeForWorkDate("2026-07-15", "Asia/Shanghai");
    expect(shanghai.from.toISOString()).toBe("2026-07-14T16:00:00.000Z");
    expect(shanghai.until.toISOString()).toBe("2026-07-15T16:00:00.000Z");

    const newYork = utcRangeForWorkDate("2026-03-08", "America/New_York");
    expect(newYork.from.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(newYork.until.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("normalizes mysql dates to offset-aware API timestamps", () => {
    expect(isoDateTime(new Date("2026-07-14T08:00:00.000Z"))).toBe(
      "2026-07-14T08:00:00.000Z"
    );
  });

  it("only proposes known repeatable intent families", () => {
    expect(inferEvidenceIntent("检查跨设备同步的幂等规则")).toBe("sync-design");
    expect(inferEvidenceIntent("补充 macOS 采集器验收用例")).toBe("sync-design");
    expect(inferEvidenceIntent("这是一条普通问题")).toBeNull();
  });
});
