import { describe, expect, it } from "vitest";
import { sha256Hex } from "@ai-worklog/core";
import {
  BatchPayloadMismatchError,
  InvalidBatchError,
  validateIncomingBatch
} from "./index";

function validPayload() {
  return {
    protocolVersion: 1,
    batchId: "batch-macos-001",
    createdAt: "2026-07-14T15:30:00.000Z",
    source: {
      type: "CODEX",
      instanceId: "codex-macos",
      parserVersion: "codex-fixture@1"
    },
    events: [
      {
        eventId: "a".repeat(64),
        kind: "USER_PROMPT",
        sourceSessionId: "session-1",
        sourceMessageId: "message-1",
        messageIndex: 1,
        occurredAt: "2026-07-14T15:20:00.000Z",
        sourceTimeZone: "Asia/Shanghai",
        sanitizedContent: "请整理跨设备同步方案",
        contentHash: "b".repeat(64),
        redactionVersion: "1",
        projectHint: { gitRemoteKey: "github.com/acme/worklog" },
        metadata: {}
      }
    ]
  } as const;
}

describe("validateIncomingBatch", () => {
  it("accepts exact-body digest and matching idempotency key", () => {
    const body = JSON.stringify(validPayload());
    const result = validateIncomingBatch({
      body,
      idempotencyKey: "batch-macos-001",
      declaredPayloadHash: sha256Hex(body)
    });

    expect(result.payload.batchId).toBe("batch-macos-001");
    expect(result.payloadHash).toBe(sha256Hex(body));
  });

  it("rejects a changed body before parsing or persistence", () => {
    const body = JSON.stringify(validPayload());

    expect(() =>
      validateIncomingBatch({
        body,
        idempotencyKey: "batch-macos-001",
        declaredPayloadHash: "c".repeat(64)
      })
    ).toThrow(BatchPayloadMismatchError);
  });

  it("rejects an idempotency key that does not match the body", () => {
    const body = JSON.stringify(validPayload());

    expect(() =>
      validateIncomingBatch({
        body,
        idempotencyKey: "another-batch",
        declaredPayloadHash: sha256Hex(body)
      })
    ).toThrow(InvalidBatchError);
  });

  it("rejects unknown event fields at the API boundary", () => {
    const payload = validPayload();
    const body = JSON.stringify({
      ...payload,
      events: [{ ...payload.events[0], executeThisCommand: "rm -rf /" }]
    });

    expect(() =>
      validateIncomingBatch({
        body,
        idempotencyKey: payload.batchId,
        declaredPayloadHash: sha256Hex(body)
      })
    ).toThrow(InvalidBatchError);
  });

  it("accepts a protocol v2 batch without applying the v1 redaction contract", () => {
    const payload = {
      protocolVersion: 2,
      batchId: "agent-batch-001",
      createdAt: "2026-08-21T10:00:00.000+08:00",
      source: {
        type: "ZCODE",
        instanceId: "zcode-macos",
        parserVersion: "zcode-hook-v1"
      },
      records: [{
        recordType: "RUN",
        runId: "1".repeat(64),
        sourceSessionId: "zcode-session-1",
        startedAt: "2026-08-21T10:00:00.000+08:00",
        sourceTimeZone: "Asia/Shanghai",
        rawCaptureStatus: "CAPTURED",
        normalizedCoverage: "FULL",
        attachmentStatus: "PENDING",
        metadata: { rawCanary: "sk-live-FAKE-CANARY" }
      }]
    } as const;
    const body = JSON.stringify(payload);

    const result = validateIncomingBatch({
      body,
      idempotencyKey: payload.batchId,
      declaredPayloadHash: sha256Hex(body)
    });

    expect(result.payload.protocolVersion).toBe(2);
    if (result.payload.protocolVersion === 2) {
      expect(result.payload.records[0]).toEqual(payload.records[0]);
    }
  });
});
