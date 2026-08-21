import type {
  EvidenceView,
  PeriodSummaryView,
  SummaryView
} from "@ai-worklog/contracts";

type SummaryStatement = { text: string; evidenceIds: string[] };

const WORK_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function safeWorkDate(value: string): string {
  return WORK_DATE_PATTERN.test(value) ? value : "unknown-date";
}

function markdownText(value: string): string {
  const withoutControls = Array.from(value.replace(/\r\n?/g, "\n"))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === "\n" || character === "\t" || (code >= 32 && code !== 127);
    })
    .join("");
  const normalized = withoutControls
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || "暂无")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}[\]()<>#+!|~])/g, "\\$1");
}

function statementSection(
  title: string,
  statements: readonly SummaryStatement[]
): string[] {
  return [
    `## ${title}`,
    "",
    ...(statements.length > 0
      ? statements.map((statement) => {
        const evidenceIds = [...new Set(statement.evidenceIds)]
          .filter((id) => id.length > 0)
          .map(markdownText);
        const evidenceReference = evidenceIds.length > 0
          ? `（证据：${evidenceIds.join("、")}）`
          : "";
        return `- ${markdownText(statement.text)}${evidenceReference}`;
      })
      : ["- 暂无"]),
    ""
  ];
}

function evidenceSection(evidence: readonly EvidenceView[]): string[] {
  return [
    "## 证据",
    "",
    ...(evidence.length > 0
      ? evidence.map((item) =>
        `- ${markdownText(item.occurredAt)} · ${markdownText(item.projectName)} — ${markdownText(item.excerpt)}`
      )
      : ["- 暂无"]),
    ""
  ];
}

export function dailySummaryExportFilename(
  summary: Pick<SummaryView, "workDate">
): string {
  return `ai-worklog-daily-${safeWorkDate(summary.workDate)}.md`;
}

export function periodSummaryExportFilename(
  summary: Pick<PeriodSummaryView, "periodType" | "periodStart">
): string {
  const period = summary.periodType === "MONTH" ? "month" : "week";
  return `ai-worklog-${period}-${safeWorkDate(summary.periodStart)}.md`;
}

export function renderDailySummaryMarkdown(summary: SummaryView): string {
  const lines = [
    `# ${safeWorkDate(summary.workDate)} 日总结`,
    "",
    `- 总结状态：${summary.status === "complete" ? "完整" : "部分"}`,
    `- 输入证据：${summary.inputTruncated ? "已截断" : "未截断"}`,
    `- 完整性说明：${markdownText(summary.completenessNote)}`,
    "",
    ...statementSection("工作亮点", summary.highlights),
    ...statementSection("项目进展", summary.projectProgress),
    ...statementSection("关键决策", summary.decisions),
    ...statementSection("阻塞与风险", summary.blockers),
    ...statementSection("下一步", summary.nextActions),
    ...evidenceSection(summary.evidence)
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderPeriodSummaryMarkdown(
  summary: PeriodSummaryView
): string {
  const title = summary.periodType === "MONTH" ? "月总结" : "周总结";
  const lines = [
    `# ${safeWorkDate(summary.periodStart)} 至 ${safeWorkDate(summary.periodEnd)} ${title}`,
    "",
    `- 数据完整性：${summary.dataCompleteness === "complete" ? "完整" : "部分"}`,
    `- 输入证据：${summary.inputTruncated ? "已截断" : "未截断"}`,
    `- 完整性说明：${markdownText(summary.completenessNote)}`,
    "",
    ...statementSection("总体概览", summary.overview),
    ...statementSection("主要完成事项", summary.majorAccomplishments),
    ...statementSection("项目进展", summary.projectProgress),
    ...statementSection("关键决策", summary.decisions),
    ...statementSection("阻塞与风险", summary.blockers),
    ...statementSection("下周期重点", summary.nextFocus),
    ...evidenceSection(summary.evidence)
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}
