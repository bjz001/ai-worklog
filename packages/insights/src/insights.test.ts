import { describe, expect, it } from "vitest";
import { buildRuleSummary, deriveSkillCandidates } from "./index";

const evidence = [
  {
    id: "prompt-1",
    projectId: "project-1",
    projectName: "AI 工作沉淀台",
    deviceId: "device-macos",
    content: "设计跨设备同步协议与幂等规则",
    contentHash: "a".repeat(64),
    occurredAt: "2026-07-14T10:00:00.000Z",
    intent: "sync-design"
  },
  {
    id: "prompt-2",
    projectId: "project-1",
    projectName: "AI 工作沉淀台",
    deviceId: "device-windows",
    content: "检查跨设备同步协议的失败恢复",
    contentHash: "b".repeat(64),
    occurredAt: "2026-07-14T11:00:00.000Z",
    intent: "sync-design"
  }
];

describe("buildRuleSummary", () => {
  it("describes observed activity without claiming completion", () => {
    const result = buildRuleSummary({
      workDate: "2026-07-14",
      timeZone: "Asia/Shanghai",
      expectedDeviceIds: ["device-macos", "device-windows"],
      arrivedDeviceIds: ["device-macos", "device-windows"],
      evidence
    });

    expect(result.status).toBe("complete");
    expect(result.highlights[0]?.text).toContain("记录到");
    expect(result.highlights[0]?.text).not.toContain("已完成");
    expect(result.highlights[0]?.evidenceIds).toEqual(["prompt-1", "prompt-2"]);
  });

  it("marks the summary partial when a device has not arrived", () => {
    const result = buildRuleSummary({
      workDate: "2026-07-14",
      timeZone: "Asia/Shanghai",
      expectedDeviceIds: ["device-macos", "device-windows"],
      arrivedDeviceIds: ["device-macos"],
      evidence: evidence.slice(0, 1)
    });

    expect(result.status).toBe("partial");
    expect(result.missingDeviceIds).toEqual(["device-windows"]);
    expect(result.completenessNote).toContain("数据可能不完整");
  });
});

describe("deriveSkillCandidates", () => {
  it("requires repeated evidence and keeps all evidence ids", () => {
    const candidates = deriveSkillCandidates(evidence);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.intent).toBe("sync-design");
    expect(candidates[0]?.evidenceIds).toEqual(["prompt-1", "prompt-2"]);
    expect(candidates[0]?.status).toBe("candidate");
  });

  it("does not create a skill from one occurrence", () => {
    expect(deriveSkillCandidates(evidence.slice(0, 1))).toEqual([]);
  });
});
