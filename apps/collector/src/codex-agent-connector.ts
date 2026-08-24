import type { AgentEventKind } from "@ai-worklog/contracts";
import { sha256Hex } from "@ai-worklog/core";
import {
  AgentCaptureBuilder,
  type AgentCapture,
  type AgentConnector
} from "./agent-connector.js";
import {
  asRecord,
  firstString,
  isoTimestamp,
  numericIndex,
  optionalString,
  projectHint,
  searchableJson,
  textFromContent
} from "./agent-source-utils.js";
import { extractLiteralFilePaths } from "./attachment-capture.js";
import { readJsonlRecords, type JsonRecord } from "./jsonl-reader.js";

interface CodexAgentConnectorOptions {
  accountId: string;
  deviceId: string;
  sourceInstanceId: string;
  pathHmacKey?: string;
}

interface CodexMeta {
  sessionId: string;
  cwd?: string;
  sourceTimeZone: string;
  startedAt: string;
  gitRemote?: string;
}

interface NormalizedCodexRecord {
  kind: AgentEventKind;
  sourceEventId: string;
  renderedText?: string;
  toolArguments?: string;
  toolResult?: string;
  rawCaptureStatus?: "CAPTURED" | "UNREADABLE";
  normalizedCoverage?: "FULL" | "PARTIAL" | "NONE";
  missingReason?: string;
  metadata: Record<string, unknown>;
}

function toolName(payload: JsonRecord): string | undefined {
  return firstString(payload.name, payload.tool_name, payload.toolName);
}

function codexRecord(
  record: JsonRecord,
  payload: JsonRecord,
  lineNumber: number
): NormalizedCodexRecord {
  const envelopeType = String(record.type ?? "");
  const payloadType = String(payload.type ?? "");
  const sourceEventId = firstString(
    payload.id,
    payload.call_id,
    payload.client_id,
    record.id
  ) ?? `${envelopeType || "source"}:${payloadType || "event"}:line:${lineNumber}`;
  const metadata: Record<string, unknown> = {
    sourceEnvelopeType: envelopeType,
    sourcePayloadType: payloadType,
    ...(toolName(payload) ? { toolName: toolName(payload) } : {})
  };

  if (envelopeType === "session_meta") {
    return {
      kind: "STATE",
      sourceEventId,
      renderedText: searchableJson(payload),
      metadata
    };
  }
  if (envelopeType === "turn_context") {
    return {
      kind: "CONTEXT",
      sourceEventId,
      renderedText: searchableJson(payload),
      metadata
    };
  }
  if (envelopeType === "event_msg") {
    if (payloadType === "user_message") {
      return {
        kind: "USER",
        sourceEventId: optionalString(payload.client_id) ?? `event-user-line:${lineNumber}`,
        renderedText: firstString(payload.message, textFromContent(payload.content)),
        metadata
      };
    }
    if (payloadType === "agent_message") {
      return {
        kind: "ASSISTANT",
        sourceEventId: `event-agent-line:${lineNumber}`,
        renderedText: firstString(payload.message, textFromContent(payload.content)),
        metadata
      };
    }
    if (/reason/iu.test(payloadType)) {
      return {
        kind: "REASONING",
        sourceEventId,
        renderedText: firstString(
          payload.message,
          payload.text,
          textFromContent(payload.summary),
          textFromContent(payload.content)
        ),
        metadata
      };
    }
  }
  if (envelopeType === "response_item") {
    if (payloadType === "message") {
      const role = String(payload.role ?? "");
      const kind: AgentEventKind = role === "user"
        ? "USER"
        : role === "assistant"
          ? "ASSISTANT"
          : role === "system"
            ? "SYSTEM"
            : "CONTEXT";
      return {
        kind,
        sourceEventId,
        renderedText: textFromContent(payload.content) ?? optionalString(payload.content),
        metadata: { ...metadata, role }
      };
    }
    if (/reason/iu.test(payloadType)) {
      const renderedText = firstString(
        payload.text,
        textFromContent(payload.summary),
        textFromContent(payload.content)
      );
      const encryptedOnly = renderedText === undefined &&
        firstString(payload.encrypted_content, payload.encryptedContent) !== undefined;
      return {
        kind: "REASONING",
        sourceEventId,
        ...(renderedText !== undefined ? { renderedText } : {}),
        ...(encryptedOnly
          ? {
              rawCaptureStatus: "UNREADABLE" as const,
              normalizedCoverage: "NONE" as const,
              missingReason: "Source exposed encrypted reasoning bytes only"
            }
          : {}),
        metadata: { ...metadata, encryptedOnly }
      };
    }
    if (/output|result/iu.test(payloadType)) {
      const result = firstString(
        payload.output,
        payload.result,
        payload.content,
        payload.text
      ) ?? searchableJson(payload);
      return {
        kind: "TOOL_RESULT",
        sourceEventId,
        toolResult: result,
        metadata
      };
    }
    if (/call|tool|search/iu.test(payloadType)) {
      let input: unknown = payload.arguments ?? payload.input ?? payload.query ?? payload;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          // A literal command/query remains complete as a string value.
        }
      }
      return {
        kind: "TOOL_CALL",
        sourceEventId,
        toolArguments: searchableJson(input),
        metadata
      };
    }
  }
  if (/error|fail/iu.test(envelopeType) || /error|fail/iu.test(payloadType)) {
    return {
      kind: "ERROR",
      sourceEventId,
      renderedText: searchableJson(payload),
      metadata
    };
  }
  if (/world|state|compact|token|task|turn/iu.test(envelopeType)) {
    return {
      kind: /turn/iu.test(envelopeType) ? "TURN_BOUNDARY" : "STATE",
      sourceEventId,
      renderedText: searchableJson(payload),
      metadata
    };
  }
  return {
    kind: "SOURCE_EVENT",
    sourceEventId,
    renderedText: searchableJson(payload),
    normalizedCoverage: "PARTIAL",
    metadata: { ...metadata, unknownSourceRecord: true }
  };
}

export class CodexAgentConnector implements AgentConnector {
  readonly sourceType = "CODEX" as const;
  readonly parserVersion = "codex-agent-jsonl-v1";
  readonly sourceInstanceId: string;
  private readonly options: CodexAgentConnectorOptions;

  constructor(options: CodexAgentConnectorOptions) {
    this.options = options;
    this.sourceInstanceId = options.sourceInstanceId;
  }

  async readSource(path: string): Promise<AgentCapture[]> {
    const meta = await this.readMeta(path);
    const hint = await projectHint({
      cwd: meta.cwd,
      reportedGitRemote: meta.gitRemote,
      accountId: this.options.accountId,
      deviceId: this.options.deviceId,
      pathHmacKey: this.options.pathHmacKey
    });
    const builder = new AgentCaptureBuilder({
      accountId: this.options.accountId,
      deviceId: this.options.deviceId,
      sourceType: this.sourceType,
      sourceInstanceId: this.sourceInstanceId,
      parserVersion: this.parserVersion,
      sourceSessionId: meta.sessionId,
      startedAt: meta.startedAt,
      sourceTimeZone: meta.sourceTimeZone,
      cwd: meta.cwd ?? null,
      ...(hint ? { projectHint: hint } : {}),
      metadata: { sourceArtifact: path }
    });
    builder.addAttachment({
      eventId: null,
      purpose: "SOURCE_TRANSCRIPT",
      requestedPath: path,
      mediaType: "application/x-ndjson"
    });
    const attachmentKeys = new Set<string>([`run\u001f${path}`]);
    let previousUserEventId: string | undefined;
    const mirrorByText = new Map<string, {
      eventId: string;
      sequence: number;
      envelopeType: string;
    }>();
    const sourceEventOccurrences = new Map<string, number>();
    for await (const entry of readJsonlRecords(path, "Codex", {
      maxFileBytes: null,
      maxLineBytes: null
    })) {
      if (!entry.record) continue;
      const payload = asRecord(entry.record.payload) ?? entry.record;
      const normalized = codexRecord(entry.record, payload, entry.lineNumber);
      const occurrence = sourceEventOccurrences.get(normalized.sourceEventId) ?? 0;
      sourceEventOccurrences.set(normalized.sourceEventId, occurrence + 1);
      // Codex intentionally reuses call_id for a function_call and its
      // function_call_output. Preserve the first stable identity for v1
      // compatibility, then deterministically disambiguate later source events.
      const sourceEventId = occurrence === 0
        ? normalized.sourceEventId
        : `${normalized.sourceEventId}:occurrence:${occurrence}:line:${entry.lineNumber}`;
      const rendered = normalized.renderedText ?? normalized.toolArguments ??
        normalized.toolResult;
      const mirrorKey = rendered && ["USER", "ASSISTANT"].includes(normalized.kind)
        ? `${normalized.kind}\u001f${rendered.replace(/\s+/gu, " ").trim()}`
        : null;
      const priorMirror = mirrorKey ? mirrorByText.get(mirrorKey) : undefined;
      const envelopeType = String(normalized.metadata.sourceEnvelopeType ?? "");
      const mirrorOfEventId = priorMirror &&
        entry.lineNumber - 1 - priorMirror.sequence <= 3 &&
        priorMirror.envelopeType !== envelopeType &&
        new Set([priorMirror.envelopeType, envelopeType]).size === 2 &&
        [priorMirror.envelopeType, envelopeType].every((type) =>
          type === "event_msg" || type === "response_item"
        )
        ? priorMirror.eventId
        : undefined;
      const event = builder.addEvent({
        sourceEventId,
        sequence: entry.lineNumber - 1,
        kind: normalized.kind,
        occurredAt: isoTimestamp(entry.record.timestamp, meta.startedAt),
        turnIndex: numericIndex(payload.turn ?? payload.turn_index),
        stepIndex: numericIndex(payload.step ?? payload.step_index),
        ...(normalized.renderedText !== undefined
          ? { renderedText: normalized.renderedText }
          : {}),
        ...(normalized.toolArguments !== undefined
          ? { toolArguments: normalized.toolArguments }
          : {}),
        ...(normalized.toolResult !== undefined
          ? { toolResult: normalized.toolResult }
          : {}),
        rawPayload: entry.rawLine,
        ...(normalized.kind === "ASSISTANT" && previousUserEventId
          ? { replyToEventId: previousUserEventId }
          : {}),
        ...(mirrorOfEventId ? { mirrorOfEventId } : {}),
        rawCaptureStatus: normalized.rawCaptureStatus,
        normalizedCoverage: normalized.normalizedCoverage,
        missingReason: normalized.missingReason,
        metadata: occurrence === 0
          ? normalized.metadata
          : {
              ...normalized.metadata,
              repeatedSourceEventId: normalized.sourceEventId,
              sourceEventOccurrence: occurrence
            }
      });
      if (mirrorKey) {
        if (mirrorOfEventId) mirrorByText.delete(mirrorKey);
        else mirrorByText.set(mirrorKey, {
          eventId: event.eventId,
          sequence: entry.lineNumber - 1,
          envelopeType
        });
      }
      if (normalized.kind === "USER") previousUserEventId = event.eventId;
      for (const requestedPath of extractLiteralFilePaths(entry.record)) {
        const attachmentKey = `${event.eventId}\u001f${requestedPath}`;
        if (attachmentKeys.has(attachmentKey)) continue;
        attachmentKeys.add(attachmentKey);
        builder.addAttachment({
          eventId: event.eventId,
          purpose: "ATTACHMENT",
          requestedPath,
          metadata: { discoveredFrom: "structured-or-static-literal" }
        });
      }
    }
    return [builder.finish()];
  }

  private async readMeta(path: string): Promise<CodexMeta> {
    let startedAt = new Date(0).toISOString();
    for await (const entry of readJsonlRecords(path, "Codex", {
      maxFileBytes: null,
      maxLineBytes: null
    })) {
      if (!entry.record) continue;
      startedAt = isoTimestamp(entry.record.timestamp, startedAt);
      if (entry.record.type !== "session_meta") continue;
      const payload = asRecord(entry.record.payload);
      if (!payload) continue;
      const git = asRecord(payload.git);
      const sessionId = optionalString(payload.id);
      if (!sessionId) throw new Error("Codex session_meta has no session id");
      return {
        sessionId: sessionId.length <= 1_024
          ? sessionId
          : `sha256:${sha256Hex(sessionId)}`,
        cwd: optionalString(payload.cwd),
        sourceTimeZone: optionalString(payload.source_time_zone) ?? "UTC",
        startedAt,
        gitRemote: firstString(git?.repository_url, git?.remote, git?.url)
      };
    }
    throw new Error("Codex session_meta is missing");
  }
}
