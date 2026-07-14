import { excerpt, sha256Hex } from "@ai-worklog/core";

export interface EvidenceInput {
  id: string;
  projectId: string;
  projectName: string;
  deviceId: string;
  content: string;
  contentHash: string;
  occurredAt: string;
  intent?: string | null;
}

export interface EvidenceStatement {
  text: string;
  evidenceIds: string[];
}

export interface RuleSummary {
  workDate: string;
  timeZone: string;
  status: "complete" | "partial";
  inputFingerprint: string;
  highlights: EvidenceStatement[];
  projectProgress: EvidenceStatement[];
  decisions: EvidenceStatement[];
  blockers: EvidenceStatement[];
  nextActions: EvidenceStatement[];
  missingDeviceIds: string[];
  completenessNote: string;
}

export function buildRuleSummary(input: {
  workDate: string;
  timeZone: string;
  expectedDeviceIds: string[];
  arrivedDeviceIds: string[];
  evidence: EvidenceInput[];
}): RuleSummary {
  const arrived = new Set(input.arrivedDeviceIds);
  const missingDeviceIds = input.expectedDeviceIds.filter(
    (deviceId) => !arrived.has(deviceId)
  );
  const status = missingDeviceIds.length === 0 ? "complete" : "partial";
  const evidenceIds = input.evidence.map((item) => item.id);
  const fingerprintSource = [...input.evidence]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => `${item.id}:${item.contentHash}`)
    .join("|");

  const projects = new Map<string, EvidenceInput[]>();
  for (const item of input.evidence) {
    const projectEvidence = projects.get(item.projectId) ?? [];
    projectEvidence.push(item);
    projects.set(item.projectId, projectEvidence);
  }

  return {
    workDate: input.workDate,
    timeZone: input.timeZone,
    status,
    inputFingerprint: sha256Hex(fingerprintSource),
    highlights: [
      {
        text: `记录到 ${input.evidence.length} 条可追溯工作活动，涉及 ${projects.size} 个项目。`,
        evidenceIds
      }
    ],
    projectProgress: [...projects.values()].map((items) => ({
      text: `${items[0]?.projectName ?? "未归类项目"}：围绕“${excerpt(items[0]?.content ?? "信息不足", 64)}”等内容展开了 ${items.length} 次交互。`,
      evidenceIds: items.map((item) => item.id)
    })),
    decisions: [],
    blockers: [],
    nextActions: [],
    missingDeviceIds,
    completenessNote:
      status === "complete"
        ? "已收到全部活跃设备的数据。"
        : `数据可能不完整：尚未收到 ${missingDeviceIds.length} 台设备的数据。`
  };
}

export interface SkillCandidateDraft {
  intent: string;
  name: string;
  description: string;
  status: "candidate";
  evidenceIds: string[];
  suggestedSteps: string[];
}

function humanizeIntent(intent: string): string {
  const known: Record<string, string> = {
    "sync-design": "跨设备同步设计",
    "daily-summary": "每日工作总结",
    "skill-review": "Skill 审核优化"
  };
  return known[intent] ?? intent.replace(/[-_]+/g, " ");
}

export function deriveSkillCandidates(
  evidence: EvidenceInput[],
  minimumEvidence = 2
): SkillCandidateDraft[] {
  const grouped = new Map<string, EvidenceInput[]>();
  for (const item of evidence) {
    if (!item.intent) continue;
    const items = grouped.get(item.intent) ?? [];
    items.push(item);
    grouped.set(item.intent, items);
  }

  return [...grouped.entries()]
    .filter(([, items]) => items.length >= minimumEvidence)
    .map(([intent, items]) => ({
      intent,
      name: `${humanizeIntent(intent)}工作流`,
      description: `根据 ${items.length} 条真实工作记录生成的候选 Skill，采纳前需要人工审核。`,
      status: "candidate" as const,
      evidenceIds: items.map((item) => item.id),
      suggestedSteps: ["确认适用场景", "整理稳定输入", "固化执行步骤", "定义输出和质量检查"]
    }));
}
