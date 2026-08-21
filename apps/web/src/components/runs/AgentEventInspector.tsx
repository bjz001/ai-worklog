"use client";

import type { AgentAttachmentView, AgentEventView } from "@ai-worklog/contracts";
import { useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { StatusChip } from "@/components/ui/StatusChip";
import { copyText } from "@/lib/copy-text";
import { formatDateTime } from "@/lib/presenters";

import {
  agentEventBadgeLabel,
  agentEventTone,
  attachmentStatusMeta,
  eventContentUrl,
  eventDisplayName,
  formatByteLength,
  normalizedCoverageMeta,
  preferredContentPurpose,
  rawCaptureStatusMeta,
  type AgentTextPurpose
} from "./agent-run-ui-model";

interface TextResourceState {
  text: string | null;
  loading: boolean;
  error: string | null;
  sha256: string | null;
  byteLength: number | null;
}

const EMPTY_TEXT_RESOURCE: TextResourceState = {
  text: null,
  loading: false,
  error: null,
  sha256: null,
  byteLength: null
};

function useTextResource(url: string | null, enabled = true): TextResourceState {
  const [state, setState] = useState<TextResourceState>(EMPTY_TEXT_RESOURCE);

  useEffect(() => {
    if (!url || !enabled) {
      setState(EMPTY_TEXT_RESOURCE);
      return;
    }
    const controller = new AbortController();
    setState({ ...EMPTY_TEXT_RESOURCE, loading: true });
    fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "text/plain, text/markdown, application/json" },
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) {
        let message = "完整正文读取失败";
        try {
          const payload = await response.json() as { error?: { message?: string } };
          message = payload.error?.message || message;
        } catch {
          // The endpoint may return a plain-text proxy error.
        }
        throw new Error(message);
      }
      const text = await response.text();
      return {
        text,
        loading: false,
        error: null,
        sha256: response.headers.get("x-content-sha256"),
        byteLength: Number(response.headers.get("content-length") ?? new TextEncoder().encode(text).byteLength)
      } satisfies TextResourceState;
    }).then(setState).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setState({
        ...EMPTY_TEXT_RESOURCE,
        error: error instanceof Error ? error.message : "完整正文读取失败"
      });
    });
    return () => controller.abort();
  }, [enabled, url]);

  return state;
}

function ContentActions({
  content,
  url,
  filename
}: {
  content: TextResourceState;
  url: string | null;
  filename: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (content.text === null) return;
    await copyText(content.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <span className="agent-content-actions">
      <button className="button button--text" disabled={content.text === null} onClick={handleCopy} type="button">
        {copied ? "已复制" : "复制全文"}
      </button>
      {url ? <a className="button button--text" download={filename} href={url}><Icon name="download" size={16} />下载</a> : null}
    </span>
  );
}

function EventContentPane({
  event,
  purpose,
  label,
  emptyText
}: {
  event: AgentEventView | null;
  purpose: AgentTextPurpose | null;
  label: string;
  emptyText: string;
}) {
  const url = event && purpose ? eventContentUrl(event, purpose) : null;
  const content = useTextResource(url);
  return (
    <section className="agent-io-pane">
      <header>
        <strong>{label}</strong>
        <span>{purpose ?? "无"}</span>
      </header>
      {content.loading ? <p className="agent-content-state">正在流式读取完整正文…</p> : null}
      {content.error ? <p className="agent-content-state agent-content-state--error" role="alert">{content.error}</p> : null}
      {!content.loading && !content.error && content.text === null ? <p className="agent-content-state">{emptyText}</p> : null}
      {content.text !== null ? <pre className="agent-code-block">{content.text}</pre> : null}
      {content.text !== null ? (
        <footer>
          <span>{formatByteLength(content.byteLength)}{content.sha256 ? ` · SHA-256 ${content.sha256}` : ""}</span>
          <ContentActions content={content} filename={`agent-event-${event?.sequence ?? "content"}.txt`} url={url} />
        </footer>
      ) : null}
    </section>
  );
}

function AttachmentTree({ attachments }: { attachments: AgentAttachmentView[] }) {
  if (attachments.length === 0) return null;
  return (
    <details className="agent-resource-tree" open>
      <summary>
        <span><Icon name="folder" size={17} />原始载荷与附件</span>
        <small>{attachments.length} 项</small>
      </summary>
      <ul>
        {attachments.map((attachment) => {
          const status = attachmentStatusMeta(attachment.status);
          return (
            <li key={attachment.id}>
              <span className="agent-resource-tree__file"><Icon name="code" size={16} /></span>
              <span className="agent-resource-tree__copy">
                <strong>{attachment.filename || attachment.requestedPath || attachment.referenceId}</strong>
                <span>{attachment.realPath || attachment.requestedPath || attachment.purpose}</span>
                <small>{formatByteLength(attachment.byteLength)}{attachment.sha256 ? ` · ${attachment.sha256}` : ""}</small>
                {attachment.failureReason ? <small className="text-danger">{attachment.failureReason}</small> : null}
              </span>
              <StatusChip tone={status.tone}>{status.label}</StatusChip>
              {attachment.downloadUrl ? <a aria-label={`下载 ${attachment.filename || "附件"}`} className="icon-button" href={attachment.downloadUrl}><Icon name="download" size={18} /></a> : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function RawPayload({ event }: { event: AgentEventView }) {
  const [enabled, setEnabled] = useState(false);
  const content = useTextResource(event.rawPayloadUrl, enabled);
  return (
    <details
      className="agent-raw-payload"
      onToggle={(toggleEvent) => {
        if (toggleEvent.currentTarget.open) setEnabled(true);
      }}
    >
      <summary>原始事件载荷（未脱敏）</summary>
      {!event.rawPayloadUrl ? <p className="agent-content-state">{event.missingReason || "来源未提供可读的原始载荷。"}</p> : null}
      {content.loading ? <p className="agent-content-state">正在读取原始载荷…</p> : null}
      {content.error ? <p className="agent-content-state agent-content-state--error" role="alert">{content.error}</p> : null}
      {content.text !== null ? <pre className="agent-code-block agent-code-block--raw">{content.text}</pre> : null}
      {content.text !== null ? (
        <footer>
          <span>{formatByteLength(content.byteLength)}{content.sha256 ? ` · SHA-256 ${content.sha256}` : ""}</span>
          <ContentActions content={content} filename={`agent-event-${event.sequence}-raw.json`} url={event.rawPayloadUrl} />
        </footer>
      ) : null}
    </details>
  );
}

export function AgentEventInspector({
  event,
  pairedInput,
  pairedOutput
}: {
  event: AgentEventView | null;
  pairedInput: AgentEventView | null;
  pairedOutput: AgentEventView | null;
}) {
  const primaryPurpose = event ? preferredContentPurpose(event) : null;
  const primaryUrl = event && primaryPurpose ? eventContentUrl(event, primaryPurpose) : null;
  const primary = useTextResource(primaryUrl);
  const metadataText = useMemo(
    () => event ? JSON.stringify(event.metadata, null, 2) : "",
    [event]
  );

  if (!event) {
    return (
      <section className="agent-event-inspector agent-event-inspector--empty">
        <Icon name="evidence" size={30} />
        <h2>选择一个事件</h2>
        <p>从右侧事件链选择一项，查看其完整正文、原始载荷与附件。</p>
      </section>
    );
  }

  const raw = rawCaptureStatusMeta(event.rawCaptureStatus);
  const normalized = normalizedCoverageMeta(event.normalizedCoverage);
  const attachment = attachmentStatusMeta(event.attachmentStatus);
  const inputEvent = event.kind === "TOOL_RESULT" ? pairedInput : event;
  const outputEvent = event.kind === "TOOL_CALL" ? pairedOutput : event.kind === "TOOL_RESULT" ? event : null;
  const inputPurpose = inputEvent ? preferredContentPurpose(inputEvent) : null;
  const outputPurpose = outputEvent ? preferredContentPurpose(outputEvent) : null;

  return (
    <article className="agent-event-inspector">
      <header className="agent-event-inspector__header">
        <span className={`agent-event-badge agent-event-badge--${agentEventTone(event.kind)}`}>{agentEventBadgeLabel(event)}</span>
        <div>
          <h2>{eventDisplayName(event)}</h2>
          <p>seq {event.sequence} · {formatDateTime(event.occurredAt)}{event.turnIndex !== null ? ` · 回合 ${event.turnIndex + 1}` : ""}</p>
        </div>
        <span className="agent-event-inspector__status">
          <StatusChip tone={raw.tone}>{raw.label}</StatusChip>
          <StatusChip tone={normalized.tone}>{normalized.label}</StatusChip>
          {event.attachmentStatus !== "NOT_APPLICABLE" ? <StatusChip tone={attachment.tone}>{attachment.label}</StatusChip> : null}
        </span>
      </header>

      {event.missingReason ? (
        <div className="notice notice--warning agent-event-missing" role="status">
          <Icon name="warning" />
          <div><strong>该事件不完整</strong><p>{event.missingReason}</p></div>
        </div>
      ) : null}

      <AttachmentTree attachments={event.attachments} />

      <section className="agent-context-window">
        <header>
          <div><strong>可观测上下文窗口</strong><span>来源实际暴露的完整正文</span></div>
          <span className="agent-context-window__legend"><i />本事件新增</span>
        </header>
        {primary.loading ? <p className="agent-content-state">正在流式读取完整正文…</p> : null}
        {primary.error ? <p className="agent-content-state agent-content-state--error" role="alert">{primary.error}</p> : null}
        {!primary.loading && !primary.error && primary.text === null ? <p className="agent-content-state">{event.missingReason || "该事件没有可展示的规范化正文。"}</p> : null}
        {primary.text !== null ? <pre className="agent-code-block agent-code-block--context">{primary.text}</pre> : null}
        {primary.text !== null ? (
          <footer>
            <span>{primaryPurpose} · {formatByteLength(primary.byteLength)}{primary.sha256 ? ` · SHA-256 ${primary.sha256}` : ""}</span>
            <ContentActions content={primary} filename={`agent-event-${event.sequence}.txt`} url={primaryUrl} />
          </footer>
        ) : null}
      </section>

      <section className="agent-io-section">
        <header><strong>调用输入与输出</strong><span>事件载荷</span></header>
        <div className="agent-io-grid">
          <EventContentPane emptyText="该事件没有输入载荷" event={inputEvent} label="输入" purpose={inputPurpose} />
          <EventContentPane emptyText="该调用尚无可观测输出" event={outputEvent} label="输出" purpose={outputPurpose} />
        </div>
      </section>

      <RawPayload event={event} />

      <details className="agent-event-metadata">
        <summary>事件标识与扩展元数据</summary>
        <dl>
          <dt>eventId</dt><dd>{event.eventId}</dd>
          <dt>sourceEventId</dt><dd>{event.sourceEventId || "未提供"}</dd>
          <dt>replyTo</dt><dd>{event.replyToEventId || "无"}</dd>
          <dt>mirrorOf</dt><dd>{event.mirrorOfEventId || "无"}</dd>
        </dl>
        <pre className="agent-code-block">{metadataText || "{}"}</pre>
      </details>
    </article>
  );
}
