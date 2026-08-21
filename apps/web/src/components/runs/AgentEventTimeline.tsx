"use client";

import type { AgentEventView } from "@ai-worklog/contracts";
import { useMemo, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { formatDateTime, summarizeText } from "@/lib/presenters";

import {
  agentEventBadgeLabel,
  agentEventTone,
  eventDisplayName,
  isMirrorEvent
} from "./agent-run-ui-model";

function HighlightedText({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return <>{text}</>;
  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = normalizedQuery.toLocaleLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  let index = lowerText.indexOf(lowerQuery);
  while (index >= 0) {
    if (index > cursor) parts.push({ text: text.slice(cursor, index), match: false });
    parts.push({ text: text.slice(index, index + normalizedQuery.length), match: true });
    cursor = index + normalizedQuery.length;
    index = lowerText.indexOf(lowerQuery, cursor);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return <>{parts.map((part, indexValue) => part.match
    ? <mark key={indexValue}>{part.text}</mark>
    : <span key={indexValue}>{part.text}</span>)}</>;
}

export function AgentEventTimeline({
  events,
  selectedId,
  onSelect,
  query = "",
  hasMore,
  loadingMore,
  onLoadMore
}: {
  events: AgentEventView[];
  selectedId: string | null;
  onSelect: (event: AgentEventView) => void;
  query?: string;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const [showMirrors, setShowMirrors] = useState(false);
  const mirrorCount = useMemo(
    () => events.reduce((count, event) => count + (isMirrorEvent(event) ? 1 : 0), 0),
    [events]
  );
  const visibleEvents = showMirrors ? events : events.filter((event) => !isMirrorEvent(event));

  return (
    <aside aria-label="Agent 事件链" className="agent-event-timeline">
      <header className="agent-event-timeline__header">
        <div>
          <strong>事件链</strong>
          <span>显示提示词注入、思考、工具调用、结果与错误</span>
        </div>
        {mirrorCount > 0 ? (
          <button
            aria-pressed={showMirrors}
            className="button button--text agent-mirror-toggle"
            onClick={() => setShowMirrors((value) => !value)}
            type="button"
          >
            {showMirrors ? "折叠镜像" : `显示 ${mirrorCount} 个镜像`}
          </button>
        ) : null}
      </header>
      <div className="agent-event-chain" role="list">
        {visibleEvents.map((event, index) => {
          const previous = visibleEvents[index - 1];
          const startsTurn = event.turnIndex !== null && event.turnIndex !== previous?.turnIndex;
          const tone = agentEventTone(event.kind);
          return (
            <div className="agent-event-chain__item" key={event.id} role="listitem">
              {startsTurn ? <div className="agent-turn-marker">回合 {event.turnIndex! + 1}</div> : null}
              <button
                aria-current={selectedId === event.id ? "true" : undefined}
                className={`agent-event-row ${selectedId === event.id ? "agent-event-row--selected" : ""}`}
                data-tone={tone}
                onClick={() => onSelect(event)}
                type="button"
              >
                <span className="agent-event-row__dot" />
                <span className="agent-event-row__copy">
                  <span className="agent-event-row__title">
                    <span className={`agent-event-badge agent-event-badge--${tone}`}>{agentEventBadgeLabel(event)}</span>
                    <strong>{eventDisplayName(event)}</strong>
                  </span>
                  <span className="agent-event-row__preview">
                    <HighlightedText query={query} text={summarizeText(event.contentPreview || event.missingReason || "该事件无可展示正文", 88)} />
                  </span>
                  <span className="agent-event-row__sequence">seq {event.sequence} · {formatDateTime(event.occurredAt)}</span>
                </span>
                <Icon name="chevron-right" size={18} />
              </button>
            </div>
          );
        })}
      </div>
      {hasMore ? (
        <div className="agent-event-timeline__more">
          <button className="button button--secondary" disabled={loadingMore} onClick={onLoadMore} type="button">
            {loadingMore ? "加载中…" : "加载更多事件"}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
