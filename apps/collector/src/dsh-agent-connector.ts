import { Context } from "@deepseek-ai/cordis";
import SessionStore, {
  SessionId,
  type SessionEvent,
  type SessionHeader
} from "@deepseek-ai/dsh-session";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import SqliteSessionPersistence from "@deepseek-ai/dsh-session-persistence-sqlite";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { AgentEventKind } from "@ai-worklog/contracts";
import {
  buildAgentEventId,
  buildAgentRunId,
  sha256Hex
} from "@ai-worklog/core";
import {
  AgentCaptureBuilder,
  type AgentCapture,
  type AgentConnector
} from "./agent-connector.js";
import {
  asRecord,
  firstString,
  numericIndex,
  projectHint,
  searchableJson,
  textFromContent
} from "./agent-source-utils.js";
import { extractLiteralFilePaths } from "./attachment-capture.js";

export interface DshLogicalEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  sourceEventSeqs?: readonly number[];
  surfaceOp?: unknown;
  ignorable?: true;
  [key: string]: unknown;
}

export interface DshDecodedSession {
  meta: SessionHeader | {
    version: number;
    id: string;
    createdAt: number;
    cwd?: string;
    parentSession?: string;
    seedLength?: number;
    origin?: "subagent";
    delegationDepth?: number;
    agentPreset?: string;
  };
  events: readonly DshLogicalEvent[];
  artifactPath?: string;
}

export interface DshSessionDecoder {
  inspect(path: string): Promise<DshDecodedSession[]>;
}

function boundedSourceSessionId(value: string): string {
  return value.length <= 1_024 ? value : `sha256:${sha256Hex(value)}`;
}

async function allFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

function jsonlRootFromArtifact(path: string): string {
  const name = basename(path).toLowerCase();
  if (name !== "session.jsonl" && name !== "session.jsonl.zstd") {
    throw new Error("DSH JSONL artifact must be named session.jsonl or session.jsonl.zstd");
  }
  return dirname(dirname(dirname(resolve(path))));
}

class OfficialDshSessionDecoder implements DshSessionDecoder {
  async inspect(path: string): Promise<DshDecodedSession[]> {
    const source = await lstat(path);
    if (source.isSymbolicLink()) throw new Error("DSH source symlinks are not allowed");
    if (source.isFile()) {
      const lower = path.toLowerCase();
      if ([".db", ".sqlite", ".sqlite3"].includes(extname(lower))) {
        return this.inspectSqlite(resolve(path));
      }
      if (lower.endsWith(".jsonl") || lower.endsWith(".jsonl.zstd")) {
        return this.inspectJsonl(jsonlRootFromArtifact(path));
      }
      throw new Error("Unsupported DSH persistence artifact");
    }
    if (!source.isDirectory()) throw new Error("DSH source is not a file or directory");
    return this.inspectJsonl(resolve(path));
  }

  private async inspectJsonl(root: string): Promise<DshDecodedSession[]> {
    const files = await allFiles(root);
    const hasZstd = files.some((path) => path.toLowerCase().endsWith("session.jsonl.zstd"));
    const hasPlain = files.some((path) => path.toLowerCase().endsWith("session.jsonl"));
    if (hasZstd && hasPlain) {
      throw new Error("DSH JSONL root mixes plaintext and zstd encodings");
    }
    if (!hasZstd && !hasPlain) return [];
    const ctx = new Context();
    await ctx.plugin(SessionStore);
    await ctx.plugin(JsonlSessionPersistence, {
      root,
      compression: hasZstd ? "zstd" : "none"
    });
    try {
      const headers = await ctx.sessionPersistence.list();
      const decoded: DshDecodedSession[] = [];
      for (const header of headers) {
        const inspection = await ctx.sessionPersistence.inspect(header.id);
        decoded.push({
          meta: inspection.meta,
          events: inspection.events as readonly SessionEvent[] as readonly DshLogicalEvent[],
          artifactPath: ctx.sessionPersistence.locate(inspection.meta)?.path
        });
      }
      return decoded;
    } finally {
      await ctx.fiber.dispose();
    }
  }

  private async inspectSqlite(path: string): Promise<DshDecodedSession[]> {
    const ctx = new Context();
    await ctx.plugin(SessionStore);
    await ctx.plugin(SqliteSessionPersistence, { path });
    try {
      const headers = await ctx.sessionPersistence.list();
      const decoded: DshDecodedSession[] = [];
      for (const header of headers) {
        const inspection = await ctx.sessionPersistence.inspect(header.id);
        decoded.push({
          meta: inspection.meta,
          events: inspection.events as readonly SessionEvent[] as readonly DshLogicalEvent[],
          artifactPath: path
        });
      }
      return decoded;
    } finally {
      await ctx.fiber.dispose();
    }
  }
}

interface DshAgentConnectorOptions {
  accountId: string;
  deviceId: string;
  sourceInstanceId: string;
  pathHmacKey?: string;
  decoder?: DshSessionDecoder;
}

interface NormalizedDshEvent {
  kind: AgentEventKind;
  renderedText?: string;
  toolArguments?: string;
  toolResult?: string;
  normalizedCoverage?: "FULL" | "PARTIAL" | "NONE";
  metadata: Record<string, unknown>;
}

function messageText(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return typeof value === "string" ? value : undefined;
  return firstString(record.text, record.reasoning) ??
    textFromContent(record.content);
}

function normalizeDshEvent(event: DshLogicalEvent): NormalizedDshEvent {
  const data = asRecord(event.data) ?? {};
  const metadata: Record<string, unknown> = {
    sourceType: event.type,
    sourceSeq: event.seq,
    ...(event.ignorable ? { ignorable: true } : {}),
    ...(event.surfaceOp !== undefined ? { surfaceOp: event.surfaceOp } : {}),
    ...(event.sourceEventSeqs ? { sourceEventSeqs: event.sourceEventSeqs } : {})
  };
  if (event.type === "user/message" || event.type === "steering/message") {
    return {
      kind: "USER",
      renderedText: messageText(event.data) ?? searchableJson(event.data),
      metadata
    };
  }
  if (event.type === "assistant/message") {
    return {
      kind: "ASSISTANT",
      renderedText: messageText(data.message) ?? searchableJson(data.message ?? data),
      metadata: { ...metadata, interrupted: data.interrupted === true }
    };
  }
  if (event.type === "assistant/chunk") {
    const chunk = asRecord(data.chunk) ?? {};
    const chunkType = String(chunk.type ?? "");
    if (/reason/iu.test(chunkType)) {
      return {
        kind: "REASONING",
        renderedText: firstString(chunk.text, chunk.reasoning) ?? searchableJson(chunk),
        metadata: { ...metadata, streamChunk: true, chunkType }
      };
    }
    if (/tool/iu.test(chunkType)) {
      return {
        kind: "TOOL_CALL",
        toolArguments: searchableJson(chunk),
        metadata: { ...metadata, streamChunk: true, chunkType }
      };
    }
    if (/text/iu.test(chunkType)) {
      return {
        kind: "ASSISTANT",
        renderedText: firstString(chunk.text, chunk.delta) ?? searchableJson(chunk),
        metadata: { ...metadata, streamChunk: true, chunkType }
      };
    }
    return {
      kind: "STATE",
      renderedText: searchableJson(chunk),
      normalizedCoverage: "PARTIAL",
      metadata: { ...metadata, streamChunk: true, chunkType }
    };
  }
  if (event.type === "tool/call") {
    let input: unknown = data.arguments ?? data;
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        // Preserve a literal model-produced argument string as-is.
      }
    }
    return {
      kind: "TOOL_CALL",
      toolArguments: searchableJson(input),
      metadata: {
        ...metadata,
        toolName: firstString(data.name) ?? null,
        callId: firstString(data.callId, data.call_id) ?? null
      }
    };
  }
  if (event.type === "tool/result") {
    return {
      kind: data.error ? "ERROR" : "TOOL_RESULT",
      toolResult: messageText(data.message) ?? searchableJson(data.message ?? data),
      metadata: {
        ...metadata,
        error: data.error ?? null
      }
    };
  }
  if (event.type === "request/header" || event.type === "request/context") {
    return {
      kind: "CONTEXT",
      renderedText: searchableJson(event.data),
      metadata
    };
  }
  if (/^(?:turn|step)\/(?:start|end)$/u.test(event.type)) {
    return {
      kind: "TURN_BOUNDARY",
      renderedText: searchableJson(event.data),
      metadata
    };
  }
  if (/subagent|delegate|child/iu.test(event.type)) {
    return {
      kind: "SUBAGENT",
      renderedText: searchableJson(event.data),
      metadata
    };
  }
  if (/error|failure/iu.test(event.type)) {
    return {
      kind: "ERROR",
      renderedText: searchableJson(event.data),
      metadata
    };
  }
  if (/compact|todo|session\/|state/iu.test(event.type)) {
    return {
      kind: "STATE",
      renderedText: searchableJson(event.data),
      metadata
    };
  }
  return {
    kind: "SOURCE_EVENT",
    renderedText: searchableJson(event.data),
    normalizedCoverage: "PARTIAL",
    metadata: { ...metadata, unknownExtension: true }
  };
}

export class DshAgentConnector implements AgentConnector {
  readonly sourceType = "DSH" as const;
  readonly parserVersion = "dsh-official-session-v1";
  readonly sourceInstanceId: string;
  private readonly options: DshAgentConnectorOptions;
  private readonly decoder: DshSessionDecoder;

  constructor(options: DshAgentConnectorOptions) {
    this.options = options;
    this.sourceInstanceId = options.sourceInstanceId;
    this.decoder = options.decoder ?? new OfficialDshSessionDecoder();
  }

  async readSource(path: string): Promise<AgentCapture[]> {
    const sessions = await this.decoder.inspect(path);
    const captures: AgentCapture[] = [];
    for (const session of sessions) {
      const sourceSessionId = String(session.meta.id);
      const safeSessionId = boundedSourceSessionId(sourceSessionId);
      const startedAt = new Date(session.meta.createdAt).toISOString();
      const endedAt = session.events.length > 0
        ? new Date(session.events.at(-1)?.time ?? session.meta.createdAt).toISOString()
        : null;
      const hint = await projectHint({
        cwd: session.meta.cwd,
        accountId: this.options.accountId,
        deviceId: this.options.deviceId,
        pathHmacKey: this.options.pathHmacKey
      });
      const parentRunId = session.meta.parentSession
        ? buildAgentRunId({
            accountId: this.options.accountId,
            deviceId: this.options.deviceId,
            sourceType: this.sourceType,
            sourceInstanceId: this.sourceInstanceId,
            sourceSessionId: boundedSourceSessionId(String(session.meta.parentSession))
          })
        : null;
      const builder = new AgentCaptureBuilder({
        accountId: this.options.accountId,
        deviceId: this.options.deviceId,
        sourceType: this.sourceType,
        sourceInstanceId: this.sourceInstanceId,
        parserVersion: this.parserVersion,
        sourceSessionId: safeSessionId,
        startedAt,
        endedAt,
        sourceTimeZone: "UTC",
        title: session.meta.agentPreset
          ? `DSH · ${session.meta.agentPreset}`
          : `DSH · ${sourceSessionId}`,
        cwd: session.meta.cwd ?? null,
        parentRunId,
        ...(hint ? { projectHint: hint } : {}),
        metadata: {
          sessionHeader: session.meta,
          sourceSessionId,
          backendArtifact: session.artifactPath ?? null
        }
      });
      if (session.artifactPath) {
        builder.addAttachment({
          eventId: null,
          purpose: "SOURCE_TRANSCRIPT",
          requestedPath: session.artifactPath,
          mediaType: session.artifactPath.endsWith(".zstd")
            ? "application/zstd"
            : session.artifactPath.endsWith(".db") ||
                session.artifactPath.endsWith(".sqlite")
              ? "application/vnd.sqlite3"
              : "application/x-ndjson"
        });
      }
      builder.addEvent({
        sourceEventId: "session-header",
        sequence: 0,
        kind: "STATE",
        occurredAt: startedAt,
        renderedText: searchableJson(session.meta),
        rawPayload: JSON.stringify(session.meta),
        metadata: { dshSessionHeader: true }
      });

      const mirrorTargetBySourceSeq = new Map<number, string>();
      for (const event of session.events) {
        if (event.type !== "assistant/message" || !event.sourceEventSeqs) continue;
        const target = buildAgentEventId({
          accountId: this.options.accountId,
          deviceId: this.options.deviceId,
          sourceType: this.sourceType,
          sourceInstanceId: this.sourceInstanceId,
          sourceSessionId: safeSessionId,
          sourceEventId: `seq:${event.seq}`,
          sequence: event.seq + 1
        });
        for (const sourceSeq of event.sourceEventSeqs) {
          mirrorTargetBySourceSeq.set(sourceSeq, target);
        }
      }
      let previousUserEventId: string | undefined;
      const attachmentKeys = new Set<string>(
        session.artifactPath ? [`run\u001f${session.artifactPath}`] : []
      );
      for (const sourceEvent of session.events) {
        const normalized = normalizeDshEvent(sourceEvent);
        const data = asRecord(sourceEvent.data) ?? {};
        const event = builder.addEvent({
          sourceEventId: `seq:${sourceEvent.seq}`,
          sequence: sourceEvent.seq + 1,
          kind: normalized.kind,
          occurredAt: new Date(sourceEvent.time).toISOString(),
          turnIndex: numericIndex(data.turn),
          stepIndex: numericIndex(data.step),
          ...(normalized.renderedText !== undefined
            ? { renderedText: normalized.renderedText }
            : {}),
          ...(normalized.toolArguments !== undefined
            ? { toolArguments: normalized.toolArguments }
            : {}),
          ...(normalized.toolResult !== undefined
            ? { toolResult: normalized.toolResult }
            : {}),
          rawPayload: JSON.stringify(sourceEvent),
          ...(normalized.kind === "ASSISTANT" && previousUserEventId
            ? { replyToEventId: previousUserEventId }
            : {}),
          ...(mirrorTargetBySourceSeq.has(sourceEvent.seq)
            ? { mirrorOfEventId: mirrorTargetBySourceSeq.get(sourceEvent.seq) }
            : {}),
          normalizedCoverage: normalized.normalizedCoverage,
          metadata: normalized.metadata
        });
        if (normalized.kind === "USER") previousUserEventId = event.eventId;
        for (const requestedPath of extractLiteralFilePaths(sourceEvent.data)) {
          const attachmentKey = `${event.eventId}\u001f${requestedPath}`;
          if (attachmentKeys.has(attachmentKey)) continue;
          attachmentKeys.add(attachmentKey);
          builder.addAttachment({
            eventId: event.eventId,
            purpose: "ATTACHMENT",
            requestedPath,
            metadata: { dshSourceSeq: sourceEvent.seq }
          });
        }
      }
      captures.push(builder.finish());
    }
    return captures;
  }
}

export function dshSessionId(value: string): ReturnType<typeof SessionId> {
  return SessionId(value);
}
