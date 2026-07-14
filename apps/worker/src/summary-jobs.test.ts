import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeSummaryJob,
  listSummaryJobs
} from "./summary-jobs";

describe("summary jobs", () => {
  it("loads every persisted date without a recency cutoff", async () => {
    const execute = vi.fn().mockResolvedValue([
      [
        { work_date: "2024-01-02", dirty_version: 7n },
        { work_date: "2026-07-14", dirty_version: "9" }
      ],
      []
    ]);

    const jobs = await listSummaryJobs({
      pool: { execute } as never,
      accountId: "account-a"
    });

    expect(jobs).toEqual([
      { workDate: "2024-01-02", dirtyVersion: "7" },
      { workDate: "2026-07-14", dirtyVersion: "9" }
    ]);
    expect(execute.mock.calls[0]?.[0]).not.toContain("committed_at");
  });

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
