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
  optionalString,
  projectHint,
  searchableJson,
  textFromContent
} from "./agent-source-utils.js";
import { extractLiteralFilePaths } from "./attachment-capture.js";
import { readJsonlRecords, type JsonRecord } from "./jsonl-reader.js";

interface ClaudeCodeAgentConnectorOptions {
  accountId: string;
  deviceId: string;
  sourceInstanceId: string;
  pathHmacKey?: string;
}

interface ClaudeMeta {
  sessionId: string;
  cwd?: string;
  sourceTimeZone: string;
  startedAt: string;
  gitRemote?: string;
  gitBranch?: string;
}

function messageText(message: JsonRecord): string | undefined {
  return optionalString(message.content) ?? textFromContent(message.content);
}

function blockKind(type: string): AgentEventKind {
  if (["thinking", "reasoning", "redacted_thinking"].includes(type)) {
    return "REASONING";
  }
  if (["tool_use", "server_tool_use", "mcp_tool_use"].includes(type)) {
    return "TOOL_CALL";
  }
  if (["tool_result", "server_tool_result", "mcp_tool_result"].includes(type)) {
    return "TOOL_RESULT";
  }
  if (/error|failure/iu.test(type)) return "ERROR";
  return "SOURCE_EVENT";
}

export class ClaudeCodeAgentConnector implements AgentConnector {
  readonly sourceType = "CLAUDE_CODE" as const;
  readonly parserVersion = "claude-code-agent-jsonl-v1";
  readonly sourceInstanceId: string;
  private readonly options: ClaudeCodeAgentConnectorOptions;

  constructor(options: ClaudeCodeAgentConnectorOptions) {
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
      metadata: {
        sourceArtifact: path,
        ...(meta.gitBranch ? { gitBranch: meta.gitBranch } : {})
      }
    });
    builder.addAttachment({
      eventId: null,
      purpose: "SOURCE_TRANSCRIPT",
      requestedPath: path,
      mediaType: "application/x-ndjson"
    });
    const attachmentKeys = new Set<string>([`run\u001f${path}`]);
    const eventBySourceId = new Map<string, string>();
    let previousUserEventId: string | undefined;
    let sequence = 0;

    for await (const entry of readJsonlRecords(path, "Claude Code", {
      maxFileBytes: null,
      maxLineBytes: null
    })) {
      if (!entry.record) continue;
      const message = asRecord(entry.record.message);
      const uuid = firstString(
        entry.record.uuid,
        message?.id,
        entry.record.id
      ) ?? `source-line:${entry.lineNumber}`;
      const role = firstString(message?.role, entry.record.type) ?? "source";
      const visibleText = message ? messageText(message) : undefined;
      const topLevelKind: AgentEventKind = role === "user" && visibleText !== undefined
        ? "USER"
        : role === "assistant" && visibleText !== undefined
          ? "ASSISTANT"
          : role === "system"
            ? "SYSTEM"
            : "SOURCE_EVENT";
      const parentSourceId = optionalString(entry.record.parentUuid);
      const replyToEventId = parentSourceId
        ? eventBySourceId.get(parentSourceId)
        : topLevelKind === "ASSISTANT"
          ? previousUserEventId
          : undefined;
      const mainEvent = builder.addEvent({
        sourceEventId: uuid,
        sequence,
        kind: topLevelKind,
        occurredAt: isoTimestamp(entry.record.timestamp, meta.startedAt),
        ...(visibleText !== undefined ? { renderedText: visibleText } : {}),
        rawPayload: entry.rawLine,
        ...(replyToEventId ? { replyToEventId } : {}),
        normalizedCoverage: topLevelKind === "SOURCE_EVENT" ? "PARTIAL" : "FULL",
        metadata: {
          role,
          sourceType: entry.record.type ?? null,
          isSidechain: entry.record.isSidechain === true,
          parentUuid: parentSourceId ?? null
        }
      });
      sequence += 1;
      eventBySourceId.set(uuid, mainEvent.eventId);
      if (topLevelKind === "USER") previousUserEventId = mainEvent.eventId;

      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
        const block = asRecord(blocks[blockIndex]);
        if (!block) continue;
        const type = String(block.type ?? "source_block");
        if (["text", "input_text", "output_text"].includes(type)) continue;
        const kind = blockKind(type);
        const blockIdentity = firstString(block.id, block.tool_use_id) ??
          String(blockIndex);
        const blockId = `${uuid}:${type}:${blockIdentity}`;
        const exposedReasoning = firstString(
          block.thinking,
          block.reasoning,
          block.text
        );
        let toolArguments: string | undefined;
        let toolResult: string | undefined;
        let renderedText: string | undefined;
        if (kind === "TOOL_CALL") {
          toolArguments = searchableJson(block.input ?? block.arguments ?? block);
        } else if (kind === "TOOL_RESULT") {
          toolResult = optionalString(block.content) ??
            textFromContent(block.content) ?? searchableJson(block.content ?? block);
        } else if (kind === "REASONING") {
          renderedText = exposedReasoning;
        } else {
          renderedText = searchableJson(block);
        }
        const encryptedOnly = kind === "REASONING" &&
          renderedText === undefined &&
          firstString(block.data, block.encrypted_content) !== undefined;
        const blockEvent = builder.addEvent({
          sourceEventId: blockId,
          sequence,
          kind,
          occurredAt: isoTimestamp(entry.record.timestamp, meta.startedAt),
          ...(renderedText !== undefined ? { renderedText } : {}),
          ...(toolArguments !== undefined ? { toolArguments } : {}),
          ...(toolResult !== undefined ? { toolResult } : {}),
          rawPayload: JSON.stringify(block),
          replyToEventId: mainEvent.eventId,
          ...(encryptedOnly
            ? {
                rawCaptureStatus: "UNREADABLE" as const,
                normalizedCoverage: "NONE" as const,
                missingReason: "Source exposed encrypted thinking bytes only"
              }
            : {}),
          metadata: {
            blockType: type,
            blockIndex,
            toolName: firstString(block.name, block.tool_name) ?? null,
            isSidechain: entry.record.isSidechain === true,
            unknownContentBlock: kind === "SOURCE_EVENT"
          }
        });
        sequence += 1;
        for (const requestedPath of extractLiteralFilePaths(block)) {
          const attachmentKey = `${blockEvent.eventId}\u001f${requestedPath}`;
          if (attachmentKeys.has(attachmentKey)) continue;
          attachmentKeys.add(attachmentKey);
          builder.addAttachment({
            eventId: blockEvent.eventId,
            purpose: "ATTACHMENT",
            requestedPath,
            metadata: { sourceBlockType: type }
          });
        }
      }

      for (const requestedPath of extractLiteralFilePaths(entry.record)) {
        const attachmentKey = `${mainEvent.eventId}\u001f${requestedPath}`;
        if (attachmentKeys.has(attachmentKey)) continue;
        attachmentKeys.add(attachmentKey);
        builder.addAttachment({
          eventId: mainEvent.eventId,
          purpose: "ATTACHMENT",
          requestedPath,
          metadata: { discoveredFrom: "structured-or-static-literal" }
        });
      }
    }
    return [builder.finish()];
  }

  private async readMeta(path: string): Promise<ClaudeMeta> {
    let firstRecord: JsonRecord | null = null;
    for await (const entry of readJsonlRecords(path, "Claude Code", {
      maxFileBytes: null,
      maxLineBytes: null
    })) {
      if (entry.record) {
        firstRecord = entry.record;
        break;
      }
    }
    if (!firstRecord) throw new Error("Claude Code transcript is empty");
    const sessionId = firstString(firstRecord.sessionId, firstRecord.session_id);
    if (!sessionId) throw new Error("Claude Code session id is missing");
    const git = asRecord(firstRecord.git);
    return {
      sessionId: sessionId.length <= 1_024
        ? sessionId
        : `sha256:${sha256Hex(sessionId)}`,
      cwd: firstString(firstRecord.cwd, firstRecord.workingDirectory),
      sourceTimeZone: firstString(
        firstRecord.sourceTimeZone,
        firstRecord.source_time_zone
      ) ?? "UTC",
      startedAt: isoTimestamp(
        firstRecord.timestamp ?? firstRecord.createdAt ?? firstRecord.created_at,
        new Date(0).toISOString()
      ),
      gitRemote: firstString(
        firstRecord.gitRemote,
        firstRecord.gitRemoteUrl,
        firstRecord.repositoryUrl,
        git?.repository_url,
        git?.remote,
        git?.url
      ),
      gitBranch: firstString(firstRecord.gitBranch, firstRecord.git_branch)
    };
  }
}
