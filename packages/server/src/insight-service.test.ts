import { describe, expect, it } from "vitest";
import { summaryFingerprint, summaryLockName } from "./insight-service";

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
