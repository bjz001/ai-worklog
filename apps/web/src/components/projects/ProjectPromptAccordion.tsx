import type {
  ProjectView,
  PromptView,
  PromptsResponse
} from "@ai-worklog/contracts";
import Link from "next/link";

import { Icon } from "@/components/ui/Icon";
import { LoadingState } from "@/components/ui/PageElements";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  formatDateTime,
  formatSource,
  summarizeText
} from "@/lib/presenters";

export interface ProjectPromptLoad {
  loading: boolean;
  data?: PromptsResponse;
  error?: Error;
}

export function ProjectPromptAccordion({
  project,
  expanded,
  promptState,
  onToggle,
  onRetry,
  onShowProject,
  onShowPrompt
}: {
  project: ProjectView;
  expanded: boolean;
  promptState?: ProjectPromptLoad;
  onToggle: () => void;
  onRetry: () => void;
  onShowProject: () => void;
  onShowPrompt: (prompt: PromptView) => void;
}) {
  const panelId = `project-prompts-${project.id}`;
  const headingId = `${panelId}-heading`;

  return (
    <section className="project-accordion">
      <button
        aria-controls={panelId}
        aria-expanded={expanded}
        className="project-disclosure"
        id={headingId}
        onClick={onToggle}
        type="button"
      >
        <span className="project-disclosure__identity">
          <strong>{project.name}</strong>
          <small>{project.canonicalKey}</small>
        </span>
        <span className="project-disclosure__summary">
          <strong>{project.recentPrompt ? summarizeText(project.recentPrompt, 90) : "等待首条工作记录"}</strong>
          <small>{project.assignmentReason}</small>
        </span>
        <span className="project-disclosure__meta">
          <StatusChip tone="neutral">{project.promptCount} 条 · {project.deviceCount} 台</StatusChip>
          <small>{formatDateTime(project.lastActivityAt)}</small>
        </span>
        <Icon className={expanded ? "disclosure-icon disclosure-icon--open" : "disclosure-icon"} name="chevron-right" />
      </button>
      <div
        aria-labelledby={headingId}
        className="project-prompt-panel"
        hidden={!expanded}
        id={panelId}
        role="region"
      >
        {promptState?.loading ? <LoadingState rows={3} /> : null}
        {promptState?.error ? (
          <div className="inline-error" role="alert">
            <span>该项目的 Prompt 暂时无法加载。</span>
            <button className="button button--secondary" onClick={onRetry} type="button">重试</button>
          </div>
        ) : null}
        {promptState?.data?.data.length === 0 ? (
          <p className="project-prompt-empty">该项目暂无可展示的 Prompt。</p>
        ) : null}
        {promptState?.data && promptState.data.data.length > 0 ? (
          <div className="inbox-list prompt-list">
            {promptState.data.data.map((prompt) => (
              <button className="inbox-row" key={prompt.id} onClick={() => onShowPrompt(prompt)} type="button">
                <div className="inbox-row__primary">
                  <strong>{formatSource(prompt.sourceType)}</strong>
                  <span>{prompt.deviceName}</span>
                </div>
                <div className="inbox-row__summary">
                  <strong>{summarizeText(prompt.content, 112)}</strong>
                  <span>{prompt.resultExcerpt ? summarizeText(prompt.resultExcerpt, 100) : "无可见结果摘要"}</span>
                </div>
                <div className="inbox-row__meta"><span>{formatDateTime(prompt.occurredAt)}</span></div>
                <Icon name="chevron-right" />
              </button>
            ))}
          </div>
        ) : null}
        <div className="project-prompt-actions">
          <button className="button button--secondary" onClick={onShowProject} type="button">项目详情</button>
          <Link className="button button--primary" href={`/runs?projectId=${encodeURIComponent(project.id)}`}>
            查看 Agent 轨迹<Icon name="chevron-right" />
          </Link>
        </div>
      </div>
    </section>
  );
}
