import type { PeriodSummaryView, SummaryView } from "@ai-worklog/contracts";
import { describe, expect, it } from "vitest";

import {
  dailySummaryExportFilename,
  periodSummaryExportFilename,
  renderDailySummaryMarkdown,
  renderPeriodSummaryMarkdown
} from "./summary-export";

const dailySummary: SummaryView = {
  id: "summary-1",
  workDate: "2026-07-15",
  status: "complete",
  inputTruncated: false,
  highlights: [
    {
      text: "交付了 # 周报 <script>alert(1)</script> [查看](javascript:alert(1))",
      evidenceIds: ["event-1"]
    }
  ],
  projectProgress: [],
  decisions: [],
  blockers: [],
  nextActions: [],
  completenessNote: "已覆盖当日工作。",
  evidence: [
    {
      id: "event-1",
      excerpt: "完成 **交付**",
      projectName: "内部 | 项目",
      occurredAt: "2026-07-15T10:00:00.000Z"
    }
  ]
};

const periodSummary: PeriodSummaryView = {
  id: "period-1",
  periodType: "WEEK",
  periodStart: "2026-07-13",
  periodEnd: "2026-07-19",
  dataCompleteness: "partial",
  hasContent: true,
  inputTruncated: true,
  overview: [{ text: "本周完成主要交付", evidenceIds: ["event-1"] }],
  majorAccomplishments: [],
  projectProgress: [],
  decisions: [],
  blockers: [],
  nextFocus: [],
  completenessNote: "输入证据已截断。",
  evidence: dailySummary.evidence
};

describe("summary Markdown export", () => {
  it("renders a complete daily summary and neutralizes Markdown/HTML injection", () => {
    const markdown = renderDailySummaryMarkdown(dailySummary);

    expect(markdown).toContain("# 2026-07-15 日总结");
    expect(markdown).toContain("## 工作亮点");
    expect(markdown).toContain("## 证据");
    expect(markdown).toContain("- 输入证据：未截断");
    expect(markdown).toContain("证据：event-1");
    expect(markdown).toContain("\\<script\\>alert\\(1\\)\\</script\\>");
    expect(markdown).toContain("\\[查看\\]\\(javascript:alert\\(1\\)\\)");
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("[查看](javascript:");
  });

  it("renders a weekly summary with truncation and completeness disclosure", () => {
    const markdown = renderPeriodSummaryMarkdown(periodSummary);

    expect(markdown).toContain("# 2026-07-13 至 2026-07-19 周总结");
    expect(markdown).toContain("- 数据完整性：部分");
    expect(markdown).toContain("- 输入证据：已截断");
    expect(markdown).toContain("输入证据已截断。");
  });

  it("uses ASCII-only filenames derived from validated dates and period types", () => {
    expect(dailySummaryExportFilename(dailySummary)).toBe(
      "ai-worklog-daily-2026-07-15.md"
    );
    expect(periodSummaryExportFilename(periodSummary)).toBe(
      "ai-worklog-week-2026-07-13.md"
    );
    expect(periodSummaryExportFilename({
      periodType: "MONTH",
      periodStart: "2026-07-01"
    })).toBe("ai-worklog-month-2026-07-01.md");
  });
});
