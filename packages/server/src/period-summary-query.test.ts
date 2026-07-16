import type { Pool } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { getPeriodActivity, getPeriodSummary } from "./query-service";

describe("period summary queries", () => {
  it("returns activity and the latest evidence-backed LLM report", async () => {
    const pool = {
      async execute(sql: string, values?: unknown[]) {
        if (sql.includes("SELECT time_zone")) {
          return [[{ time_zone: "Asia/Shanghai" }], []];
        }
        if (sql.includes("SELECT occurred_at, project_id FROM prompt_entries")) {
          expect(values?.[0]).toBe("account-1");
          return [[
            { occurred_at: new Date("2026-07-12T16:30:00.000Z"), project_id: "p1" },
            { occurred_at: new Date("2026-07-13T03:00:00.000Z"), project_id: "p1" },
            { occurred_at: new Date("2026-07-14T03:00:00.000Z"), project_id: "p2" }
          ], []];
        }
        if (sql.includes("FROM period_summaries")) {
          expect(values).toEqual(["account-1", "WEEK", "2026-07-13"]);
          return [[{
            id: "period-1",
            period_type: "WEEK",
            period_start: "2026-07-13",
            period_end: "2026-07-19",
            status: "COMPLETE",
            content: JSON.stringify({
              inputTruncated: false,
              overview: [{ text: "本周完成核心链路", evidenceIds: ["event-1"] }],
              majorAccomplishments: [{ text: "完成配置", evidenceIds: ["event-1"] }],
              projectProgress: [],
              decisions: [],
              blockers: [],
              nextFocus: [],
              completenessNote: "数据完整。"
            })
          }], []];
        }
        if (sql.includes("FROM period_summary_evidence")) {
          expect(values).toEqual(["account-1", "period-1"]);
          return [[{
            id: "event-1",
            excerpt: "提示词与回答证据",
            project_name: "AI Worklog",
            occurred_at: new Date("2026-07-14T03:00:00.000Z")
          }], []];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }
    } as unknown as Pool;

    await expect(getPeriodActivity({
      pool,
      accountId: "account-1",
      periodType: "WEEK",
      periodStart: "2026-07-13"
    })).resolves.toEqual({
      periodType: "WEEK",
      periodStart: "2026-07-13",
      periodEnd: "2026-07-19",
      promptCount: 3,
      projectCount: 2,
      activeDayCount: 2
    });

    await expect(getPeriodSummary({
      pool,
      accountId: "account-1",
      periodType: "WEEK",
      periodStart: "2026-07-13"
    })).resolves.toMatchObject({
      id: "period-1",
      dataCompleteness: "complete",
      hasContent: true,
      inputTruncated: false,
      overview: [{ text: "本周完成核心链路", evidenceIds: ["event-1"] }],
      evidence: [{ id: "event-1" }]
    });
  });

  it("returns null when the period has no generated report", async () => {
    const pool = {
      async execute() {
        return [[], []];
      }
    } as unknown as Pool;

    await expect(getPeriodSummary({
      pool,
      accountId: "account-1",
      periodType: "MONTH",
      periodStart: "2026-07-01"
    })).resolves.toBeNull();
  });
});
