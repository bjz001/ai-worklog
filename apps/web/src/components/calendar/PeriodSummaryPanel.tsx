"use client";

import type {
  PeriodSummaryGenerationResponse,
  PeriodSummaryResponse,
  PeriodSummaryView,
  SummaryPeriodType
} from "@ai-worklog/contracts";
import { useState } from "react";

import { Icon } from "@/components/ui/Icon";
import {
  ErrorState,
  LoadingState,
  Metric,
  PartialNotice,
  Surface
} from "@/components/ui/PageElements";
import { StatusChip } from "@/components/ui/StatusChip";
import { useApiResource } from "@/hooks/use-api-resource";
import { mutateApi } from "@/lib/api-client";
import { formatDateTime, formatNumber } from "@/lib/presenters";
import { SummaryGenerationError } from "./SummaryGenerationError";
import { SummaryPromptEditor } from "./SummaryPromptEditor";
import {
  canonicalPeriodStart,
  localWorkDate,
  movePeriodStart,
  periodEndFromStart,
  periodExportHref,
  periodRangeLabel,
  periodSummaryPath
} from "./period-summary-helpers";

const periodNames: Record<SummaryPeriodType, string> = {
  WEEK: "周总结",
  MONTH: "月总结"
};

const periodSections: Array<{
  key: keyof Pick<
    PeriodSummaryView,
    | "overview"
    | "majorAccomplishments"
    | "projectProgress"
    | "decisions"
    | "blockers"
    | "nextFocus"
  >;
  title: string;
}> = [
  { key: "overview", title: "总体概览" },
  { key: "majorAccomplishments", title: "主要完成事项" },
  { key: "projectProgress", title: "项目进展" },
  { key: "decisions", title: "关键决策" },
  { key: "blockers", title: "阻塞与风险" },
  { key: "nextFocus", title: "下周期重点" }
];

export function PeriodSummaryPanel({
  periodType
}: {
  periodType: SummaryPeriodType;
}) {
  const [periodStart, setPeriodStart] = useState(() =>
    canonicalPeriodStart(localWorkDate(), periodType)
  );
  const { data, error, loading, reload } = useApiResource<PeriodSummaryResponse>(
    periodSummaryPath(periodType, periodStart)
  );
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<Error | null>(null);
  const [promptDirty, setPromptDirty] = useState(false);
  const activity = data?.data.period;
  const summary = data?.data.summary ?? null;
  const periodName = periodNames[periodType];
  const periodEnd = activity?.periodEnd ?? periodEndFromStart(periodType, periodStart);
  const complete = summary?.dataCompleteness === "complete" &&
    summary.hasContent &&
    !summary.inputTruncated;

  const move = (offset: number) => {
    setGenerationError(null);
    setPeriodStart((value) => movePeriodStart(value, periodType, offset));
  };

  const generate = async () => {
    setGenerating(true);
    setGenerationError(null);
    try {
      await mutateApi<PeriodSummaryGenerationResponse>("/api/v1/period-summaries", {
        method: "POST",
        body: { periodType, periodStart }
      });
      reload();
    } catch (requestError) {
      setGenerationError(
        requestError instanceof Error
          ? requestError
          : new Error("总结生成失败，请稍后重试")
      );
    } finally {
      setGenerating(false);
    }
  };

  const navigation = (
    <div className="period-switcher" aria-label={`${periodName}周期切换`}>
      <button
        aria-label={`上一个${periodType === "WEEK" ? "周" : "月"}`}
        className="icon-button"
        disabled={generating}
        onClick={() => move(-1)}
        type="button"
      >
        <Icon name="chevron-left" />
      </button>
      <strong aria-live="polite">
        {periodRangeLabel(periodType, periodStart, periodEnd)}
      </strong>
      <button
        aria-label={`下一个${periodType === "WEEK" ? "周" : "月"}`}
        className="icon-button"
        disabled={generating}
        onClick={() => move(1)}
        type="button"
      >
        <Icon name="chevron-right" />
      </button>
    </div>
  );

  return (
    <div
      aria-labelledby={`calendar-tab-${periodType.toLowerCase()}`}
      aria-busy={loading || generating}
      id={`calendar-panel-${periodType.toLowerCase()}`}
      role="tabpanel"
      tabIndex={0}
    >
      <Surface
        actions={navigation}
        className="period-summary-surface"
        description="由已配置的 LLM 基于本周期 Prompt 与回答归纳"
        title={periodName}
      >
        <div className="surface__body period-summary-body">
          {loading ? <LoadingState rows={4} /> : null}
          {error ? <ErrorState error={error} onRetry={reload} /> : null}
          {!loading && !error && activity ? (
            <>
              <div className="metrics period-summary-metrics">
                <Metric label="Prompt" value={formatNumber(activity.promptCount)} />
                <Metric label="项目" value={formatNumber(activity.projectCount)} />
                <Metric label="活跃天数" value={formatNumber(activity.activeDayCount)} />
              </div>

              {summary && !complete ? (
                <PartialNotice>
                  {summary.inputTruncated
                    ? "本周期记录较多，LLM 使用了均衡抽样的代表性证据；导出内容也会保留此说明。"
                    : summary.completenessNote}
                </PartialNotice>
              ) : null}

              <div className="period-summary-toolbar">
                <div className="period-summary-status">
                  {summary ? (
                    <StatusChip
                      icon={<Icon name={complete ? "check" : "warning"} />}
                      tone={complete ? "success" : "warning"}
                    >
                      {complete ? "总结完整" : "总结已生成 · 数据不完整"}
                    </StatusChip>
                  ) : (
                    <StatusChip icon={<Icon name="schedule" />} tone="neutral">
                      尚无总结
                    </StatusChip>
                  )}
                  {summary ? <p className="muted">{summary.completenessNote}</p> : null}
                </div>
                {activity.promptCount > 0 ? (
                  <div className="period-summary-actions">
                    <button
                      className="button button--primary"
                      disabled={generating || promptDirty}
                      onClick={() => void generate()}
                      title={promptDirty ? "请先保存或取消 Prompt 修改" : undefined}
                      type="button"
                    >
                      <Icon name={generating ? "schedule" : "refresh"} />
                      {generating
                        ? "LLM 正在总结…"
                        : summary
                          ? "让 LLM 重新总结"
                          : "让 LLM 生成总结"}
                    </button>
                    {summary ? (
                      <a
                        aria-label={`导出${periodName} Markdown`}
                        className="button button--secondary"
                        href={periodExportHref(periodType, periodStart)}
                      >
                        <Icon name="download" />导出 Markdown
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <SummaryPromptEditor
                disabled={generating}
                onDirtyChange={setPromptDirty}
                scope={periodType === "WEEK" ? "weekly" : "monthly"}
              />

              {promptDirty ? (
                <p className="summary-prompt-save-hint" role="status">
                  请先保存或取消 Prompt 修改，再让 LLM 生成总结。
                </p>
              ) : null}

              {activity.promptCount === 0 ? (
                <div className="period-summary-empty" role="status">
                  <span className="state-panel__icon"><Icon name="calendar" size={28} /></span>
                  <div>
                    <h3>本周期暂无活动</h3>
                    <p>没有同步到 Prompt，无需调用 LLM 生成总结。</p>
                  </div>
                </div>
              ) : null}

              {generationError ? (
                <SummaryGenerationError error={generationError} />
              ) : null}

              {summary ? (
                <div className="period-summary-content">
                  {periodSections.map((section) => (
                    <section className="summary-detail-section" key={section.key}>
                      <h3>{section.title}</h3>
                      {summary[section.key].length > 0 ? (
                        <ul className="summary-list">
                          {summary[section.key].map((item, index) => (
                            <li key={`${section.key}-${index}`}>{item.text}</li>
                          ))}
                        </ul>
                      ) : <p className="muted">本次总结未识别到相关内容。</p>}
                    </section>
                  ))}
                  {summary.evidence.length > 0 ? (
                    <section className="summary-detail-section">
                      <h3>总结依据</h3>
                      <ul className="evidence-list">
                        {summary.evidence.map((evidence) => (
                          <li key={evidence.id}>
                            <strong>{evidence.projectName}</strong>
                            <span>{evidence.excerpt}</span>
                            <small>{formatDateTime(evidence.occurredAt)}</small>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </div>
              ) : null}
              <span aria-live="polite" className="sr-only">
                {generating ? `LLM 正在生成${periodName}` : ""}
              </span>
            </>
          ) : null}
        </div>
      </Surface>
    </div>
  );
}
