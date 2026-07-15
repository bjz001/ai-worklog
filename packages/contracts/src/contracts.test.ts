import { describe, expect, it } from "vitest";
import {
  MAX_LEGACY_EVENT_ALIASES,
  LlmSettingsResponseSchema,
  LlmSettingsUpdateSchema,
  SyncEventSchema,
  SyncBatchRequestSchema
} from "./index";

describe("SyncBatchRequestSchema", () => {
  it("rejects oversized batches", () => {
    const events = Array.from({ length: 201 }, (_, index) => ({
      eventId: "a".repeat(64),
      kind: "USER_PROMPT",
      sourceSessionId: "session",
      sourceMessageId: `message-${index}`,
      messageIndex: index,
      occurredAt: "2026-07-14T10:00:00.000Z",
      sourceTimeZone: "Asia/Shanghai",
      sanitizedContent: "安全内容",
      contentHash: "b".repeat(64),
      redactionVersion: "1",
      projectHint: { gitRemoteKey: "github.com/acme/worklog" },
      metadata: {}
    }));

    const result = SyncBatchRequestSchema.safeParse({
      protocolVersion: 1,
      batchId: "batch-1",
      createdAt: "2026-07-14T10:00:00.000Z",
      source: {
        type: "CODEX",
        instanceId: "codex-macos",
        parserVersion: "codex-fixture@1"
      },
      events
    });

    expect(result.success).toBe(false);
  });

  it("accepts a valid sanitized event", () => {
    const result = SyncBatchRequestSchema.safeParse({
      protocolVersion: 1,
      batchId: "batch-1",
      createdAt: "2026-07-14T10:00:00.000Z",
      source: {
        type: "CODEX",
        instanceId: "codex-macos",
        parserVersion: "codex-fixture@1"
      },
      events: [
        {
          eventId: "a".repeat(64),
          kind: "USER_PROMPT",
          sourceSessionId: "session",
          sourceMessageId: "message-1",
          messageIndex: 1,
          occurredAt: "2026-07-14T10:00:00.000Z",
          sourceTimeZone: "Asia/Shanghai",
          sanitizedContent: "整理项目同步方案",
          contentHash: "b".repeat(64),
          redactionVersion: "1",
          projectHint: { gitRemoteKey: "github.com/acme/worklog" },
          metadata: { model: "codex" }
        }
      ]
    });

    expect(result.success).toBe(true);
  });

  it("accepts only a bounded, unique list of strict legacy event aliases", () => {
    const baseEvent = {
      eventId: "a".repeat(64),
      kind: "USER_PROMPT",
      sourceSessionId: "session-b",
      sourceMessageId: "message-1",
      messageIndex: 1,
      occurredAt: "2026-07-14T10:00:00.000Z",
      sourceTimeZone: "Asia/Shanghai",
      sanitizedContent: "整理项目同步方案",
      contentHash: "b".repeat(64),
      redactionVersion: "1"
    };
    const validAliases = [
      { eventId: "c".repeat(64), sourceSessionId: "session-b" },
      { eventId: "d".repeat(64), sourceSessionId: "session-a" }
    ];

    expect(SyncEventSchema.safeParse({
      ...baseEvent,
      metadata: { legacyEventAliases: validAliases }
    }).success).toBe(true);
    expect(SyncEventSchema.safeParse({
      ...baseEvent,
      metadata: { legacyEventAliases: [validAliases[0], validAliases[0]] }
    }).success).toBe(false);
    expect(SyncEventSchema.safeParse({
      ...baseEvent,
      metadata: {
        legacyEventAliases: Array.from(
          { length: MAX_LEGACY_EVENT_ALIASES + 1 },
          (_, index) => ({
            eventId: index.toString(16).padStart(64, "0"),
            sourceSessionId: `session-${index}`
          })
        )
      }
    }).success).toBe(false);
    expect(SyncEventSchema.safeParse({
      ...baseEvent,
      metadata: {
        legacyEventAliases: [{
          eventId: "C".repeat(64),
          sourceSessionId: "session-b",
          extra: "not-allowed"
        }]
      }
    }).success).toBe(false);
  });
});

describe("LLM settings contracts", () => {
  it("accepts a partial update while rejecting unknown fields", () => {
    expect(
      LlmSettingsUpdateSchema.safeParse({
        provider: "DEEPSEEK",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        apiKey: "sk-test-only-value"
      }).success
    ).toBe(true);
    expect(
      LlmSettingsUpdateSchema.safeParse({
        provider: "DEEPSEEK",
        encryptedApiKey: "must-never-cross-the-api-boundary"
      }).success
    ).toBe(false);
  });

  it("never includes a plaintext or encrypted key in responses", () => {
    expect(
      LlmSettingsResponseSchema.safeParse({
        data: {
          provider: "DEEPSEEK",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          hasApiKey: true,
          updatedAt: "2026-07-15T08:00:00.000Z"
        }
      }).success
    ).toBe(true);
    expect(
      LlmSettingsResponseSchema.safeParse({
        data: {
          provider: "DEEPSEEK",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          hasApiKey: true,
          updatedAt: null,
          apiKey: "secret"
        }
      }).success
    ).toBe(false);
  });
});
