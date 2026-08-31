"use client";

import type { PromptView, PromptsResponse } from "@ai-worklog/contracts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { PromptDetailContent } from "@/components/prompts/PromptDetailContent";
import { useDetailDrawer } from "@/components/shell/DrawerContext";
import { Icon } from "@/components/ui/Icon";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Surface
} from "@/components/ui/PageElements";
import { StatusChip } from "@/components/ui/StatusChip";
import { useApiResource } from "@/hooks/use-api-resource";
import { collectionState } from "@/lib/api-client";
import { groupPromptsByProject } from "@/lib/prompt-groups";
import {
  formatDateTime,
  formatNumber,
  formatSource,
  summarizeText
} from "@/lib/presenters";

export function PromptsView() {
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  const initialDate = searchParams.get("date") ?? "";
  const projectId = searchParams.get("projectId") ?? "";
  const [queryDraft, setQueryDraft] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [date, setDate] = useState(initialDate);
  const [source, setSource] = useState("");
  const [page, setPage] = useState(1);
  const path = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "50" });
    if (query) params.set("q", query);
    if (date) params.set("date", date);
    if (source) params.set("source", source);
    if (projectId) params.set("projectId", projectId);
    return `/api/v1/prompts?${params.toString()}`;
  }, [date, page, projectId, query, source]);
  const { data, error, loading, reload } = useApiResource<PromptsResponse>(path);
  const { openDrawer } = useDetailDrawer();
  const prompts = data?.data ?? [];
  const groups = useMemo(() => groupPromptsByProject(prompts), [prompts]);
  const groupSignature = groups.map((group) => group.key).join("|");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const state = collectionState({ loading, error, count: prompts.length });

  useEffect(() => {
    const first = groups[0]?.key;
    setExpandedGroups(first ? new Set([first]) : new Set());
  }, [groupSignature]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryDraft.trim());
  };

  const showPrompt = (prompt: PromptView) => {
    openDrawer({
      title: prompt.projectName,
      subtitle: `${formatSource(prompt.sourceType)} · ${formatDateTime(prompt.occurredAt)}`,
      content: <PromptDetailContent prompt={prompt} />
    });
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <PageHeader description="旧 API 的用户/助手兼容投影；完整搜索请使用 Agent 轨迹" title="Prompt 兼容视图" />
      <form className="filter-bar" onSubmit={submitSearch}>
        <label className="filter-search" htmlFor="prompt-search">
          <Icon name="search" />
          <input id="prompt-search" onChange={(event) => setQueryDraft(event.target.value)} placeholder="搜索 Prompt 正文、项目或标签" type="search" value={queryDraft} />
        </label>
        <label className="sr-only" htmlFor="prompt-source">来源</label>
        <select className="select" id="prompt-source" onChange={(event) => { setPage(1); setSource(event.target.value); }} value={source}>
          <option value="">全部来源</option>
          <option value="CODEX">Codex</option>
          <option value="CLAUDE_CODE">Claude Code</option>
          <option value="ZCODE">ZCode</option>
          <option value="DSH">DSH</option>
        </select>
        <label className="sr-only" htmlFor="prompt-date">工作日期</label>
        <input className="select" id="prompt-date" onChange={(event) => { setPage(1); setDate(event.target.value); }} type="date" value={date} />
        <button className="button button--primary" type="submit">搜索</button>
      </form>

      {projectId ? (
        <div className="active-filter" role="status">
          <span><Icon name="folder" size={16} />正在查看指定项目的 Prompt</span>
          <Link className="button button--text" href="/prompts">清除项目筛选</Link>
        </div>
      ) : null}

      {state === "loading" ? <LoadingState rows={7} /> : null}
      {state === "error" && error ? <ErrorState error={error} onRetry={reload} /> : null}
      {state === "empty" ? (
        <EmptyState
          description={query || date || source ? "当前筛选条件下没有结果，请调整关键词、日期或来源。" : "完成同步后，这里仅展示旧 Prompt API 的兼容投影。"}
          icon="prompt"
          title={query || date || source ? "没有匹配的 Prompt" : "Prompt 库为空"}
        />
      ) : null}
      {state === "ready" && data ? (
        <Surface title="Prompt 记录" description={`共 ${formatNumber(data.pagination.totalItems)} 条，第 ${data.pagination.page} / ${Math.max(1, data.pagination.totalPages)} 页`}>
          <div className="prompt-groups">
            {groups.map((group) => {
              const expanded = expandedGroups.has(group.key);
              const panelId = `prompt-group-${group.key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
              const headingId = `${panelId}-heading`;
              return (
                <section className="prompt-group" key={group.key}>
                  <button
                    aria-controls={panelId}
                    aria-expanded={expanded}
                    className="group-disclosure"
                    id={headingId}
                    onClick={() => toggleGroup(group.key)}
                    type="button"
                  >
                    <span>
                      <strong>{group.projectName}</strong>
                      <small>本页 {formatNumber(group.prompts.length)} 条</small>
                    </span>
                    <Icon className={expanded ? "disclosure-icon disclosure-icon--open" : "disclosure-icon"} name="chevron-right" />
                  </button>
                  <div aria-labelledby={headingId} hidden={!expanded} id={panelId} role="region">
                    <div className="inbox-list prompt-list">
                      {group.prompts.map((prompt) => (
                        <button className="inbox-row" key={prompt.id} onClick={() => showPrompt(prompt)} type="button">
                          <div className="inbox-row__primary">
                            <strong>{formatSource(prompt.sourceType)}</strong>
                            <span>{prompt.deviceName}</span>
                          </div>
                          <div className="inbox-row__summary">
                            <strong>{summarizeText(prompt.content, 112)}</strong>
                            <span>{prompt.resultExcerpt ? summarizeText(prompt.resultExcerpt, 100) : "无可见结果摘要"}</span>
                          </div>
                          <div className="inbox-row__meta">
                            <span className="inline-actions">
                              {prompt.isFavorite ? <Icon name="favorite" size={16} /> : null}
                              {prompt.tags.slice(0, 1).map((tag) => <StatusChip key={tag}>{tag}</StatusChip>)}
                            </span>
                            <span>{formatDateTime(prompt.occurredAt)}</span>
                          </div>
                          <Icon name="chevron-right" />
                        </button>
                      ))}
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
          <nav aria-label="Prompt 分页" className="pagination-bar">
            <button className="button button--secondary" disabled={data.pagination.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">
              上一页
            </button>
            <span className="muted">第 {data.pagination.page} / {Math.max(1, data.pagination.totalPages)} 页</span>
            <button className="button button--secondary" disabled={data.pagination.page >= data.pagination.totalPages} onClick={() => setPage((current) => current + 1)} type="button">
              下一页
            </button>
          </nav>
        </Surface>
      ) : null}
    </>
  );
}
