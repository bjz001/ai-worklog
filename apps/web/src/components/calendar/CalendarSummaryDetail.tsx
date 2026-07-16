"use client";

import type {
  CalendarDayView,
  SummaryGenerationResponse,
  SummaryResponse,
  SummaryView
} from "@ai-worklog/contracts";
import Link from "next/link";
import { useState } from "react";

import { useDetailDrawer } from "@/components/shell/DrawerContext";
import { Icon } from "@/components/ui/Icon";
import { LoadingState, Metric } from "@/components/ui/PageElements";
import { StatusChip } from "@/components/ui/StatusChip";
import { useApiResource } from "@/hooks/use-api-resource";
import { mutateApi } from "@/lib/api-client";
import { formatDateTime, formatNumber } from "@/lib/presenters";

const sections: Array<{
  key: keyof Pick<
    SummaryView,
    "highlights" | "projectProgress" | "decisions" | "blockers" | "nextActions"
  >;
  title: string;
}> = [
  { key: "highlights", title: "工作亮点" },
  { key: "projectProgress", title: "项目进展" },
  { key: "decisions", title: "关键决策" },
  { key: "blockers", title: "阻塞与风险" },
  { key: "nextActions", title: "下一步" }
];

function dailyExportHref(date: string): string {
  return `/api/v1/summaries/export?date=${encodeURIComponent(date)}`;
}

export function CalendarSummaryDetail({
  date,
  activity,
  onGenerated
}: {
  date: string;
  activity?: CalendarDayView;
  onGenerated: () => void;
}) {
  const { closeDrawer } = useDetailDrawer();
  const { data, error, loading, reload } = useApiResource<SummaryResponse>(
    `/api/v1/summaries?date=${encodeURIComponent(date)}`
  );
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<Error | null>(null);
  const summary = data?.data.summary ?? null;

  const generate = async () => {
    setGenerating(true);
    setGenerationError(null);
    try {
      await mutateApi<SummaryGenerationResponse>("/api/v1/summaries", {
        method: "POST",
        body: { workDate: date }
      });
      reload();
      onGenerated();
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

  const canGenerate = (activity?.promptCount ?? 0) > 0;

  return (
    <div className="stack">
      <section className="drawer-section">
        <h3>工作活动</h3>
        <div className="metrics">
          <Metric label="Prompt" value={formatNumber(activity?.promptCount ?? 0)} />
          <Metric label="项目" value={formatNumber(activity?.projectCount ?? 0)} />
        </div>
      </section>

      {loading ? <LoadingState rows={3} /> : null}
      {error ? (
        <div className="inline-error" role="alert">
          <span>{error.message}</span>
          <button className="button button--secondary" onClick={reload} type="button">重新加载</button>
        </div>
      ) : null}

      {!loading && !error ? (
        <section className="drawer-section summary-detail-status">
          <h3>总结状态</h3>
          {summary ? (
            <StatusChip
              icon={<Icon name={summary.status === "complete" ? "check" : "warning"} />}
              tone={summary.status === "complete" ? "success" : "warning"}
            >
              {summary.status === "complete" ? "总结完整" : "总结已生成 · 数据不完整"}
            </StatusChip>
          ) : (
            <StatusChip icon={<Icon name="schedule" />} tone="neutral">尚无总结</StatusChip>
          )}
          {activity?.hasSyncError ? <p className="muted">当天存在同步异常，结论可能缺少部分设备数据。</p> : null}
          {summary ? <p className="muted">{summary.completenessNote}</p> : null}
          {canGenerate ? (
            <div className="summary-detail-actions">
              <button className="button button--primary" disabled={generating} onClick={() => void generate()} type="button">
                <Icon name={generating ? "schedule" : "refresh"} />
                {generating
                  ? "LLM 正在总结…"
                  : summary
                    ? "让 LLM 重新总结"
                    : "让 LLM 生成总结"}
              </button>
              {summary ? (
                <a
                  aria-label="导出日总结 Markdown"
                  className="button button--secondary"
                  href={dailyExportHref(date)}
                >
                  <Icon name="download" />导出 Markdown
                </a>
              ) : null}
            </div>
          ) : null}
          {!summary && (activity?.promptCount ?? 0) === 0 ? (
            <p className="muted">当天没有 Prompt，无需生成工作总结。</p>
          ) : null}
          {generationError ? (
            <p className="form-feedback form-feedback--error" role="alert">
              <Icon name="error" />{generationError.message}
            </p>
          ) : null}
          <span aria-live="polite" className="sr-only">
            {generating ? "LLM 正在生成工作总结" : ""}
          </span>
        </section>
      ) : null}

      {summary ? sections.map((section) => (
        <section className="drawer-section summary-detail-section" key={section.key}>
          <h3>{section.title}</h3>
          {summary[section.key].length > 0 ? (
            <ul className="summary-list">
              {summary[section.key].map((item, index) => (
                <li key={`${section.key}-${index}`}>{item.text}</li>
              ))}
            </ul>
          ) : <p className="muted">本次总结未识别到相关内容。</p>}
        </section>
      )) : null}

      {summary && summary.evidence.length > 0 ? (
        <section className="drawer-section summary-detail-section">
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

      <Link
        className="button button--secondary"
        href={`/prompts?date=${encodeURIComponent(date)}`}
        onClick={closeDrawer}
      >
        查看当天 Prompt<Icon name="chevron-right" />
      </Link>
    </div>
  );
}
