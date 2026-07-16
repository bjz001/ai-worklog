import { describe, expect, it } from "vitest";
import {
  PeriodSummaryRequestSchema,
  PeriodSummaryResponseSchema,
  PeriodSummaryViewSchema,
  SummaryGenerationRequestSchema,
  SummaryResponseSchema,
  SummaryViewSchema
} from "./index";

const statement = { text: "完成跨设备同步", evidenceIds: ["event-1"] };

describe("summary contracts", () => {
  it("keeps every LLM summary section available to the calendar", () => {
    const parsed = SummaryViewSchema.safeParse({
        id: "summary-1",
        workDate: "2026-07-15",
        status: "complete",
        highlights: [statement],
        projectProgress: [statement],
        decisions: [statement],
        blockers: [statement],
        nextActions: [statement],
        completenessNote: "数据完整。",
        evidence: [
          {
            id: "event-1",
            excerpt: "已脱敏证据",
            projectName: "AI Worklog",
            occurredAt: "2026-07-15T08:00:00.000Z"
          }
        ]
      });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.decisions[0]?.text).toBe("完成跨设备同步");
      expect(parsed.data.blockers[0]?.text).toBe("完成跨设备同步");
      expect(parsed.data.nextActions[0]?.text).toBe("完成跨设备同步");
    }
  });

  it("accepts only a strict real work date for manual generation", () => {
    expect(
      SummaryGenerationRequestSchema.safeParse({ workDate: "2026-07-15" })
        .success
    ).toBe(true);
    expect(
      SummaryGenerationRequestSchema.safeParse({ workDate: "2026-02-30" })
        .success
    ).toBe(false);
    expect(
      SummaryGenerationRequestSchema.safeParse({
        workDate: "2026-07-15",
        apiKey: "must-not-cross-this-boundary"
      }).success
    ).toBe(false);
  });

  it("returns a nullable summary without exposing LLM credentials", () => {
    expect(
      SummaryResponseSchema.safeParse({ data: { summary: null } }).success
    ).toBe(true);
    expect(
      SummaryResponseSchema.safeParse({
        data: { summary: null, apiKey: "secret" }
      }).success
    ).toBe(false);
  });

  it("accepts only canonical Monday and month-start period requests", () => {
    expect(
      PeriodSummaryRequestSchema.safeParse({
        periodType: "WEEK",
        periodStart: "2026-07-13"
      }).success
    ).toBe(true);
    expect(
      PeriodSummaryRequestSchema.safeParse({
        periodType: "MONTH",
        periodStart: "2026-07-01"
      }).success
    ).toBe(true);
    expect(
      PeriodSummaryRequestSchema.safeParse({
        periodType: "WEEK",
        periodStart: "2026-07-12"
      }).success
    ).toBe(false);
    expect(
      PeriodSummaryRequestSchema.safeParse({
        periodType: "MONTH",
        periodStart: "2026-07-02"
      }).success
    ).toBe(false);
    expect(
      PeriodSummaryRequestSchema.safeParse({
        periodType: "MONTH",
        periodStart: "2026-07-01",
        apiKey: "must-not-cross-this-boundary"
      }).success
    ).toBe(false);
  });

  it("keeps period summaries high-level and evidence-backed", () => {
    const parsed = PeriodSummaryViewSchema.safeParse({
      id: "period-summary-1",
      periodType: "MONTH",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      dataCompleteness: "complete",
      hasContent: true,
      inputTruncated: false,
      overview: [statement],
      majorAccomplishments: [statement],
      projectProgress: [statement],
      decisions: [],
      blockers: [],
      nextFocus: [statement],
      completenessNote: "已基于本月 Prompt 与回答生成。",
      evidence: [
        {
          id: "event-1",
          excerpt: "提示词与回答证据",
          projectName: "AI Worklog",
          occurredAt: "2026-07-15T08:00:00.000Z"
        }
      ]
    });

    expect(parsed.success).toBe(true);
  });

  it("returns period activity even before an LLM summary exists", () => {
    expect(
      PeriodSummaryResponseSchema.safeParse({
        data: {
          period: {
            periodType: "WEEK",
            periodStart: "2026-07-13",
            periodEnd: "2026-07-19",
            promptCount: 12,
            projectCount: 3,
            activeDayCount: 4
          },
          generationState: "missing",
          summary: null
        }
      }).success
    ).toBe(true);
  });
});
