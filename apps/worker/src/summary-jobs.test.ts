import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeSummaryJob,
  listSummaryJobs
} from "./summary-jobs";
import { MAX_BACKFILL_DATES } from "./plan";

describe("summary jobs", () => {
  it("bounds an unfiltered backfill page and reports queued dates left behind", async () => {
    const rows = Array.from({ length: MAX_BACKFILL_DATES }, (_, index) => ({
      work_date: `2026-01-${String(index + 1).padStart(2, "0")}`,
      dirty_version: BigInt(index + 1)
    }));
    const execute = vi.fn()
      .mockResolvedValueOnce([[{ total: MAX_BACKFILL_DATES + 4 }], []])
      .mockResolvedValueOnce([rows, []]);

    const page = await listSummaryJobs({
      pool: { execute } as never,
      accountId: "account-a",
      limit: MAX_BACKFILL_DATES + 100
    });

    expect(page.jobs).toHaveLength(MAX_BACKFILL_DATES);
    expect(page).toMatchObject({
      totalCount: MAX_BACKFILL_DATES + 4,
      remainingCount: 4,
      bounded: true
    });
    expect(execute.mock.calls[1]?.[0]).toContain(
      `LIMIT ${MAX_BACKFILL_DATES}`
    );
    expect(execute.mock.calls[1]?.[0]).not.toContain("LIMIT ?");
    expect(execute.mock.calls[1]?.[1]).toEqual(["account-a"]);
  });

  it("queries only one explicit day for an explicit-date run", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([[
        { work_date: "2026-07-14", dirty_version: "9" }
      ], []]);

    const page = await listSummaryJobs({
      pool: { execute } as never,
      accountId: "account-a",
      workDates: ["2026-07-14"],
      limit: 1
    });

    expect(page).toEqual({
      jobs: [{ workDate: "2026-07-14", dirtyVersion: "9" }],
      totalCount: 1,
      remainingCount: 0,
      bounded: false
    });
    expect(execute.mock.calls[0]?.[0]).toContain("work_date IN (?)");
    expect(execute.mock.calls[0]?.[1]).toEqual(["account-a", "2026-07-14"]);
    expect(execute.mock.calls[1]?.[0]).toContain("LIMIT 1");
    expect(execute.mock.calls[1]?.[1]).toEqual(["account-a", "2026-07-14"]);
  });

  it("limits a nightly lookup to today and yesterday", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[{ total: 1 }], []])
      .mockResolvedValueOnce([[
        { work_date: "2026-07-13", dirty_version: "8" }
      ], []]);

    const page = await listSummaryJobs({
      pool: { execute } as never,
      accountId: "account-a",
      workDates: ["2026-07-13", "2026-07-14"],
      limit: 2
    });

    expect(page.jobs).toEqual([
      { workDate: "2026-07-13", dirtyVersion: "8" }
    ]);
    expect(execute.mock.calls[0]?.[0]).toContain("work_date IN (?, ?)");
    expect(execute.mock.calls[0]?.[1]).toEqual([
      "account-a",
      "2026-07-13",
      "2026-07-14"
    ]);
    expect(execute.mock.calls[1]?.[0]).toContain("LIMIT 2");
    expect(execute.mock.calls[1]?.[1]).toEqual([
      "account-a",
      "2026-07-13",
      "2026-07-14"
    ]);
  });

  it("rejects a filtered lookup broader than the two-day nightly window", async () => {
    const execute = vi.fn();

    await expect(listSummaryJobs({
      pool: { execute } as never,
      accountId: "account-a",
      workDates: ["2026-07-12", "2026-07-13", "2026-07-14"],
      limit: 3
    })).rejects.toThrow("at most 2");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsafe page limit %s before building SQL",
    async (limit) => {
      const execute = vi.fn();

      await expect(listSummaryJobs({
        pool: { execute } as never,
        accountId: "account-a",
        limit
      })).rejects.toThrow("Invalid summary job page limit");
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it("acknowledges only the exact generation that was refreshed", async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);

    const acknowledged = await acknowledgeSummaryJob({
      pool: { execute } as never,
      accountId: "account-a",
      job: { workDate: "2026-07-14", dirtyVersion: "12" }
    });

    expect(acknowledged).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("dirty_version = ?"),
      ["account-a", "2026-07-14", "12"]
    );
  });

  it("does not acknowledge when a concurrent sync advanced the generation", async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 0 }, []]);

    await expect(
      acknowledgeSummaryJob({
        pool: { execute } as never,
        accountId: "account-a",
        job: { workDate: "2026-07-14", dirtyVersion: "12" }
      })
    ).resolves.toBe(false);
  });
});
