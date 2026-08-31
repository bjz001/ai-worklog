"use client";

import type {
  AgentEventKind,
  AgentRunsResponse,
  AgentSourceType,
  RawCaptureStatus
} from "@ai-worklog/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";

import {
  agentEventLabel,
  agentSourceLabel,
  attachmentStatusMeta,
  normalizedCoverageMeta,
  rawCaptureStatusMeta
} from "@/components/runs/agent-run-ui-model";
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
import { formatDateTime, formatNumber, summarizeText } from "@/lib/presenters";

const SOURCES: AgentSourceType[] = ["CODEX", "CLAUDE_CODE", "ZCODE", "DSH"];
const EVENT_KINDS: AgentEventKind[] = [
  "SYSTEM",
  "CONTEXT",
  "USER",
  "ASSISTANT",
  "REASONING",
  "TOOL_CALL",
  "TOOL_RESULT",
  "SUBAGENT",
  "STATE",
  "TURN_BOUNDARY",
  "ERROR",
  "SOURCE_EVENT"
];
const COMPLETENESS: RawCaptureStatus[] = [
  "CAPTURED",
  "PARTIAL",
  "NOT_EXPOSED",
  "UNREADABLE",
  "CORRUPT"
];

export function AgentRunsView() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const legacyDate = searchParams.get("date") ?? "";
  const projectId = searchParams.get("projectId") ?? "";
  const [queryDraft, setQueryDraft] = useState(searchParams.get("q") ?? "");
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [source, setSource] = useState(searchParams.get("source") ?? "");
  const [eventKind, setEventKind] = useState(searchParams.get("eventKind") ?? "");
  const [completeness, setCompleteness] = useState(searchParams.get("completeness") ?? "");
  const [from, setFrom] = useState(searchParams.get("from") ?? legacyDate);
  const [to, setTo] = useState(searchParams.get("to") ?? legacyDate);
  const [page, setPage] = useState(1);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (query) params.set("q", query);
    if (source) params.set("source", source);
    if (eventKind) params.set("eventKind", eventKind);
    if (completeness) params.set("completeness", completeness);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (projectId) params.set("projectId", projectId);
    return params.toString();
  }, [completeness, eventKind, from, page, projectId, query, source, to]);
  const { data, error, loading, reload } = useApiResource<AgentRunsResponse>(
    `/api/v1/agent-runs?${queryString}`
  );
  const runs = data?.data ?? [];
  const state = collectionState({ loading, error, count: runs.length });

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuery = queryDraft.trim();
    setPage(1);
    setQuery(nextQuery);
    const params = new URLSearchParams(queryString);
    params.set("page", "1");
    if (nextQuery) params.set("q", nextQuery);
    else params.delete("q");
    router.replace(`/runs?${params.toString()}`, { scroll: false });
  };

  const hasFilters = Boolean(query || source || eventKind || completeness || from || to || projectId);

  return (
    <>
      <PageHeader
        description="搜索来源实际暴露的 system、context、消息、reasoning、工具与状态事件"
        title="Agent 轨迹"
      />
      <form className="filter-bar agent-run-filters" onSubmit={submitSearch}>
        <label className="filter-search" htmlFor="agent-run-search">
          <Icon name="search" />
          <input
            id="agent-run-search"
            onChange={(event) => setQueryDraft(event.target.value)}
            placeholder="搜索完整轨迹文字、文件名或路径"
            type="search"
            value={queryDraft}
          />
        </label>
        <label className="sr-only" htmlFor="agent-run-source">来源</label>
        <select
          className="select"
          id="agent-run-source"
          onChange={(event) => { setPage(1); setSource(event.target.value); }}
          value={source}
        >
          <option value="">全部来源</option>
          {SOURCES.map((item) => <option key={item} value={item}>{agentSourceLabel(item)}</option>)}
        </select>
        <label className="sr-only" htmlFor="agent-run-kind">事件类型</label>
        <select
          className="select"
          id="agent-run-kind"
          onChange={(event) => { setPage(1); setEventKind(event.target.value); }}
          value={eventKind}
        >
          <option value="">全部事件</option>
          {EVENT_KINDS.map((item) => <option key={item} value={item}>{agentEventLabel(item)}</option>)}
        </select>
        <label className="sr-only" htmlFor="agent-run-completeness">完整性</label>
        <select
          className="select"
          id="agent-run-completeness"
          onChange={(event) => { setPage(1); setCompleteness(event.target.value); }}
          value={completeness}
        >
          <option value="">全部完整性</option>
          {COMPLETENESS.map((item) => (
            <option key={item} value={item}>{rawCaptureStatusMeta(item).label}</option>
          ))}
        </select>
        <label className="agent-run-date-field">
          <span>起</span>
          <input className="select" onChange={(event) => { setPage(1); setFrom(event.target.value); }} type="date" value={from} />
        </label>
        <label className="agent-run-date-field">
          <span>止</span>
          <input className="select" min={from || undefined} onChange={(event) => { setPage(1); setTo(event.target.value); }} type="date" value={to} />
        </label>
        <button className="button button--primary" type="submit">搜索</button>
      </form>

      {projectId ? (
        <div className="active-filter" role="status">
          <span><Icon name="folder" size={16} />正在查看指定项目的 Agent 轨迹</span>
          <Link className="button button--text" href="/runs">清除项目筛选</Link>
        </div>
      ) : null}

      {state === "loading" ? <LoadingState rows={7} /> : null}
      {state === "error" && error ? <ErrorState error={error} onRetry={reload} /> : null}
      {state === "empty" ? (
        <EmptyState
          description={hasFilters ? "当前筛选条件下没有 Prompt，请调整关键词或筛选。" : "运行采集器后，四类 Agent 的用户 Prompt 会进入这里。"}
          icon="prompt"
          title={hasFilters ? "没有匹配的 Agent 轨迹" : "Agent 轨迹为空"}
        />
      ) : null}
      {state === "ready" && data ? (
        <Surface
          description={`共 ${formatNumber(data.pagination.totalItems)} 个会话，第 ${data.pagination.page} / ${Math.max(1, data.pagination.totalPages)} 页`}
          title="会话轨迹"
        >
          <div className="agent-run-list">
            {runs.map((run) => {
              const raw = rawCaptureStatusMeta(run.rawCaptureStatus);
              const normalized = normalizedCoverageMeta(run.normalizedCoverage);
              const attachment = attachmentStatusMeta(run.attachmentStatus);
              return (
                <Link
                  className="agent-run-row"
                  href={query
                    ? `/runs/${encodeURIComponent(run.id)}?q=${encodeURIComponent(query)}`
                    : `/runs/${encodeURIComponent(run.id)}`}
                  key={run.id}
                >
                  <span className="agent-source-mark" data-source={run.sourceType}>{agentSourceLabel(run.sourceType).slice(0, 2)}</span>
                  <span className="agent-run-row__body">
                    <span className="agent-run-row__heading">
                      <strong>{run.title || run.projectName || run.sourceSessionId}</strong>
                      <small>{agentSourceLabel(run.sourceType)} · {run.deviceName}</small>
                    </span>
                    <span className="agent-run-row__snippet">
                      {run.matchSnippet ? summarizeText(run.matchSnippet, 180) : run.cwd || "无工作目录记录"}
                    </span>
                    <span className="agent-run-row__chips">
                      <StatusChip tone={raw.tone}>{raw.label}</StatusChip>
                      <StatusChip tone={normalized.tone}>{normalized.label}</StatusChip>
                      {run.attachmentStatus !== "NOT_APPLICABLE" ? (
                        <StatusChip tone={attachment.tone}>{attachment.label}</StatusChip>
                      ) : null}
                    </span>
                  </span>
                  <span className="agent-run-row__meta">
                    <strong>{formatNumber(run.eventCount)} 事件</strong>
                    <span>{formatNumber(run.turnCount)} 回合</span>
                    <span>{formatDateTime(run.startedAt)}</span>
                  </span>
                  <Icon name="chevron-right" />
                </Link>
              );
            })}
          </div>
          <nav aria-label="Agent 轨迹分页" className="pagination-bar">
            <button className="button button--secondary" disabled={data.pagination.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">上一页</button>
            <span className="muted">第 {data.pagination.page} / {Math.max(1, data.pagination.totalPages)} 页</span>
            <button className="button button--secondary" disabled={data.pagination.page >= data.pagination.totalPages} onClick={() => setPage((current) => current + 1)} type="button">下一页</button>
          </nav>
        </Surface>
      ) : null}
    </>
  );
}
