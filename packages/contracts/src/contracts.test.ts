import { describe, expect, it } from "vitest";
import { SyncBatchRequestSchema } from "./index";

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
});
