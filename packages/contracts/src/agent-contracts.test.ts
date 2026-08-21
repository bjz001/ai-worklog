import { describe, expect, it } from "vitest";
import {
  AgentEventKindSchema,
  AgentSourceTypeSchema,
  AgentSyncBatchRequestSchema,
  AgentTextSegmentRecordSchema,
  BlobCompleteRequestSchema,
  BlobCompleteResponseSchema,
  BlobInitializeResponseSchema,
  BlobManifestRequestSchema,
  MAX_BLOB_CHUNK_BYTES,
  SyncRequestSchema
} from "./index";

const sha = (digit: string) => digit.repeat(64);

describe("agent trajectory protocol v2", () => {
  it("accepts all four sources and the complete normalized event vocabulary", () => {
    for (const source of ["CODEX", "CLAUDE_CODE", "ZCODE", "DSH"]) {
      expect(AgentSourceTypeSchema.safeParse(source).success).toBe(true);
    }

    for (const kind of [
      "SYSTEM",
      "CONTEXT",
      "USER",
      "ASSISTANT",
      "REASONING",
      "TOOL_CALL",
      "TOOL_RESULT",
      "SUBAGENT",
      "STATE",
      "TURN_BOUNDARY",
      "ERROR",
      "SOURCE_EVENT"
    ]) {
      expect(AgentEventKindSchema.safeParse(kind).success).toBe(true);
    }
  });

  it("preserves raw text verbatim without a redaction or content-length field", () => {
    const rawCanary = "sk-live-FAKE-CANARY\n" + "完整推理".repeat(70_000);
    const parsed = AgentSyncBatchRequestSchema.parse({
      protocolVersion: 2,
      batchId: "v2-batch-1",
      createdAt: "2026-08-21T10:00:00.000+08:00",
      source: {
        type: "DSH",
        instanceId: "macbook",
        parserVersion: "dsh@1"
      },
      records: [
        {
          recordType: "RUN",
          runId: sha("1"),
          sourceSessionId: "session-1",
          startedAt: "2026-08-21T10:00:00.000+08:00",
          sourceTimeZone: "Asia/Shanghai",
          rawCaptureStatus: "CAPTURED",
          normalizedCoverage: "FULL",
          attachmentStatus: "PENDING",
          metadata: {}
        },
        {
          recordType: "EVENT",
          eventId: sha("2"),
          runId: sha("1"),
          sourceEventId: "42",
          sequence: 42,
          turnIndex: 3,
          stepIndex: 1,
          kind: "REASONING",
          occurredAt: "2026-08-21T10:00:01.000+08:00",
          sourceTimeZone: "Asia/Shanghai",
          rawCaptureStatus: "CAPTURED",
          normalizedCoverage: "FULL",
          attachmentStatus: "NOT_APPLICABLE",
          rawPayloadSha256: sha("3"),
          metadata: {}
        },
        {
          recordType: "TEXT_SEGMENT",
          segmentId: sha("4"),
          eventId: sha("2"),
          ordinal: 0,
          format: "TEXT",
          purpose: "RENDERED_CONTENT",
          text: rawCanary,
          contentSha256: sha("5"),
          byteLength: new TextEncoder().encode(rawCanary).byteLength,
          isSearchable: true
        }
      ]
    });

    const segment = parsed.records[2];
    expect(segment?.recordType).toBe("TEXT_SEGMENT");
    if (segment?.recordType === "TEXT_SEGMENT") {
      expect(segment.text).toBe(rawCanary);
      expect(segment).not.toHaveProperty("redactionVersion");
      expect(segment).not.toHaveProperty("sanitizedContent");
    }
  });

  it("treats text segments as transport units instead of a text-size cap", () => {
    expect(AgentTextSegmentRecordSchema.safeParse({
      recordType: "TEXT_SEGMENT",
      segmentId: sha("1"),
      eventId: sha("2"),
      ordinal: 1_500,
      format: "TEXT",
      purpose: "RAW_PAYLOAD",
      text: "continuation",
      contentSha256: sha("3"),
      byteLength: 12,
      groupSha256: sha("4"),
      groupByteLength: 10_000_000_000,
      groupSegmentCount: 2_000,
      isSearchable: true
    }).success).toBe(true);
  });

  it("accepts missing source content only when an explicit reason is recorded", () => {
    const base = {
      recordType: "EVENT",
      eventId: sha("6"),
      runId: sha("1"),
      sourceEventId: "encrypted-reasoning",
      sequence: 7,
      kind: "REASONING",
      occurredAt: "2026-08-21T10:00:01.000+08:00",
      sourceTimeZone: "Asia/Shanghai",
      rawCaptureStatus: "NOT_EXPOSED",
      normalizedCoverage: "NONE",
      attachmentStatus: "NOT_APPLICABLE",
      metadata: {}
    } as const;

    const request = (record: Record<string, unknown>) => ({
      protocolVersion: 2,
      batchId: "v2-batch-2",
      createdAt: "2026-08-21T10:00:00.000+08:00",
      source: {
        type: "CODEX",
        instanceId: "macbook",
        parserVersion: "codex@1"
      },
      records: [
        {
          recordType: "RUN",
          runId: sha("1"),
          sourceSessionId: "session-1",
          startedAt: "2026-08-21T10:00:00.000+08:00",
          sourceTimeZone: "Asia/Shanghai",
          rawCaptureStatus: "PARTIAL",
          normalizedCoverage: "PARTIAL",
          attachmentStatus: "NOT_APPLICABLE",
          metadata: {}
        },
        record
      ]
    });

    expect(AgentSyncBatchRequestSchema.safeParse(request(base)).success).toBe(false);
    expect(AgentSyncBatchRequestSchema.safeParse(request({
      ...base,
      missingReason: "Source stored only encrypted reasoning bytes"
    })).success).toBe(true);
  });

  it("keeps protocol v1 unchanged while accepting v2 through the union boundary", () => {
    const v1 = {
      protocolVersion: 1,
      batchId: "legacy",
      createdAt: "2026-08-21T10:00:00.000+08:00",
      source: {
        type: "CODEX",
        instanceId: "legacy-device",
        parserVersion: "legacy@1"
      },
      events: [{
        eventId: sha("a"),
        kind: "USER_PROMPT",
        sourceSessionId: "legacy-session",
        sourceMessageId: "message-1",
        messageIndex: 0,
        occurredAt: "2026-08-21T10:00:00.000+08:00",
        sourceTimeZone: "Asia/Shanghai",
        sanitizedContent: "legacy sanitized content",
        contentHash: sha("b"),
        redactionVersion: "core-v1",
        metadata: {}
      }]
    };

    expect(SyncRequestSchema.safeParse(v1).success).toBe(true);
    expect(SyncRequestSchema.safeParse({
      ...v1,
      source: { ...v1.source, type: "DSH" }
    }).success).toBe(false);
  });
});

describe("blob sync contracts", () => {
  it("fixes the transport chunk size at one MiB without imposing an object cap", () => {
    expect(MAX_BLOB_CHUNK_BYTES).toBe(1_048_576);
    expect(BlobManifestRequestSchema.safeParse({
      byteLength: Number.MAX_SAFE_INTEGER,
      chunkSize: MAX_BLOB_CHUNK_BYTES,
      mediaType: "application/octet-stream",
      filename: "large-transcript.bin"
    }).success).toBe(true);
    expect(BlobManifestRequestSchema.safeParse({
      byteLength: 100,
      chunkSize: 512,
      mediaType: "text/plain"
    }).success).toBe(false);
  });

  it("requires the completed object digest and exact chunk count", () => {
    expect(BlobCompleteRequestSchema.safeParse({
      byteLength: 2_000_000,
      chunkCount: 2,
      sha256: sha("f")
    }).success).toBe(true);
    expect(BlobCompleteRequestSchema.safeParse({
      byteLength: 2_000_000,
      chunkCount: 0,
      sha256: sha("f")
    }).success).toBe(false);
    expect(BlobCompleteRequestSchema.safeParse({
      byteLength: 0,
      chunkCount: 0,
      sha256: sha("e")
    }).success).toBe(true);
    expect(BlobCompleteRequestSchema.safeParse({
      byteLength: MAX_BLOB_CHUNK_BYTES + 1,
      chunkCount: 1,
      sha256: sha("d")
    }).success).toBe(false);
  });

  it("never exposes a server filesystem path in Blob API responses", () => {
    expect(BlobInitializeResponseSchema.safeParse({
      data: {
        sha256: sha("a"),
        status: "UPLOADING",
        chunkSize: MAX_BLOB_CHUNK_BYTES,
        chunkCount: 2,
        receivedChunks: [0]
      }
    }).success).toBe(true);
    expect(BlobCompleteResponseSchema.safeParse({
      data: {
        sha256: sha("a"),
        status: "COMPLETE",
        byteLength: 42,
        path: "/private/blob/root"
      }
    }).success).toBe(false);
  });
});
