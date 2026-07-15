import { createHmac } from "node:crypto";
import type { SyncEvent } from "@ai-worklog/contracts";
import {
  buildEventId,
  normalizeGitRemote,
  redactSensitiveText,
  sha256Hex
} from "@ai-worklog/core";
import type { NormalizedPromptSession, PromptConnector } from "./prompt-connector.js";
import { readJsonlRecords, type JsonRecord } from "./jsonl-reader.js";
import { resolveLocalProjectIdentity } from "./git-project.js";

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

type MessageRole = "user" | "assistant";

interface MessageCandidate {
  role: MessageRole;
  content: string;
  occurredAt: string;
  timestampMs: number;
  lineNumber: number;
  sessionMeta: SessionMeta;
  sourceMessageId: string | null;
  messageIndex: number;
  clientId?: string;
  metadata: Record<string, unknown>;
}

export type NormalizedCodexSession = NormalizedPromptSession;

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

function normalizedContent(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function eventSourceMessageId(value: unknown, fallback: string): string {
  const candidate = optionalString(value);
  return candidate && /^[A-Za-z0-9._:-]{1,255}$/u.test(candidate) ? candidate : fallback;
}

function responseClientId(payload: JsonRecord): string | undefined {
  const passthrough = asRecord(payload.internal_chat_message_metadata_passthrough);
  return optionalString(passthrough?.client_id);
}

function pairingScore(event: MessageCandidate, response: MessageCandidate): number | null {
  if (
    event.role !== response.role ||
    event.sessionMeta.sessionId !== response.sessionMeta.sessionId ||
    Math.abs(event.timestampMs - response.timestampMs) > 2_000
  ) {
    return null;
  }
  if (event.clientId && response.clientId && event.clientId === response.clientId) return 0;
  if (event.content === response.content) return 1;

  const normalizedEvent = normalizedContent(event.content);
  const normalizedResponse = normalizedContent(response.content);
  if (normalizedEvent === normalizedResponse) return 2;
  if (
    normalizedEvent.length >= 1 &&
    normalizedResponse.endsWith(` ${normalizedEvent}`)
  ) {
    return 3;
  }
  if (
    normalizedEvent.length >= 8 &&
    (normalizedResponse.includes(normalizedEvent) || normalizedEvent.includes(normalizedResponse))
  ) {
    return 3;
  }
  return null;
}

function pairingBucketKey(candidate: MessageCandidate, bucket: number): string {
  return JSON.stringify([candidate.sessionMeta.sessionId, candidate.role, bucket]);
}

export class CodexConnector implements PromptConnector {
  readonly sourceType = "CODEX" as const;
  readonly parserVersion = "codex-jsonl-v4";
  readonly sourceInstanceId: string;
  private readonly accountId: string;
  private readonly deviceId: string;
  private readonly pathHmacKey: string;
  private readonly projectCache = new Map<string, Promise<Awaited<ReturnType<typeof resolveLocalProjectIdentity>>>>();

  constructor(options: CodexConnectorOptions) {
    this.accountId = options.accountId;
    this.deviceId = options.deviceId;
    this.sourceInstanceId = options.sourceInstanceId;
    this.pathHmacKey = options.pathHmacKey
      ?? sha256Hex(`path-key-v1\u001f${options.accountId}\u001f${options.deviceId}`);
  }

  async readFile(filePath: string): Promise<NormalizedCodexSession> {
    const firstMeta = await this.readSessionMeta(filePath);
    let currentMeta = firstMeta;
    let responseMessageIndex = 0;
    const responseCandidates: MessageCandidate[] = [];
    const eventCandidates: MessageCandidate[] = [];

    for await (const { record, lineNumber } of readJsonlRecords(filePath, "Codex")) {
      if (!record) continue;
      if (record.type === "session_meta") {
        const payload = asRecord(record.payload);
        if (payload) currentMeta = this.sessionMetaFromPayload(payload);
        continue;
      }

      const payload = asRecord(record.payload);
      if (!payload) continue;
      if (record.type === "response_item" && payload.type === "message") {
        if (payload.role !== "user" && payload.role !== "assistant") continue;
        const content = extractText(payload.content);
        if (!content?.trim()) continue;
        if (responseMessageIndex > 1_000_000) {
          throw new Error("Codex source exceeds the message index limit");
        }
        const occurredAt = normalizedTimestamp(record.timestamp);
        const clientId = responseClientId(payload);
        responseCandidates.push({
          role: payload.role,
          content,
          occurredAt,
          timestampMs: Date.parse(occurredAt),
          lineNumber,
          sessionMeta: currentMeta,
          sourceMessageId: optionalString(payload.id) ?? null,
          messageIndex: responseMessageIndex,
          ...(clientId ? { clientId } : {}),
          metadata: {}
        });
        responseMessageIndex += 1;
        continue;
      }
      if (record.type !== "event_msg") continue;

      if (payload.type === "user_message") {
        if (lineNumber - 1 > 1_000_000) {
          throw new Error("Codex source exceeds the message index limit");
        }
        const imageCount = arrayLength(payload.images);
        const localImageCount = arrayLength(payload.local_images);
        const textElementCount = arrayLength(payload.text_elements);
        const rawContent = optionalString(payload.message);
        const content = rawContent?.trim()
          ? rawContent.slice(0, MAX_CONTENT_LENGTH)
          : imageCount + localImageCount > 0
            ? "[图片输入]"
            : null;
        if (!content) continue;
        const occurredAt = normalizedTimestamp(record.timestamp);
        const clientId = optionalString(payload.client_id);
        eventCandidates.push({
          role: "user",
          content,
          occurredAt,
          timestampMs: Date.parse(occurredAt),
          lineNumber,
          sessionMeta: currentMeta,
          sourceMessageId: eventSourceMessageId(
            payload.client_id,
            `event-user-line:${lineNumber}`
          ),
          messageIndex: lineNumber - 1,
          ...(clientId ? { clientId } : {}),
          metadata: {
            sourceFormat: [
              "codex:event:user",
              `img=${imageCount}`,
              `local=${localImageCount}`,
              `text=${textElementCount}`
            ].join(";")
          }
        });
        continue;
      }

      if (payload.type === "agent_message") {
        if (lineNumber - 1 > 1_000_000) {
          throw new Error("Codex source exceeds the message index limit");
        }
        const content = optionalString(payload.message)?.slice(0, MAX_CONTENT_LENGTH);
        if (!content?.trim()) continue;
        const occurredAt = normalizedTimestamp(record.timestamp);
        eventCandidates.push({
          role: "assistant",
          content,
          occurredAt,
          timestampMs: Date.parse(occurredAt),
          lineNumber,
          sessionMeta: currentMeta,
          sourceMessageId: `event-agent-line:${lineNumber}`,
          messageIndex: lineNumber - 1,
          metadata: { sourceFormat: "codex:event:agent" }
        });
      }
    }

    const selected = this.selectVisibleCandidates(
      responseCandidates,
      eventCandidates,
      firstMeta
    );
    const events: SyncEvent[] = [];
    const previousUserBySession = new Map<string, string>();
    for (const candidate of selected) {
      const eventId = this.eventIdForCandidate(candidate);
      const sanitizedContent = redactSensitiveText(candidate.content);
      const kind = candidate.role === "user"
        ? "USER_PROMPT" as const
        : "VISIBLE_RESULT" as const;
      const replyToEventId = kind === "VISIBLE_RESULT"
        ? previousUserBySession.get(candidate.sessionMeta.sessionId)
        : undefined;

      events.push({
        eventId,
        kind,
        sourceSessionId: candidate.sessionMeta.sessionId,
        sourceMessageId: candidate.sourceMessageId,
        messageIndex: candidate.messageIndex,
        ...(replyToEventId ? { replyToEventId } : {}),
        occurredAt: candidate.occurredAt,
        sourceTimeZone: candidate.sessionMeta.sourceTimeZone,
        sanitizedContent,
        contentHash: sha256Hex(sanitizedContent),
        redactionVersion: "core-v1",
        projectHint: await this.projectHint(candidate.sessionMeta),
        metadata: candidate.metadata
      });

      if (kind === "USER_PROMPT") {
        previousUserBySession.set(candidate.sessionMeta.sessionId, eventId);
      }
    }

    return { sessionId: firstMeta.sessionId, events };
  }

  private selectVisibleCandidates(
    responseCandidates: MessageCandidate[],
    eventCandidates: MessageCandidate[],
    firstMeta: SessionMeta
  ): MessageCandidate[] {
    const matchedResponses = new Set<number>();
    const responseBuckets = new Map<string, number[]>();
    responseCandidates.forEach((response, index) => {
      const bucket = Math.floor(response.timestampMs / 2_000);
      const key = pairingBucketKey(response, bucket);
      const indexes = responseBuckets.get(key) ?? [];
      indexes.push(index);
      responseBuckets.set(key, indexes);
    });
    const selectedEvents = eventCandidates.map((event) => {
      const eventBucket = Math.floor(event.timestampMs / 2_000);
      const nearbyIndexes = [-1, 0, 1].flatMap((offset) =>
        responseBuckets.get(pairingBucketKey(event, eventBucket + offset)) ?? []
      );
      const matches = nearbyIndexes.flatMap((index) => {
        if (matchedResponses.has(index)) return [];
        const response = responseCandidates[index];
        if (!response) return [];
        const score = pairingScore(event, response);
        return score === null
          ? []
          : [{
              index,
              response,
              score,
              timeDelta: Math.abs(event.timestampMs - response.timestampMs),
              lineDelta: Math.abs(event.lineNumber - response.lineNumber)
            }];
      }).sort((left, right) =>
        left.score - right.score ||
        left.timeDelta - right.timeDelta ||
        left.lineDelta - right.lineDelta ||
        left.response.lineNumber - right.response.lineNumber
      );
      const match = matches[0];
      if (!match) return event;
      matchedResponses.add(match.index);
      const canonicalEventId = this.eventIdForCandidate(event);
      const legacyEventAliases = [
        {
          eventId: this.eventIdForCandidate(match.response),
          sourceSessionId: match.response.sessionMeta.sessionId
        },
        {
          eventId: this.eventIdForCandidate({
            ...match.response,
            sessionMeta: firstMeta
          }),
          sourceSessionId: firstMeta.sessionId
        }
      ].filter((alias, index, aliases) =>
        alias.eventId !== canonicalEventId &&
        aliases.findIndex((candidate) => candidate.eventId === alias.eventId) === index
      );
      return {
        ...event,
        metadata: legacyEventAliases.length === 0
          ? event.metadata
          : { ...event.metadata, legacyEventAliases }
      };
    });
    const unmatchedResponses = responseCandidates.flatMap((response, index) => {
      if (matchedResponses.has(index)) return [];
      const canonicalEventId = this.eventIdForCandidate(response);
      const v2Alias = {
        eventId: this.eventIdForCandidate({
          ...response,
          sessionMeta: firstMeta
        }),
        sourceSessionId: firstMeta.sessionId
      };
      return [{
        ...response,
        metadata: v2Alias.eventId === canonicalEventId
          ? response.metadata
          : {
              ...response.metadata,
              legacyEventAliases: [v2Alias]
            }
      }];
    });

    return [
      ...unmatchedResponses,
      ...selectedEvents
    ].sort((left, right) =>
      left.lineNumber - right.lineNumber ||
      (left.role === right.role ? 0 : left.role === "user" ? -1 : 1)
    );
  }

  private eventIdForCandidate(candidate: MessageCandidate): string {
    return buildEventId({
      accountId: this.accountId,
      deviceId: this.deviceId,
      sourceType: this.sourceType,
      sourceInstanceId: this.sourceInstanceId,
      sourceSessionId: candidate.sessionMeta.sessionId,
      sourceMessageId: candidate.sourceMessageId,
      messageIndex: candidate.messageIndex
    });
  }

  private async projectHint(meta: SessionMeta): Promise<SyncEvent["projectHint"]> {
    const project = meta.cwd
      ? await this.resolveProject(meta.cwd, meta.gitRemoteKey)
      : null;
    return {
      ...(project?.gitRemoteKey ? { gitRemoteKey: project.gitRemoteKey } : {}),
      ...(project?.repoRootName ? { repoRootName: project.repoRootName } : {}),
      ...(project ? {
        localPathHmac: createHmac("sha256", this.pathHmacKey)
          .update(project.pathForHmac)
          .digest("hex")
      } : {})
    };
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
    let payload: JsonRecord | null = null;
    for await (const { record } of readJsonlRecords(filePath, "Codex")) {
      if (record?.type !== "session_meta") continue;
      payload = asRecord(record.payload);
      break;
    }
    if (!payload) throw new Error("Invalid Codex fixture: session_meta is missing");
    return this.sessionMetaFromPayload(payload);
  }

  private sessionMetaFromPayload(payload: JsonRecord): SessionMeta {
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
