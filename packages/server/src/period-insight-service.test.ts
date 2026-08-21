import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";

const llmSettingsMocks = vi.hoisted(() => ({
  getLlmSettingsView: vi.fn(),
  getRuntimeLlmSettings: vi.fn()
}));

vi.mock("./llm-settings-service", () => llmSettingsMocks);

import {
  periodSummaryEvidenceStatements,
  periodSummaryFingerprint,
  periodSummaryLockName,
  refreshPeriodInsights
} from "./period-insight-service";
import {
  DEFAULT_SUMMARY_PROMPTS,
  summaryPromptFingerprint
} from "./summary-prompts";

describe("period summary identity", () => {
  it("fingerprints the canonical period, evidence, coverage, and model", () => {
    const base = {
      periodType: "WEEK" as const,
      periodStart: "2026-07-13",
      periodEnd: "2026-07-19",
      evidenceFingerprint: "a".repeat(64),
      expectedDeviceIds: ["mac", "windows"],
      arrivedDeviceIds: ["mac"],
      generatorFingerprint: "deepseek:model-a"
    };
    const first = periodSummaryFingerprint(base);

    expect(periodSummaryFingerprint({
      ...base,
      expectedDeviceIds: ["windows", "mac"]
    })).toBe(first);
    expect(periodSummaryFingerprint({
      ...base,
      arrivedDeviceIds: ["mac", "windows"]
    })).not.toBe(first);
    expect(periodSummaryFingerprint({
      ...base,
      generatorFingerprint: "deepseek:model-b"
    })).not.toBe(first);
    expect(periodSummaryFingerprint({
      ...base,
      periodStart: "2026-07-20",
      periodEnd: "2026-07-26"
    })).not.toBe(first);
  });

  it("uses one runtime settings snapshot for identity and generation", async () => {
    llmSettingsMocks.getLlmSettingsView.mockReset();
    llmSettingsMocks.getRuntimeLlmSettings.mockReset();
    llmSettingsMocks.getLlmSettingsView.mockResolvedValue({
      provider: "OPENAI_COMPATIBLE",
      baseUrl: "https://stale.example.com",
      model: "stale-model"
    });
    llmSettingsMocks.getRuntimeLlmSettings.mockResolvedValue({
      provider: "DEEPSEEK",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: "sk-test-only-secret",
      summaryPrompts: {
        ...DEFAULT_SUMMARY_PROMPTS,
        weekly: "只使用本次运行时快照中的周总结要求。"
      }
    });

    const occurredAt = new Date("2026-07-15T01:00:00.000Z");
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT time_zone FROM accounts")) {
        return [[{ time_zone: "Asia/Shanghai" }], []];
      }
      if (sql.includes("COUNT(DISTINCT pe.id) AS prompt_count")) {
        return [[{
          prompt_count: 1,
          project_count: 1,
          latest_prompt_update: occurredAt,
          latest_result_update: occurredAt
        }], []];
      }
      if (sql.includes("SELECT DISTINCT device_id FROM collected_events")) {
        return [[{ device_id: "mac" }], []];
      }
      if (sql.includes("SELECT id FROM devices")) {
        return [[{ id: "mac" }], []];
      }
      if (
        sql.includes("pe.sanitized_content AS content") &&
        sql.includes("collected_event_id IN")
      ) {
        return [[{
          id: "event-1",
          project_id: "project-1",
          project_name: "AI Worklog",
          device_id: "mac",
          content: "生成周总结",
          content_hash: "a".repeat(64),
          result_hash: "b".repeat(64),
          result_content: "已完成周总结功能",
          occurred_at: occurredAt
        }], []];
      }
      if (
        sql.includes("pe.collected_event_id AS id") &&
        sql.includes("pe.content_hash")
      ) {
        return [[{
          id: "event-1",
          project_id: "project-1",
          project_name: "AI Worklog",
          device_id: "mac",
          content_hash: "a".repeat(64),
          result_hash: "b".repeat(64),
          occurred_at: occurredAt
        }], []];
      }
      if (sql.includes("FROM period_summaries")) return [[], []];
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });
    const fetcher = vi.fn(async (_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.messages[0]?.content).toContain(
        "只使用本次运行时快照中的周总结要求"
      );
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{}" } }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    await expect(refreshPeriodInsights({
      pool: { execute } as unknown as Pool,
      accountId: "account-1",
      periodType: "WEEK",
      periodStart: "2026-07-13",
      masterKey: Buffer.alloc(32, 1),
      fetcher,
      resolver: async () => [{ address: "8.8.8.8", family: 4 }]
    })).resolves.toMatchObject({ generated: false, promptCount: 1 });

    expect(llmSettingsMocks.getLlmSettingsView).not.toHaveBeenCalled();
    expect(llmSettingsMocks.getRuntimeLlmSettings).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("uses an account and period scoped MySQL lock name", () => {
    const first = periodSummaryLockName("account-a", "WEEK", "2026-07-13");

    expect(first).toBe(periodSummaryLockName("account-a", "WEEK", "2026-07-13"));
    expect(first).not.toBe(periodSummaryLockName("account-b", "WEEK", "2026-07-13"));
    expect(first).not.toBe(periodSummaryLockName("account-a", "MONTH", "2026-07-01"));
    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(64);
  });

  it("changes identity when the effective period prompt changes", () => {
    const base = {
      periodType: "WEEK" as const,
      periodStart: "2026-07-13",
      periodEnd: "2026-07-19",
      evidenceFingerprint: "a".repeat(64),
      expectedDeviceIds: ["mac"],
      arrivedDeviceIds: ["mac"]
    };
    const generator = (instructions: string) => [
      "llm-period-summary-v1",
      "DEEPSEEK",
      "https://api.deepseek.com",
      "deepseek-v4-flash",
      summaryPromptFingerprint("WEEK", instructions)
    ].join(":");

    expect(periodSummaryFingerprint({
      ...base,
      generatorFingerprint: generator("突出跨项目交付。")
    })).not.toBe(periodSummaryFingerprint({
      ...base,
      generatorFingerprint: generator("突出下周风险。")
    }));
  });
});

describe("periodSummaryEvidenceStatements", () => {
  it("includes evidence-backed claims from all period sections", () => {
    const statement = (name: string) => ({
      text: name,
      evidenceIds: [`event-${name}`]
    });

    expect(periodSummaryEvidenceStatements({
      overview: [statement("overview")],
      majorAccomplishments: [statement("accomplishment")],
      projectProgress: [statement("project")],
      decisions: [statement("decision")],
      blockers: [statement("blocker")],
      nextFocus: [statement("next")]
    }).map(({ key, evidenceIds }) => ({ key, evidenceIds }))).toEqual([
      { key: "overview:0", evidenceIds: ["event-overview"] },
      { key: "accomplishment:0", evidenceIds: ["event-accomplishment"] },
      { key: "project:0", evidenceIds: ["event-project"] },
      { key: "decision:0", evidenceIds: ["event-decision"] },
      { key: "blocker:0", evidenceIds: ["event-blocker"] },
      { key: "next-focus:0", evidenceIds: ["event-next"] }
    ]);
  });
});
