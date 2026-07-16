import { describe, expect, it } from "vitest";
import {
  periodSummaryEvidenceStatements,
  periodSummaryFingerprint,
  periodSummaryLockName
} from "./period-insight-service";

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

  it("uses an account and period scoped MySQL lock name", () => {
    const first = periodSummaryLockName("account-a", "WEEK", "2026-07-13");

    expect(first).toBe(periodSummaryLockName("account-a", "WEEK", "2026-07-13"));
    expect(first).not.toBe(periodSummaryLockName("account-b", "WEEK", "2026-07-13"));
    expect(first).not.toBe(periodSummaryLockName("account-a", "MONTH", "2026-07-01"));
    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(64);
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
