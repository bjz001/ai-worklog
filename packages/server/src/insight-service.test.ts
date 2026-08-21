import type { PoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import {
  expectedDeviceIdsForDate,
  latestSummaryMatchesInput,
  summaryEvidenceStatements,
  summaryEvidenceFingerprint,
  summaryFingerprint,
  summaryLockName
} from "./insight-service";
import { summaryPromptFingerprint } from "./summary-prompts";

describe("summaryFingerprint", () => {
  it("changes when device coverage changes even if prompt evidence does not", () => {
    const evidenceFingerprint = "a".repeat(64);
    const partial = summaryFingerprint({
      evidenceFingerprint,
      expectedDeviceIds: ["mac", "windows"],
      arrivedDeviceIds: ["mac"]
    });
    const complete = summaryFingerprint({
      evidenceFingerprint,
      expectedDeviceIds: ["mac", "windows"],
      arrivedDeviceIds: ["windows", "mac"]
    });

    expect(partial).not.toBe(complete);
    expect(
      summaryFingerprint({
        evidenceFingerprint,
        expectedDeviceIds: ["windows", "mac"],
        arrivedDeviceIds: ["mac", "windows"]
      })
    ).toBe(complete);
  });

  it("changes when the configured LLM generator changes", () => {
    const base = {
      evidenceFingerprint: "a".repeat(64),
      expectedDeviceIds: ["mac"],
      arrivedDeviceIds: ["mac"]
    };
    expect(
      summaryFingerprint({ ...base, generatorFingerprint: "deepseek:model-a" })
    ).not.toBe(
      summaryFingerprint({ ...base, generatorFingerprint: "deepseek:model-b" })
    );
  });

  it("changes when the effective daily summary prompt changes", () => {
    const base = {
      evidenceFingerprint: "a".repeat(64),
      expectedDeviceIds: ["mac"],
      arrivedDeviceIds: ["mac"]
    };
    const generator = (instructions: string) => [
      "llm-summary-v1",
      "DEEPSEEK",
      "https://api.deepseek.com",
      "deepseek-v4-flash",
      summaryPromptFingerprint("DAILY", instructions)
    ].join(":");

    expect(
      summaryFingerprint({
        ...base,
        generatorFingerprint: generator("突出已完成成果。")
      })
    ).not.toBe(
      summaryFingerprint({
        ...base,
        generatorFingerprint: generator("突出阻塞与风险。")
      })
    );
  });

  it("uses a one-time generator fingerprint for an explicit regeneration", () => {
    const base = {
      evidenceFingerprint: "a".repeat(64),
      expectedDeviceIds: ["mac"],
      arrivedDeviceIds: ["mac"]
    };
    const automatic = summaryFingerprint({
      ...base,
      generatorFingerprint: "deepseek:model-a"
    });
    const manual = summaryFingerprint({
      ...base,
      generatorFingerprint: "deepseek:model-a:manual:request-1"
    });

    expect(manual).not.toBe(automatic);
  });
});

describe("summaryLockName", () => {
  it("is deterministic, scoped by account and date, and valid for MySQL", () => {
    const first = summaryLockName("account-a", "2026-07-14");

    expect(first).toBe(summaryLockName("account-a", "2026-07-14"));
    expect(first).not.toBe(summaryLockName("account-b", "2026-07-14"));
    expect(first).not.toBe(summaryLockName("account-a", "2026-07-15"));
    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(64);
  });
});

describe("summaryEvidenceFingerprint", () => {
  const evidence = {
    id: "event-1",
    projectId: "project-1",
    projectName: "Project",
    deviceId: "mac",
    content: "Prompt",
    contentHash: "a".repeat(64),
    occurredAt: "2026-07-15T01:00:00.000Z"
  };

  it("changes when a later visible result replaces an intermediate result", () => {
    expect(
      summaryEvidenceFingerprint([{ ...evidence, result: "intermediate" }])
    ).not.toBe(
      summaryEvidenceFingerprint([{ ...evidence, result: "final answer" }])
    );
  });
});

describe("summaryEvidenceStatements", () => {
  it("includes evidence-backed statements from all five summary sections", () => {
    const statement = (text: string) => ({
      text,
      evidenceIds: [`event-${text}`]
    });

    expect(
      summaryEvidenceStatements({
        highlights: [statement("highlight")],
        projectProgress: [statement("project")],
        decisions: [statement("decision")],
        blockers: [statement("blocker")],
        nextActions: [statement("next")]
      }).map(({ key, evidenceIds }) => ({ key, evidenceIds }))
    ).toEqual([
      { key: "highlight:0", evidenceIds: ["event-highlight"] },
      { key: "project:0", evidenceIds: ["event-project"] },
      { key: "decision:0", evidenceIds: ["event-decision"] },
      { key: "blocker:0", evidenceIds: ["event-blocker"] },
      { key: "next-action:0", evidenceIds: ["event-next"] }
    ]);
  });
});

describe("latestSummaryMatchesInput", () => {
  const canonicalInputFingerprint = "c".repeat(64);
  const manualInputFingerprint = "m".repeat(64);

  it("recognizes a manual revision on the next canonical worker run", () => {
    expect(
      latestSummaryMatchesInput({
        latestInputFingerprint: manualInputFingerprint,
        latestContent: JSON.stringify({ canonicalInputFingerprint }),
        requestedInputFingerprint: canonicalInputFingerprint,
        canonicalInputFingerprint,
        isManualRegeneration: false
      })
    ).toBe(true);
  });

  it("also accepts a driver-decoded summary content object", () => {
    expect(
      latestSummaryMatchesInput({
        latestInputFingerprint: manualInputFingerprint,
        latestContent: { canonicalInputFingerprint },
        requestedInputFingerprint: canonicalInputFingerprint,
        canonicalInputFingerprint,
        isManualRegeneration: false
      })
    ).toBe(true);
  });

  it("does not suppress a new explicit manual regeneration", () => {
    expect(
      latestSummaryMatchesInput({
        latestInputFingerprint: manualInputFingerprint,
        latestContent: JSON.stringify({ canonicalInputFingerprint }),
        requestedInputFingerprint: "n".repeat(64),
        canonicalInputFingerprint,
        isManualRegeneration: true
      })
    ).toBe(false);
  });

  it("remains compatible with automatic rows that predate canonical metadata", () => {
    expect(
      latestSummaryMatchesInput({
        latestInputFingerprint: canonicalInputFingerprint,
        latestContent: "{}",
        requestedInputFingerprint: canonicalInputFingerprint,
        canonicalInputFingerprint,
        isManualRegeneration: false
      })
    ).toBe(true);
  });
});

describe("expectedDeviceIdsForDate", () => {
  it("excludes devices created after the account-local work date", async () => {
    const execute = vi.fn(async (sql: string, values?: unknown[]) => {
      void sql;
      void values;
      return [[{ id: "device-mac" }], []];
    });

    await expect(
      expectedDeviceIdsForDate({
        pool: { execute } as unknown as Pick<PoolConnection, "execute">,
        accountId: "account-1",
        workDate: "2026-07-15",
        timeZone: "Asia/Shanghai"
      })
    ).resolves.toEqual(["device-mac"]);

    const [sql, values] = execute.mock.calls[0] ?? [];
    expect(sql).toContain("created_at < ?");
    expect(values).toEqual([
      "account-1",
      new Date("2026-07-15T16:00:00.000Z")
    ]);
  });
});
