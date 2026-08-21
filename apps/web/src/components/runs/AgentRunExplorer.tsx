"use client";

import type {
  AgentEventView,
  AgentRunDetailResponse,
  AgentRunEventsResponse
} from "@ai-worklog/contracts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { ErrorState, LoadingState } from "@/components/ui/PageElements";
import { StatusChip } from "@/components/ui/StatusChip";
import { useApiResource } from "@/hooks/use-api-resource";
import { fetchApi } from "@/lib/api-client";
import { formatDateTime, formatNumber } from "@/lib/presenters";

import { AgentEventInspector } from "./AgentEventInspector";
import { AgentEventTimeline } from "./AgentEventTimeline";
import { AgentRunResourceTree } from "./AgentRunResourceTree";
import {
  agentSourceLabel,
  attachmentStatusMeta,
  normalizedCoverageMeta,
  rawCaptureStatusMeta
} from "./agent-run-ui-model";

function findPairedInput(events: AgentEventView[], selected: AgentEventView | null) {
  if (!selected || selected.kind !== "TOOL_RESULT") return null;
  const directlyReferenced = selected.replyToEventId
    ? events.find((event) => event.eventId === selected.replyToEventId && event.kind === "TOOL_CALL")
    : null;
  if (directlyReferenced) return directlyReferenced;
  return events
    .filter((event) => event.kind === "TOOL_CALL" && event.sequence <= selected.sequence)
    .at(-1) ?? null;
}

function findPairedOutput(events: AgentEventView[], selected: AgentEventView | null) {
  if (!selected || selected.kind !== "TOOL_CALL") return null;
  const directlyReplying = events.find(
    (event) => event.kind === "TOOL_RESULT" && event.replyToEventId === selected.eventId
  );
  if (directlyReplying) return directlyReplying;
  return events.find(
    (event) => event.kind === "TOOL_RESULT" && event.sequence > selected.sequence
  ) ?? null;
}

export function AgentRunExplorer({ runId }: { runId: string }) {
  const searchParams = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const detailPath = `/api/v1/agent-runs/${encodeURIComponent(runId)}`;
  const eventsPath = `/api/v1/agent-runs/${encodeURIComponent(runId)}/events?pageSize=100`;
  const detail = useApiResource<AgentRunDetailResponse>(detailPath);
  const firstPage = useApiResource<AgentRunEventsResponse>(eventsPath);
  const [events, setEvents] = useState<AgentEventView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  useEffect(() => {
    if (!firstPage.data) return;
    setEvents(firstPage.data.data);
    setNextCursor(firstPage.data.pagination.nextCursor);
    setHasMore(firstPage.data.pagination.hasMore);
    setSelectedId((current) => {
      if (current && firstPage.data?.data.some((event) => event.id === current)) return current;
      return firstPage.data?.data.find((event) => !event.mirrorOfEventId)?.id
        ?? firstPage.data?.data[0]?.id
        ?? null;
    });
  }, [firstPage.data]);

  const selected = useMemo(
    () => events.find((event) => event.id === selectedId) ?? null,
    [events, selectedId]
  );
  const pairedInput = useMemo(() => findPairedInput(events, selected), [events, selected]);
  const pairedOutput = useMemo(() => findPairedOutput(events, selected), [events, selected]);
  const runAttachments = useMemo(() => {
    const unique = new Map<string, AgentEventView["attachments"][number]>();
    for (const item of detail.data?.data.attachments ?? []) {
      const path = item.realPath ?? item.requestedPath ?? item.filename ?? item.referenceId;
      unique.set(`${item.purpose}\u0000${path}\u0000${item.sha256 ?? item.referenceId}`, item);
    }
    for (const event of events) {
      for (const item of event.attachments) {
        const path = item.realPath ?? item.requestedPath ?? item.filename ?? item.referenceId;
        unique.set(`${item.purpose}\u0000${path}\u0000${item.sha256 ?? item.referenceId}`, item);
      }
    }
    return [...unique.values()];
  }, [detail.data?.data.attachments, events]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await fetchApi<AgentRunEventsResponse>(
        `${eventsPath}&cursor=${encodeURIComponent(nextCursor)}`
      );
      setEvents((current) => {
        const known = new Set(current.map((event) => event.id));
        return [...current, ...response.data.filter((event) => !known.has(event.id))];
      });
      setNextCursor(response.pagination.nextCursor);
      setHasMore(response.pagination.hasMore);
    } catch (error) {
      setLoadMoreError(error instanceof Error ? error.message : "后续事件加载失败");
    } finally {
      setLoadingMore(false);
    }
  };

  if (detail.loading || firstPage.loading) return <LoadingState rows={9} />;
  const pageError = detail.error ?? firstPage.error;
  if (pageError) {
    return <ErrorState error={pageError} onRetry={() => { detail.reload(); firstPage.reload(); }} />;
  }
  const payload = detail.data?.data;
  if (!payload) return null;
  const { run, completeness } = payload;
  const raw = rawCaptureStatusMeta(run.rawCaptureStatus);
  const normalized = normalizedCoverageMeta(run.normalizedCoverage);
  const attachment = attachmentStatusMeta(run.attachmentStatus);

  return (
    <div className="agent-run-explorer">
      <header className="agent-run-explorer__header">
        <div className="agent-run-explorer__title">
          <span><Icon name="code" size={18} /></span>
          <div>
            <h1>Agent 调用透明视图</h1>
            <p><i />已采集 · {formatNumber(run.eventCount)} 事件 · {formatNumber(run.turnCount)} 回合</p>
          </div>
        </div>
        <Link aria-label="关闭并返回 Agent 轨迹" className="icon-button" href={query ? `/runs?q=${encodeURIComponent(query)}` : "/runs"}>
          <Icon name="close" />
        </Link>
      </header>

      <details className="agent-run-resource" open>
        <summary>
          <span className="agent-run-resource__icon"><Icon name="folder" size={18} /></span>
          <span className="agent-run-resource__copy">
            <strong>{run.cwd || run.projectName || run.title || run.sourceSessionId}</strong>
            <small>{run.title || `查看 ${agentSourceLabel(run.sourceType)} 会话资源与捕获状态`}</small>
          </span>
          <span className="agent-run-resource__chips">
            <StatusChip tone={raw.tone}>{raw.label}</StatusChip>
            <StatusChip tone={normalized.tone}>{normalized.label}</StatusChip>
            {run.attachmentStatus !== "NOT_APPLICABLE" ? <StatusChip tone={attachment.tone}>{attachment.label}</StatusChip> : null}
          </span>
        </summary>
        <div className="agent-run-resource__details">
          {runAttachments.length > 0 ? (
            <AgentRunResourceTree attachments={runAttachments} rootHint={run.cwd || run.projectName} />
          ) : (
            <div className="agent-run-resource__empty">
              <Icon name="folder" size={18} />
              <span>当前已加载事件没有结构化文件引用</span>
            </div>
          )}
          <dl>
            <dt>来源</dt><dd>{agentSourceLabel(run.sourceType)}</dd>
            <dt>项目</dt><dd>{run.projectName}</dd>
            <dt>设备</dt><dd>{run.deviceName}</dd>
            <dt>开始</dt><dd>{formatDateTime(run.startedAt)}</dd>
            <dt>结束</dt><dd>{run.endedAt ? formatDateTime(run.endedAt) : "来源未记录"}</dd>
            <dt>正文分段</dt><dd>{formatNumber(completeness.textSegmentCount)}</dd>
            <dt>待同步 Blob</dt><dd>{formatNumber(completeness.pendingBlobCount)}</dd>
          </dl>
          {completeness.missingReasons.length > 0 ? (
            <div className="agent-run-resource__missing">
              <strong>已知缺失原因</strong>
              <ul>{completeness.missingReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </div>
          ) : null}
          <details>
            <summary>来源元数据</summary>
            <pre className="agent-code-block">{JSON.stringify(payload.metadata, null, 2)}</pre>
          </details>
        </div>
      </details>

      {loadMoreError ? <div className="agent-timeline-error" role="alert"><Icon name="error" size={17} />{loadMoreError}</div> : null}
      <div className="agent-run-explorer__workspace">
        <AgentEventInspector event={selected} pairedInput={pairedInput} pairedOutput={pairedOutput} />
        <AgentEventTimeline
          events={events}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          onSelect={(event) => setSelectedId(event.id)}
          query={query}
          selectedId={selectedId}
        />
      </div>
    </div>
  );
}
