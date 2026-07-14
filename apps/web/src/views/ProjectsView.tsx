"use client";

import type { ProjectView, ProjectsResponse } from "@ai-worklog/contracts";
import { useMemo, useState } from "react";

import { useDetailDrawer } from "@/components/shell/DrawerContext";
import { Icon } from "@/components/ui/Icon";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  PartialNotice,
  Surface
} from "@/components/ui/PageElements";
import { StatusChip } from "@/components/ui/StatusChip";
import { useApiResource } from "@/hooks/use-api-resource";
import { collectionState } from "@/lib/api-client";
import { formatDateTime, formatNumber, summarizeText } from "@/lib/presenters";

export function ProjectsView() {
  const { data, error, loading, reload } =
    useApiResource<ProjectsResponse>("/api/v1/projects");
  const { openDrawer } = useDetailDrawer();
  const [query, setQuery] = useState("");
  const projects = data?.data ?? [];
  const needsReview = projects.some((project) =>
    /待确认|低置信|unknown/i.test(project.assignmentReason)
  );
  const state = collectionState({
    loading,
    error,
    count: projects.length,
    partial: needsReview
  });
  const visibleProjects = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return projects;
    return projects.filter((project) =>
      [project.name, project.canonicalKey, project.recentPrompt ?? ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(term)
    );
  }, [projects, query]);

  const showProject = (project: ProjectView) => {
    openDrawer({
      title: project.name,
      subtitle: `${formatNumber(project.promptCount)} 条 Prompt · ${formatNumber(project.deviceCount)} 台设备`,
      content: (
        <div className="stack">
          <section className="drawer-section">
            <h3>项目概览</h3>
            <dl className="definition-list">
              <dt>规范键</dt><dd>{project.canonicalKey}</dd>
              <dt>归类依据</dt><dd>{project.assignmentReason}</dd>
              <dt>最近活动</dt><dd>{formatDateTime(project.lastActivityAt)}</dd>
              <dt>Prompt</dt><dd>{formatNumber(project.promptCount)} 条</dd>
              <dt>设备</dt><dd>{formatNumber(project.deviceCount)} 台</dd>
            </dl>
          </section>
          <section className="drawer-section">
            <h3>最近工作内容</h3>
            <p>{project.recentPrompt ?? "该项目暂无可展示的 Prompt 摘要。"}</p>
          </section>
          <section className="drawer-section">
            <h3>归类说明</h3>
            <p className="muted">人工调整始终具有最高优先级，后续同步不会静默覆盖。</p>
          </section>
        </div>
      )
    });
  };

  if (state === "loading") return <><PageHeader title="项目" description="统一 Windows 与 macOS 上的项目归属" /><LoadingState rows={6} /></>;
  if (state === "error" && error) return <><PageHeader title="项目" description="统一 Windows 与 macOS 上的项目归属" /><ErrorState error={error} onRetry={reload} /></>;
  if (state === "empty") {
    return <><PageHeader title="项目" description="统一 Windows 与 macOS 上的项目归属" /><EmptyState description="完成首次同步后，系统会优先根据规范化 Git Remote 合并跨设备项目。" icon="folder" title="暂无项目" /></>;
  }

  return (
    <>
      <PageHeader description="根据 Git Remote、映射规则与人工修正统一归类" title="项目" />
      {needsReview ? <PartialNotice>存在低置信度项目归类，请打开项目详情检查归类依据。</PartialNotice> : null}
      <div className="filter-bar">
        <label className="filter-search" htmlFor="project-search">
          <Icon name="search" />
          <input id="project-search" onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目名称、仓库或工作内容" type="search" value={query} />
        </label>
        <span className="muted">共 {formatNumber(projects.length)} 个项目</span>
      </div>
      {visibleProjects.length === 0 ? (
        <EmptyState description="尝试缩短关键词或清空当前搜索。" icon="search" title="没有匹配的项目" />
      ) : (
        <Surface className="project-list-surface" title="全部项目" description="最近有活动的项目排在前面">
          <div className="inbox-list">
            {visibleProjects.map((project) => (
              <button className="inbox-row" key={project.id} onClick={() => showProject(project)} type="button">
                <div className="inbox-row__primary">
                  <strong>{project.name}</strong>
                  <span>{project.canonicalKey}</span>
                </div>
                <div className="inbox-row__summary">
                  <strong>{project.recentPrompt ? summarizeText(project.recentPrompt, 90) : "等待首条工作记录"}</strong>
                  <span>{project.assignmentReason}</span>
                </div>
                <div className="inbox-row__meta">
                  <StatusChip tone="neutral">{project.promptCount} 条 · {project.deviceCount} 台</StatusChip>
                  <span>{formatDateTime(project.lastActivityAt)}</span>
                </div>
                <Icon name="chevron-right" />
              </button>
            ))}
          </div>
        </Surface>
      )}
    </>
  );
}
