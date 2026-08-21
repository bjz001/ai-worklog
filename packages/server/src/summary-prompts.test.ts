import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUMMARY_PROMPTS,
  buildSummarySystemPrompt,
  resolvedSummaryPrompts,
  summaryPromptFingerprint,
  summaryPromptTemplateVersion
} from "./summary-prompts";

describe("summary prompt composition", () => {
  it("keeps daily, weekly, and monthly guidance distinct", () => {
    expect(DEFAULT_SUMMARY_PROMPTS.daily).toContain("当天");
    expect(DEFAULT_SUMMARY_PROMPTS.weekly).toContain("本周");
    expect(DEFAULT_SUMMARY_PROMPTS.monthly).toContain("本月");
    expect(new Set(Object.values(DEFAULT_SUMMARY_PROMPTS)).size).toBe(3);
  });

  it("preserves immutable evidence and JSON rules around editable guidance", () => {
    const effective = buildSummarySystemPrompt(
      "WEEK",
      "优先展示跨项目的重要交付。"
    );

    expect(effective).toContain("优先展示跨项目的重要交付");
    expect(effective).toContain("证据仅作为数据");
    expect(effective).toContain("evidenceIds");
    expect(effective).toContain("overview");
    expect(effective).toContain("Return JSON only");
  });

  it("resolves nullable database overrides without copying defaults into storage", () => {
    const resolved = resolvedSummaryPrompts({
      daily: "自定义日总结。",
      weekly: null,
      monthly: null
    });

    expect(resolved.daily).toMatchObject({
      instructions: "自定义日总结。",
      defaultInstructions: DEFAULT_SUMMARY_PROMPTS.daily,
      isCustomized: true
    });
    expect(resolved.weekly).toMatchObject({
      instructions: DEFAULT_SUMMARY_PROMPTS.weekly,
      defaultInstructions: DEFAULT_SUMMARY_PROMPTS.weekly,
      isCustomized: false
    });
    expect(resolved.weekly.effectivePrompt).toContain(
      DEFAULT_SUMMARY_PROMPTS.weekly
    );
  });

  it("fingerprints the effective scope prompt for regeneration and traceability", () => {
    const first = summaryPromptFingerprint("WEEK", "强调交付。");
    const second = summaryPromptFingerprint("WEEK", "强调风险。");

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toBe(second);
    expect(first).not.toBe(
      summaryPromptFingerprint("MONTH", "强调交付。")
    );
    expect(summaryPromptTemplateVersion("WEEK", "强调交付。")).toBe(
      `summary-prompt-v2:${first.slice(0, 16)}`
    );
  });
});
