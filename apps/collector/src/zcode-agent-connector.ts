import { lstat } from "node:fs/promises";
import { sha256Hex } from "@ai-worklog/core";
import type { AgentEventKind } from "@ai-worklog/contracts";
import {
  AgentCaptureBuilder,
  type AgentCapture,
  type AgentConnector
} from "./agent-connector.js";
import {
  asRecord,
  firstString,
  isoTimestamp,
  projectHint,
  searchableJson,
  textFromContent
} from "./agent-source-utils.js";
import { extractLiteralFilePaths } from "./attachment-capture.js";
import { readJsonlRecords, type JsonRecord } from "./jsonl-reader.js";

interface ZCodeAgentConnectorOptions {
  accountId: string;
  deviceId: string;
  sourceInstanceId: string;
  pathHmacKey?: string;
}

interface SpoolEntry {
  lineNumber: number;
  capturedAt: string;
  input: JsonRecord;
  rawHookInput: string;
  persistedTranscriptPath?: string;
  transcriptCaptureStatus?: string;
  transcriptCaptureError?: string;
}

function hookKind(name: string): AgentEventKind {
  if (name === "UserPromptSubmit") return "USER";
  if (name === "PreToolUse" || name === "PermissionRequest") return "TOOL_CALL";
  if (name === "PostToolUse") return "TOOL_RESULT";
  if (name === "PostToolUseFailure") return "ERROR";
  if (name === "Stop") return "ASSISTANT";
  return "STATE";
}

function hookRendered(input: JsonRecord, kind: AgentEventKind): {
  renderedText?: string;
  toolArguments?: string;
  toolResult?: string;
} {
  if (kind === "USER") return { renderedText: firstString(input.prompt) };
  if (kind === "ASSISTANT") {
    return { renderedText: firstString(input.last_assistant_message, input.lastAssistantMessage) };
  }
  if (kind === "TOOL_CALL") {
    return { toolArguments: searchableJson(input.tool_input ?? input.toolInput ?? {}) };
  }
  if (kind === "TOOL_RESULT" || kind === "ERROR") {
    const result = input.tool_response ?? input.toolResponse ?? input.error ?? input;
    return {
      toolResult: typeof result === "string" ? result : searchableJson(result)
    };
  }
  return { renderedText: searchableJson(input) };
}

async function existingRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

export class ZCodeAgentConnector implements AgentConnector {
  readonly sourceType = "ZCODE" as const;
  readonly parserVersion = "zcode-hook-spool-v1";
  readonly sourceInstanceId: string;
  private readonly options: ZCodeAgentConnectorOptions;

  constructor(options: ZCodeAgentConnectorOptions) {
    this.options = options;
    this.sourceInstanceId = options.sourceInstanceId;
  }

  async readSource(path: string): Promise<AgentCapture[]> {
    const entries: SpoolEntry[] = [];
    for await (const entry of readJsonlRecords(path, "ZCode Hook spool", {
      maxFileBytes: null,
      maxLineBytes: null
    })) {
      if (!entry.record) continue;
      const input = asRecord(entry.record.hookInput) ?? {};
      const capturedAt = isoTimestamp(
        entry.record.capturedAt,
        new Date(0).toISOString()
      );
      entries.push({
        lineNumber: entry.lineNumber,
        capturedAt,
        input,
        rawHookInput: firstString(entry.record.rawHookInput) ?? JSON.stringify(input),
        ...(firstString(entry.record.persistedTranscriptPath)
          ? { persistedTranscriptPath: firstString(entry.record.persistedTranscriptPath) }
          : {}),
        ...(firstString(entry.record.transcriptCaptureStatus)
          ? { transcriptCaptureStatus: firstString(entry.record.transcriptCaptureStatus) }
          : {}),
        ...(firstString(entry.record.transcriptCaptureError)
          ? { transcriptCaptureError: firstString(entry.record.transcriptCaptureError) }
          : {})
      });
    }
    if (entries.length === 0) return [];
    const first = entries[0];
    if (!first) return [];
    const originalSessionId = firstString(
      first.input.session_id,
      first.input.sessionId
    ) ?? `spool:${sha256Hex(path)}`;
    const sourceSessionId = originalSessionId.length <= 1_024
      ? originalSessionId
      : `sha256:${sha256Hex(originalSessionId)}`;
    const cwd = firstString(first.input.cwd);
    const hint = await projectHint({
      cwd,
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
      sourceSessionId,
      startedAt: first.capturedAt,
      endedAt: entries.at(-1)?.capturedAt ?? null,
      sourceTimeZone: "UTC",
      title: `ZCode · ${originalSessionId}`,
      cwd: cwd ?? null,
      ...(hint ? { projectHint: hint } : {}),
      metadata: {
        sourceArtifact: path,
        sourceSessionId: originalSessionId,
        captureMethod: "official-hooks"
      }
    });
    builder.addAttachment({
      eventId: null,
      purpose: "SOURCE_TRANSCRIPT",
      requestedPath: path,
      mediaType: "application/x-ndjson",
      metadata: { artifactKind: "zcode-hook-spool" }
    });
    const attachmentKeys = new Set<string>([`run\u001f${path}`]);
    const transcripts: string[] = [];
    let previousUserEventId: string | undefined;
    let sequence = 0;
    for (const entry of entries) {
      const name = firstString(
        entry.input.hook_event_name,
        entry.input.hookEventName
      ) ?? "UnknownHook";
      const kind = hookKind(name);
      const normalized = hookRendered(entry.input, kind);
      const toolUseId = firstString(
        entry.input.tool_use_id,
        entry.input.toolUseId
      );
      const event = builder.addEvent({
        sourceEventId: `${name}:${toolUseId ?? "event"}:line:${entry.lineNumber}`,
        sequence,
        kind,
        occurredAt: entry.capturedAt,
        ...(normalized.renderedText !== undefined
          ? { renderedText: normalized.renderedText }
          : {}),
        ...(normalized.toolArguments !== undefined
          ? { toolArguments: normalized.toolArguments }
          : {}),
        ...(normalized.toolResult !== undefined
          ? { toolResult: normalized.toolResult }
          : {}),
        rawPayload: entry.rawHookInput,
        ...(kind === "ASSISTANT" && previousUserEventId
          ? { replyToEventId: previousUserEventId }
          : {}),
        metadata: {
          hookEventName: name,
          toolName: firstString(entry.input.tool_name, entry.input.toolName) ?? null,
          toolUseId: toolUseId ?? null,
          permissionMode: firstString(
            entry.input.permission_mode,
            entry.input.permissionMode
          ) ?? null,
          transcriptCaptureStatus: entry.transcriptCaptureStatus ?? null,
          transcriptCaptureError: entry.transcriptCaptureError ?? null
        }
      });
      sequence += 1;
      if (kind === "USER") previousUserEventId = event.eventId;
      if (
        entry.persistedTranscriptPath &&
        !attachmentKeys.has(`${event.eventId}\u001f${entry.persistedTranscriptPath}`)
      ) {
        attachmentKeys.add(`${event.eventId}\u001f${entry.persistedTranscriptPath}`);
        transcripts.push(entry.persistedTranscriptPath);
        builder.addAttachment({
          eventId: event.eventId,
          purpose: "SOURCE_TRANSCRIPT",
          requestedPath: entry.persistedTranscriptPath,
          mediaType: "application/x-ndjson",
          metadata: { copiedDuringHookEvent: name }
        });
      }
      for (const requestedPath of extractLiteralFilePaths(entry.input)) {
        const attachmentKey = `${event.eventId}\u001f${requestedPath}`;
        if (attachmentKeys.has(attachmentKey)) continue;
        attachmentKeys.add(attachmentKey);
        builder.addAttachment({
          eventId: event.eventId,
          purpose: "ATTACHMENT",
          requestedPath,
          metadata: { discoveredFromHook: name }
        });
      }
    }

    const latestTranscript = transcripts.at(-1);
    if (latestTranscript && await existingRegularFile(latestTranscript)) {
      sequence = await this.addTranscriptEvents({
        builder,
        path: latestTranscript,
        sequence,
        startedAt: first.capturedAt,
        previousUserEventId
      });
      void sequence;
    }
    return [builder.finish()];
  }

  private async addTranscriptEvents(options: {
    builder: AgentCaptureBuilder;
    path: string;
    sequence: number;
    startedAt: string;
    previousUserEventId?: string;
  }): Promise<number> {
    let sequence = options.sequence;
    let previousUserEventId = options.previousUserEventId;
    for await (const entry of readJsonlRecords(options.path, "ZCode transcript", {
      maxFileBytes: null,
      maxLineBytes: null
    })) {
      if (!entry.record) continue;
      const message = asRecord(entry.record.message);
      const role = firstString(message?.role, entry.record.type) ?? "source";
      const text = message
        ? firstString(message.content) ?? textFromContent(message.content)
        : undefined;
      const kind: AgentEventKind = role === "user" && text !== undefined
        ? "USER"
        : role === "assistant" && text !== undefined
          ? "ASSISTANT"
          : "SOURCE_EVENT";
      const sourceId = firstString(
        entry.record.uuid,
        message?.id,
        entry.record.id
      ) ?? `line:${entry.lineNumber}`;
      const main = options.builder.addEvent({
        sourceEventId: `transcript:${sourceId}`,
        sequence,
        kind,
        occurredAt: isoTimestamp(entry.record.timestamp, options.startedAt),
        ...(text !== undefined ? { renderedText: text } : {}),
        rawPayload: entry.rawLine,
        ...(kind === "ASSISTANT" && previousUserEventId
          ? { replyToEventId: previousUserEventId }
          : {}),
        normalizedCoverage: kind === "SOURCE_EVENT" ? "PARTIAL" : "FULL",
        metadata: { fromPersistedZcodeTranscript: true, role }
      });
      sequence += 1;
      if (kind === "USER") previousUserEventId = main.eventId;

      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (let index = 0; index < blocks.length; index += 1) {
        const block = asRecord(blocks[index]);
        if (!block) continue;
        const type = String(block.type ?? "source_block");
        if (["text", "input_text", "output_text"].includes(type)) continue;
        const blockKind: AgentEventKind = /thinking|reason/iu.test(type)
          ? "REASONING"
          : /tool_use/iu.test(type)
            ? "TOOL_CALL"
            : /tool_result/iu.test(type)
              ? "TOOL_RESULT"
              : "SOURCE_EVENT";
        const renderedText = blockKind === "REASONING"
          ? firstString(block.thinking, block.reasoning, block.text)
          : blockKind === "SOURCE_EVENT"
            ? searchableJson(block)
            : undefined;
        options.builder.addEvent({
          sourceEventId: `transcript:${sourceId}:${type}:${index}`,
          sequence,
          kind: blockKind,
          occurredAt: isoTimestamp(entry.record.timestamp, options.startedAt),
          ...(renderedText !== undefined ? { renderedText } : {}),
          ...(blockKind === "TOOL_CALL"
            ? { toolArguments: searchableJson(block.input ?? block) }
            : {}),
          ...(blockKind === "TOOL_RESULT"
            ? {
                toolResult: firstString(block.content) ??
                  textFromContent(block.content) ?? searchableJson(block.content ?? block)
              }
            : {}),
          rawPayload: JSON.stringify(block),
          replyToEventId: main.eventId,
          metadata: { fromPersistedZcodeTranscript: true, blockType: type }
        });
        sequence += 1;
      }
    }
    return sequence;
  }
}
