import { createHmac } from "node:crypto";
import { MAX_SYNC_EVENT_CONTENT_BYTES, type SyncEvent } from "@ai-worklog/contracts";
import {
  buildEventId,
  normalizeGitRemote,
  redactSensitiveText,
  sha256Hex
} from "@ai-worklog/core";
import type { NormalizedPromptSession, PromptConnector } from "./prompt-connector.js";
import { readJsonlRecords, type JsonRecord } from "./jsonl-reader.js";
import { resolveLocalProjectIdentity } from "./git-project.js";

const MAX_CONTENT_LENGTH = MAX_SYNC_EVENT_CONTENT_BYTES;
const MAX_METADATA_LENGTH = 512;

export type PromptCaptureMode = "legacy" | "raw-prompts";

interface ClaudeCodeConnectorOptions {
  accountId: string;
  deviceId: string;
  sourceInstanceId: string;
  pathHmacKey?: string;
  captureMode?: PromptCaptureMode;
}

interface SessionMeta {
  sessionId: string;
  cwd?: string;
  sourceTimeZone: string;
  gitRemoteKey?: string;
  gitBranch?: string;
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = optionalString(value);
    if (candidate) return candidate;
  }
  return undefined;
}

function normalizedTimestamp(record: JsonRecord): string {
  const raw = firstString(record.timestamp, record.createdAt, record.created_at);
  if (!raw) throw new Error("Invalid Claude Code fixture: timestamp must be a non-empty string");
  const timestamp = new Date(raw);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Invalid Claude Code fixture: timestamp is invalid");
  }
  return timestamp.toISOString();
}

function extractVisibleText(content: unknown): string | null {
  if (typeof content === "string") return content.slice(0, MAX_CONTENT_LENGTH);
  if (!Array.isArray(content)) return null;

  const parts = content.flatMap((part) => {
    const record = asRecord(part);
    if (!record || typeof record.text !== "string") return [];
    if (!["text", "input_text", "output_text"].includes(String(record.type))) return [];
    return [record.text];
  });

  if (parts.length === 0) return null;
  return parts.join("\n").slice(0, MAX_CONTENT_LENGTH);
}

function messageRole(record: JsonRecord, message: JsonRecord): "user" | "assistant" | null {
  const role = firstString(message.role, record.type);
  return role === "user" || role === "assistant" ? role : null;
}

export class ClaudeCodeConnector implements PromptConnector {
  readonly sourceType = "CLAUDE_CODE" as const;
  readonly parserVersion = "claude-code-jsonl-v2";
  readonly sourceInstanceId: string;
  private readonly accountId: string;
  private readonly deviceId: string;
  private readonly pathHmacKey: string;
  private readonly captureMode: PromptCaptureMode;
  private readonly projectCache = new Map<string, Promise<Awaited<ReturnType<typeof resolveLocalProjectIdentity>>>>();

  constructor(options: ClaudeCodeConnectorOptions) {
    this.accountId = options.accountId;
    this.deviceId = options.deviceId;
    this.sourceInstanceId = options.sourceInstanceId;
    this.pathHmacKey = options.pathHmacKey
      ?? sha256Hex(`path-key-v1\u001f${options.accountId}\u001f${options.deviceId}`);
    this.captureMode = options.captureMode ?? "legacy";
  }

  async readFile(filePath: string): Promise<NormalizedPromptSession> {
    const meta = await this.readSessionMeta(filePath);
    const project = this.captureMode === "legacy" && meta.cwd
      ? await this.resolveProject(meta.cwd, meta.gitRemoteKey)
      : null;
    const projectHint = {
      ...(project?.gitRemoteKey ? { gitRemoteKey: project.gitRemoteKey } : {}),
      ...(project?.repoRootName ? { repoRootName: project.repoRootName } : {}),
      ...(project ? {
        localPathHmac: createHmac("sha256", this.pathHmacKey)
          .update(project.pathForHmac)
          .digest("hex")
      } : {})
    };
    const metadata = this.captureMode === "legacy" && meta.gitBranch
      ? { gitBranch: redactSensitiveText(meta.gitBranch).slice(0, MAX_METADATA_LENGTH) }
      : {};
    const events: SyncEvent[] = [];
    let previousUserEventId: string | undefined;
    // This semantic ordinal is part of the durable v1 event identity. Raw
    // JSONL line numbers must not replace it during parser upgrades.
    let messageIndex = 0;

    for await (const { record } of readJsonlRecords(filePath, "Claude Code")) {
      if (!record || (record.type !== "user" && record.type !== "assistant")) continue;
      if (record.isSidechain === true) continue;
      const message = asRecord(record.message);
      if (!message) continue;
      const role = messageRole(record, message);
      if (this.captureMode === "raw-prompts" && role !== "user") continue;
      if (!role) continue;
      const content = extractVisibleText(message.content);
      if (!content?.trim()) continue;
      if (messageIndex > 1_000_000) {
        throw new Error("Claude Code source exceeds the message index limit");
      }

      const sourceMessageId = firstString(record.uuid, message.id)?.slice(0, 255) ?? null;
      const eventId = buildEventId({
        accountId: this.accountId,
        deviceId: this.deviceId,
        sourceType: this.sourceType,
        sourceInstanceId: this.sourceInstanceId,
        sourceSessionId: meta.sessionId,
        sourceMessageId,
        messageIndex
      });
      const sanitizedContent = this.captureMode === "raw-prompts"
        ? content
        : redactSensitiveText(content);
      const kind = role === "user" ? "USER_PROMPT" as const : "VISIBLE_RESULT" as const;

      events.push({
        eventId,
        kind,
        sourceSessionId: meta.sessionId,
        sourceMessageId,
        messageIndex,
        ...(kind === "VISIBLE_RESULT" && previousUserEventId
          ? { replyToEventId: previousUserEventId }
          : {}),
        occurredAt: normalizedTimestamp(record),
        sourceTimeZone: meta.sourceTimeZone,
        sanitizedContent,
        contentHash: sha256Hex(sanitizedContent),
        redactionVersion: this.captureMode === "raw-prompts" ? "RAW_V1" : "core-v1",
        ...(this.captureMode === "legacy" ? { projectHint } : {}),
        metadata
      });

      if (kind === "USER_PROMPT") previousUserEventId = eventId;
      messageIndex += 1;
    }

    return { sessionId: meta.sessionId, events };
  }

  private resolveProject(cwd: string, reportedGitRemote?: string) {
    const key = `${cwd}\u001f${reportedGitRemote ?? ""}`;
    let result = this.projectCache.get(key);
    if (!result) {
      result = resolveLocalProjectIdentity({ cwd, reportedGitRemote });
      this.projectCache.set(key, result);
    }
    return result;
  }

  private async readSessionMeta(filePath: string): Promise<SessionMeta> {
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let sourceTimeZone: string | undefined;
    let rawRemote: string | undefined;
    let gitBranch: string | undefined;
    for await (const { record } of readJsonlRecords(filePath, "Claude Code")) {
      if (!record) continue;
      sessionId ??= firstString(record.sessionId, record.session_id);
      cwd ??= firstString(record.cwd, record.workingDirectory);
      sourceTimeZone ??= firstString(record.sourceTimeZone, record.source_time_zone);
      gitBranch ??= firstString(record.gitBranch, record.git_branch);
      if (!rawRemote) {
        const git = asRecord(record.git);
        rawRemote = firstString(
          record.gitRemote,
          record.gitRemoteUrl,
          record.repositoryUrl,
          record.repository_url,
          git?.repository_url,
          git?.repositoryUrl,
          git?.remote_url,
          git?.remote,
          git?.url
        );
      }
    }
    if (!sessionId) throw new Error("Invalid Claude Code fixture: sessionId is missing");
    const gitRemoteKey = rawRemote
      ? normalizeGitRemote(rawRemote.slice(0, 4_096)) ?? undefined
      : undefined;
    if (sessionId.length > 255) {
      throw new Error("Invalid Claude Code fixture: sessionId exceeds 255 characters");
    }

    return {
      sessionId,
      cwd,
      sourceTimeZone: sourceTimeZone?.slice(0, 64) ?? "UTC",
      gitRemoteKey,
      gitBranch
    };
  }
}
