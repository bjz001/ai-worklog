import type { Pool } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { getSummaryForDate } from "./query-service";

describe("getSummaryForDate", () => {
  it("returns all persisted LLM sections and their evidence", async () => {
    const pool = {
      async execute(sql: string, values?: unknown[]) {
        if (sql.includes("FROM daily_summaries")) {
          return [
            [
              {
                id: "summary-1",
                work_date: "2026-07-15",
                status: "COMPLETE",
                content: JSON.stringify({
                  highlights: [{ text: "亮点", evidenceIds: ["event-1"] }],
                  projectProgress: [{ text: "进展", evidenceIds: ["event-1"] }],
                  decisions: [{ text: "决策", evidenceIds: ["event-2"] }],
                  blockers: [{ text: "阻塞", evidenceIds: ["event-3"] }],
                  nextActions: [{ text: "下一步", evidenceIds: ["event-4"] }],
                  completenessNote: "数据完整。"
                })
              }
            ],
            []
          ];
        }
        if (sql.includes("FROM summary_evidence")) return [
          [
            {
              id: "event-1",
              excerpt: "已脱敏证据",
              project_name: "AI Worklog",
              occurred_at: new Date("2026-07-15T08:00:00.000Z")
            }
          ],
          []
        ];
        expect(sql).toContain("FROM collected_events ce");
        expect(values).toEqual([
          "account-1",
          "event-2",
          "event-3",
          "event-4"
        ]);
        return [[
          {
            id: "event-2",
            excerpt: "决策证据",
            project_name: "AI Worklog",
            occurred_at: new Date("2026-07-15T09:00:00.000Z")
          },
          {
            id: "event-3",
            excerpt: "阻塞证据",
            project_name: "AI Worklog",
            occurred_at: new Date("2026-07-15T10:00:00.000Z")
          },
          {
            id: "event-4",
            excerpt: "行动证据",
            project_name: "AI Worklog",
            occurred_at: new Date("2026-07-15T11:00:00.000Z")
          }
        ], []];
      }
    } as unknown as Pool;

    const summary = await getSummaryForDate({
      pool,
      accountId: "account-1",
      workDate: "2026-07-15"
    });

    expect(summary).toMatchObject({
      status: "complete",
      decisions: [{ text: "决策", evidenceIds: ["event-2"] }],
      blockers: [{ text: "阻塞", evidenceIds: ["event-3"] }],
      nextActions: [{ text: "下一步", evidenceIds: ["event-4"] }]
    });
    expect(summary?.evidence.map((item) => item.id)).toEqual([
      "event-1",
      "event-2",
      "event-3",
      "event-4"
    ]);
  });

  it("returns null when the work date has no summary", async () => {
    const pool = {
      async execute() {
        return [[], []];
      }
    } as unknown as Pool;

    await expect(
      getSummaryForDate({
        pool,
        accountId: "account-1",
        workDate: "2026-07-01"
      })
    ).resolves.toBeNull();
  });
});
