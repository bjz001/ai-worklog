import { describe, expect, it } from "vitest";
import {
  summaryEvidenceFingerprint,
  summaryFingerprint,
  summaryLockName
} from "./insight-service";

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
