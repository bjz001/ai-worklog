import { createHmac } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname } from "node:path";
import type { SyncEvent } from "@ai-worklog/contracts";
import {
  buildEventId,
  normalizeGitRemote,
  redactSensitiveText,
  sha256Hex
} from "@ai-worklog/core";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CONTENT_LENGTH = 131_072;

interface CodexConnectorOptions {
  accountId: string;
  deviceId: string;
  sourceInstanceId: string;
  pathHmacKey?: string;
}

interface SessionMeta {
  sessionId: string;
  cwd?: string;
  sourceTimeZone: string;
  gitRemoteKey?: string;
}

export interface NormalizedCodexSession {
  sessionId: string;
  events: SyncEvent[];
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid Codex fixture: ${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizedTimestamp(value: unknown): string {
  const raw = requiredString(value, "timestamp");
  const timestamp = new Date(raw);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Invalid Codex fixture: timestamp is invalid");
  }
  return timestamp.toISOString();
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content.slice(0, MAX_CONTENT_LENGTH);
  if (!Array.isArray(content)) return null;

  const parts = content.flatMap((part) => {
    const record = asRecord(part);
    if (!record || typeof record.text !== "string") return [];
    if (!["input_text", "output_text", "text"].includes(String(record.type))) return [];
    return [record.text];
  });

  if (parts.length === 0) return null;
  return parts.join("\n").slice(0, MAX_CONTENT_LENGTH);
}

export class CodexConnector {
  readonly sourceType = "CODEX" as const;
  readonly parserVersion = "codex-jsonl-v1";
  readonly sourceInstanceId: string;
  private readonly accountId: string;
  private readonly deviceId: string;
  private readonly pathHmacKey: string;

  constructor(options: CodexConnectorOptions) {
    this.accountId = options.accountId;
    this.deviceId = options.deviceId;
    this.sourceInstanceId = options.sourceInstanceId;
    this.pathHmacKey = options.pathHmacKey
      ?? sha256Hex(`path-key-v1\u001f${options.accountId}\u001f${options.deviceId}`);
  }

  async readFile(filePath: string): Promise<NormalizedCodexSession> {
    if (extname(filePath).toLowerCase() !== ".jsonl") {
      throw new Error("Codex source must be a .jsonl file");
    }

    const sourceStat = await lstat(filePath);
    if (sourceStat.isSymbolicLink()) throw new Error("Codex source symlinks are not allowed");
    if (!sourceStat.isFile()) throw new Error("Codex source must be a regular file");
    if (sourceStat.size > MAX_FILE_BYTES) throw new Error("Codex source exceeds the 10 MiB limit");

    const safePath = await realpath(filePath);
    const raw = await readFile(safePath, "utf8");
    const records = raw
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return asRecord(JSON.parse(line));
        } catch {
          throw new Error(`Invalid Codex JSONL at line ${index + 1}`);
        }
      });

    const meta = this.readSessionMeta(records);
    const projectHint = {
      ...(meta.gitRemoteKey ? { gitRemoteKey: meta.gitRemoteKey } : {}),
      ...(meta.cwd ? {
        localPathHmac: createHmac("sha256", this.pathHmacKey).update(meta.cwd).digest("hex")
      } : {})
    };
    const events: SyncEvent[] = [];
    let previousUserEventId: string | undefined;
    let messageIndex = 0;

    for (const record of records) {
      if (!record || record.type !== "response_item") continue;
      const payload = asRecord(record.payload);
      if (!payload || payload.type !== "message") continue;
      if (payload.role !== "user" && payload.role !== "assistant") continue;
      const content = extractText(payload.content);
      if (!content?.trim()) continue;

      const sourceMessageId = optionalString(payload.id) ?? null;
      const eventId = buildEventId({
        accountId: this.accountId,
        deviceId: this.deviceId,
        sourceType: this.sourceType,
        sourceInstanceId: this.sourceInstanceId,
        sourceSessionId: meta.sessionId,
        sourceMessageId,
        messageIndex
      });
      const sanitizedContent = redactSensitiveText(content);
      const kind = payload.role === "user" ? "USER_PROMPT" as const : "VISIBLE_RESULT" as const;

      events.push({
        eventId,
        kind,
        sourceSessionId: meta.sessionId,
        sourceMessageId,
        messageIndex,
        ...(kind === "VISIBLE_RESULT" && previousUserEventId
          ? { replyToEventId: previousUserEventId }
          : {}),
        occurredAt: normalizedTimestamp(record.timestamp),
        sourceTimeZone: meta.sourceTimeZone,
        sanitizedContent,
        contentHash: sha256Hex(sanitizedContent),
        redactionVersion: "core-v1",
        projectHint,
        metadata: {}
      });

      if (kind === "USER_PROMPT") previousUserEventId = eventId;
      messageIndex += 1;
    }

    return { sessionId: meta.sessionId, events };
  }

  private readSessionMeta(records: Array<JsonRecord | null>): SessionMeta {
    const record = records.find((candidate) => candidate?.type === "session_meta");
    const payload = asRecord(record?.payload);
    if (!payload) throw new Error("Invalid Codex fixture: session_meta is missing");
    const git = asRecord(payload.git);
    const rawRemote = optionalString(git?.repository_url);
    const gitRemoteKey = rawRemote ? normalizeGitRemote(rawRemote) ?? undefined : undefined;

    return {
      sessionId: requiredString(payload.id, "session_meta.payload.id"),
      cwd: optionalString(payload.cwd),
      sourceTimeZone: optionalString(payload.source_time_zone) ?? "UTC",
      gitRemoteKey
    };
  }
}
