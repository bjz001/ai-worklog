"use client";

import type { PromptView, PromptsResponse } from "@ai-worklog/contracts";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";

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
    return `/api/v1/prompts?${params.toString()}`;
  }, [date, page, query, source]);
  const { data, error, loading, reload } = useApiResource<PromptsResponse>(path);
  const { openDrawer } = useDetailDrawer();
  const prompts = data?.data ?? [];
  const state = collectionState({ loading, error, count: prompts.length });

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryDraft.trim());
  };

  const showPrompt = (prompt: PromptView) => {
    openDrawer({
      title: prompt.projectName,
      subtitle: `${formatSource(prompt.sourceType)} · ${formatDateTime(prompt.occurredAt)}`,
      content: (
        <div className="stack">
          <section className="drawer-section">
            <h3>用户 Prompt</h3>
            <p className="prompt-content">{prompt.content}</p>
          </section>
          <section className="drawer-section">
            <h3>可见结果</h3>
            <p>{prompt.resultExcerpt ?? "这条 Prompt 没有关联的可见结果摘要。"}</p>
          </section>
          <section className="drawer-section">
            <h3>来源信息</h3>
            <dl className="definition-list">
              <dt>来源</dt><dd>{formatSource(prompt.sourceType)}</dd>
              <dt>设备</dt><dd>{prompt.deviceName}</dd>
              <dt>工作日期</dt><dd>{prompt.workDate}</dd>
              <dt>记录时间</dt><dd>{formatDateTime(prompt.occurredAt)}</dd>
              <dt>Prompt ID</dt><dd>{prompt.id}</dd>
            </dl>
          </section>
          {prompt.tags.length > 0 ? (
            <section className="drawer-section">
              <h3>标签</h3>
              <div className="tag-list">{prompt.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>
            </section>
          ) : null}
        </div>
      )
    });
  };

  return (
    <>
      <PageHeader description="搜索跨设备的脱敏 Prompt，并追溯可见结果与来源" title="Prompt 库" />
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
        </select>
        <label className="sr-only" htmlFor="prompt-date">工作日期</label>
        <input className="select" id="prompt-date" onChange={(event) => { setPage(1); setDate(event.target.value); }} type="date" value={date} />
        <button className="button button--primary" type="submit">搜索</button>
      </form>

      {state === "loading" ? <LoadingState rows={7} /> : null}
      {state === "error" && error ? <ErrorState error={error} onRetry={reload} /> : null}
      {state === "empty" ? (
        <EmptyState
          description={query || date || source ? "当前筛选条件下没有结果，请调整关键词、日期或来源。" : "完成同步后，可在这里搜索所有已脱敏的 Prompt。"}
          icon="prompt"
          title={query || date || source ? "没有匹配的 Prompt" : "Prompt 库为空"}
        />
      ) : null}
      {state === "ready" && data ? (
        <Surface title="Prompt 记录" description={`共 ${formatNumber(data.pagination.totalItems)} 条，第 ${data.pagination.page} / ${Math.max(1, data.pagination.totalPages)} 页`}>
          <div className="inbox-list prompt-list">
            {prompts.map((prompt) => (
              <button className="inbox-row" key={prompt.id} onClick={() => showPrompt(prompt)} type="button">
                <div className="inbox-row__primary">
                  <strong>{prompt.projectName}</strong>
                  <span>{formatSource(prompt.sourceType)} · {prompt.deviceName}</span>
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
