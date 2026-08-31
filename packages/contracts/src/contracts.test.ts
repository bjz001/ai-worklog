import { describe, expect, it } from "vitest";
import {
  DeviceCreateSchema,
  DeviceEnrollmentResponseSchema,
  DeviceTokenRotateSchema,
  MAX_LEGACY_EVENT_ALIASES,
  LlmSettingsResponseSchema,
  LlmSettingsUpdateSchema,
  SyncEventSchema,
  SyncBatchRequestSchema
} from "./index";

describe("device enrollment contracts", () => {
  it("accepts only a bounded Mac or Windows registration", () => {
    expect(DeviceCreateSchema.safeParse({
      name: "  Office Mac  ",
      platform: "MACOS"
    }).data).toEqual({ name: "Office Mac", platform: "MACOS" });
    expect(DeviceCreateSchema.safeParse({
      name: "Windows\nPowerShell",
      platform: "WINDOWS"
    }).success).toBe(false);
    expect(DeviceCreateSchema.safeParse({
      name: "Linux server",
      platform: "LINUX"
    }).success).toBe(false);
    expect(DeviceCreateSchema.safeParse({
      name: "Mac",
      platform: "MACOS",
      token: "must-never-be-client-supplied"
    }).success).toBe(false);
  });

  it("uses an empty strict body for token rotation", () => {
    expect(DeviceTokenRotateSchema.safeParse({}).success).toBe(true);
    expect(DeviceTokenRotateSchema.safeParse({ token: "client-value" }).success)
      .toBe(false);
  });

  it("returns a plaintext token only in the one-time enrollment response", () => {
    const response = {
      data: {
        device: {
          id: "device_abc123",
          name: "Office Mac",
          os: "MACOS",
          status: "WAITING",
          lastSeenAt: null,
          lastSyncAt: null,
          promptCount: 0
        },
        enrollment: {
          accountId: "account_demo",
          deviceId: "device_abc123",
          deviceToken: "a".repeat(64),
          syncUrl: "http://172.18.209.21:3000/api/v1/sync/batches"
        }
      }
    };

    expect(DeviceEnrollmentResponseSchema.safeParse(response).success).toBe(true);
    expect(DeviceEnrollmentResponseSchema.safeParse({
      ...response,
      data: {
        ...response.data,
        enrollment: {
          ...response.data.enrollment,
          tokenHmac: "b".repeat(64)
        }
      }
    }).success).toBe(false);
  });
});

describe("SyncBatchRequestSchema", () => {
  it.each(["ZCODE", "DSH"] as const)("accepts %s as a Prompt source", (source) => {
    const result = SyncBatchRequestSchema.safeParse({
      ...{
        protocolVersion: 1,
        batchId: "batch-1",
        createdAt: "2026-07-14T10:00:00.000Z",
        source: {
          type: source,
          instanceId: "source-device",
          parserVersion: "prompt-v1"
        },
        events: [{
          eventId: "a".repeat(64),
          kind: "USER_PROMPT",
          sourceSessionId: "session",
          sourceMessageId: "message-1",
          messageIndex: 0,
          occurredAt: "2026-07-14T10:00:00.000Z",
          sourceTimeZone: "UTC",
          sanitizedContent: "raw prompt",
          contentHash: "b".repeat(64),
          redactionVersion: "RAW_V1",
          metadata: {}
        }]
      }
    });

    expect(result.success).toBe(true);
  });
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
        apiKey: "sk-test-only-value",
        summaryPrompts: {
          daily: "突出当天已经完成的结果。",
          weekly: null,
          monthly: "归纳本月最重要的业务产出。"
        }
      }).success
    ).toBe(true);
    expect(
      LlmSettingsUpdateSchema.safeParse({
        provider: "DEEPSEEK",
        encryptedApiKey: "must-never-cross-the-api-boundary"
      }).success
    ).toBe(false);
    expect(
      LlmSettingsUpdateSchema.safeParse({
        provider: "DEEPSEEK",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        summaryPrompts: {
          daily: "控制字符\u0000",
          weekly: null,
          monthly: null
        }
      }).success
    ).toBe(false);
    expect(
      LlmSettingsUpdateSchema.safeParse({
        provider: "DEEPSEEK",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        summaryPrompts: {
          daily: "中".repeat(1_400),
          weekly: null,
          monthly: null
        }
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
          updatedAt: "2026-07-15T08:00:00.000Z",
          summaryPrompts: {
            daily: {
              instructions: "日总结要求",
              defaultInstructions: "默认日总结要求",
              effectivePrompt: "固定安全约束\n日总结要求\n固定 JSON 约束",
              isCustomized: true
            },
            weekly: {
              instructions: "周总结要求",
              defaultInstructions: "默认周总结要求",
              effectivePrompt: "固定安全约束\n周总结要求\n固定 JSON 约束",
              isCustomized: false
            },
            monthly: {
              instructions: "月总结要求",
              defaultInstructions: "默认月总结要求",
              effectivePrompt: "固定安全约束\n月总结要求\n固定 JSON 约束",
              isCustomized: false
            }
          }
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
          summaryPrompts: {
            daily: {
              instructions: "日总结要求",
              defaultInstructions: "默认日总结要求",
              effectivePrompt: "完整 Prompt",
              isCustomized: false
            },
            weekly: {
              instructions: "周总结要求",
              defaultInstructions: "默认周总结要求",
              effectivePrompt: "完整 Prompt",
              isCustomized: false
            },
            monthly: {
              instructions: "月总结要求",
              defaultInstructions: "默认月总结要求",
              effectivePrompt: "完整 Prompt",
              isCustomized: false
            }
          },
          apiKey: "secret"
        }
      }).success
    ).toBe(false);
  });
});
