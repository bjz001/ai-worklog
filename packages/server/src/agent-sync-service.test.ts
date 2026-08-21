import { describe, expect, it, vi } from "vitest";
import type { AgentSyncBatchRequest } from "@ai-worklog/contracts";
import {
  buildAgentBlobReferenceId,
  buildAgentEventId,
  buildAgentRunId,
  buildAgentTextSegmentId,
  sha256Hex
} from "@ai-worklog/core";
import {
  AgentPayloadIntegrityError,
  commitAgentSyncBatch,
  orderedAgentRecords,
  persistAgentSyncRecords,
  validateAgentBatchIntegrity
} from "./agent-sync-service";

const identity = {
  accountId: "account-a",
  deviceId: "device-mac",
  deviceTokenId: "token-current"
};
const source = {
  type: "DSH" as const,
  instanceId: "dsh-mac",
  parserVersion: "dsh-session-v1"
};
const sourceSessionId = "session-1";
const runId = buildAgentRunId({
  ...identity,
  sourceType: source.type,
  sourceInstanceId: source.instanceId,
  sourceSessionId
});
const sourceEventId = "42";
const eventId = buildAgentEventId({
  ...identity,
  sourceType: source.type,
  sourceInstanceId: source.instanceId,
  sourceSessionId,
  sourceEventId,
  sequence: 42
});
const rawText = "FAKE_SECRET_CANARY=sk-live-preserve-me\n完整工具结果";
const contentSha256 = sha256Hex(rawText);
const segmentId = buildAgentTextSegmentId({
  eventId,
  ordinal: 0,
  purpose: "TOOL_RESULT",
  contentSha256
});
const referenceId = buildAgentBlobReferenceId({
  runId,
  eventId,
  purpose: "ATTACHMENT",
  requestedPath: "/tmp/output.log"
});
const databaseId = (prefix: string, ...parts: string[]) => {
  const digest = sha256Hex([prefix, ...parts].join("\u001f"));
  return `${prefix}_${digest.slice(0, 64 - prefix.length - 1)}`;
};
const sessionDatabaseId = databaseId(
  "session",
  identity.accountId,
  source.type,
  source.instanceId,
  sourceSessionId
);
const eventDatabaseId = databaseId("event", identity.accountId, eventId);

function validBatch(): AgentSyncBatchRequest {
  return {
    protocolVersion: 2,
    batchId: "agent-batch-1",
    createdAt: "2026-08-21T10:00:00.000+08:00",
    source,
    records: [
      {
        recordType: "RUN",
        runId,
        sourceSessionId,
        startedAt: "2026-08-21T10:00:00.000+08:00",
        sourceTimeZone: "Asia/Shanghai",
        rawCaptureStatus: "CAPTURED",
        normalizedCoverage: "FULL",
        attachmentStatus: "PENDING",
        metadata: {}
      },
      {
        recordType: "EVENT",
        eventId,
        runId,
        sourceEventId,
        sequence: 42,
        turnIndex: 2,
        stepIndex: 1,
        kind: "TOOL_RESULT",
        occurredAt: "2026-08-21T10:00:01.000+08:00",
        sourceTimeZone: "Asia/Shanghai",
        contentSha256,
        rawPayloadSha256: sha256Hex(JSON.stringify({ output: rawText })),
        rawCaptureStatus: "CAPTURED",
        normalizedCoverage: "FULL",
        attachmentStatus: "PENDING",
        metadata: { toolName: "bash" }
      },
      {
        recordType: "TEXT_SEGMENT",
        segmentId,
        eventId,
        ordinal: 0,
        format: "TEXT",
        purpose: "TOOL_RESULT",
        text: rawText,
        contentSha256,
        byteLength: Buffer.byteLength(rawText),
        isSearchable: true
      },
      {
        recordType: "BLOB_REFERENCE",
        referenceId,
        eventId,
        runId,
        blobSha256: null,
        purpose: "ATTACHMENT",
        requestedPath: "/tmp/output.log",
        realPath: null,
        filename: "output.log",
        mediaType: "text/plain",
        byteLength: null,
        status: "PENDING",
        failureReason: null,
        metadata: {}
      }
    ]
  };
}

describe("validateAgentBatchIntegrity", () => {
  it("accepts verbatim raw content while validating every deterministic identity", () => {
    expect(() => validateAgentBatchIntegrity(validBatch(), identity)).not.toThrow();
    const segment = validBatch().records.find(
      (record) => record.recordType === "TEXT_SEGMENT"
    );
    expect(segment && "text" in segment ? segment.text : "").toContain(
      "sk-live-preserve-me"
    );
  });

  it("rejects a changed event identity before persistence", () => {
    const batch = validBatch();
    const event = batch.records.find((record) => record.recordType === "EVENT");
    if (!event || event.recordType !== "EVENT") throw new Error("fixture");
    event.eventId = "f".repeat(64);

    expect(() => validateAgentBatchIntegrity(batch, identity)).toThrow(
      AgentPayloadIntegrityError
    );
  });

  it("rejects text whose byte length or digest does not match", () => {
    const batch = validBatch();
    const segment = batch.records.find(
      (record) => record.recordType === "TEXT_SEGMENT"
    );
    if (!segment || segment.recordType !== "TEXT_SEGMENT") throw new Error("fixture");
    segment.text += "tampered";

    expect(() => validateAgentBatchIntegrity(batch, identity)).toThrow(
      AgentPayloadIntegrityError
    );
  });
});

describe("orderedAgentRecords", () => {
  it("always persists run and event identities before dependent content", () => {
    const records = [...validBatch().records].reverse();
    expect(orderedAgentRecords(records).map((record) => record.recordType)).toEqual([
      "RUN",
      "EVENT",
      "TEXT_SEGMENT",
      "BLOB_REFERENCE"
    ]);
  });
});

describe("persistAgentSyncRecords", () => {
  it("rejects an event-only follow-up whose deterministic identity is forged", async () => {
    const payload = validBatch();
    const event = payload.records.find((record) => record.recordType === "EVENT");
    if (!event || event.recordType !== "EVENT") throw new Error("fixture");
    event.eventId = "f".repeat(64);
    payload.records = [event];
    const execute = vi.fn(async (sql: unknown, _parameters?: unknown[]) => {
      void _parameters;
      if (String(sql).includes("FROM sessions")) {
        return [[{
          id: sessionDatabaseId,
          account_id: identity.accountId,
          device_id: identity.deviceId,
          project_id: null,
          run_id: runId,
          source_type: source.type,
          source_instance_id: source.instanceId,
          source_session_id: sourceSessionId
        }], []];
      }
      return [{ affectedRows: 1 }, []];
    });

    await expect(persistAgentSyncRecords({
      connection: { execute } as never,
      identity,
      payload,
      batchDatabaseId: "batch-db"
    })).rejects.toThrow(AgentPayloadIntegrityError);
    expect(execute.mock.calls.some((call) =>
      String(call[0]).includes("INSERT INTO collected_events")
    )).toBe(false);
  });

  it("rejects normalized text whose group digest differs from its event declaration", async () => {
    const payload = validBatch();
    const segment = payload.records.find((record) =>
      record.recordType === "TEXT_SEGMENT"
    );
    if (!segment || segment.recordType !== "TEXT_SEGMENT") throw new Error("fixture");
    const changedText = "different complete tool result";
    segment.text = changedText;
    segment.contentSha256 = sha256Hex(changedText);
    segment.byteLength = Buffer.byteLength(changedText);
    segment.segmentId = buildAgentTextSegmentId({
      eventId,
      ordinal: 0,
      purpose: segment.purpose,
      contentSha256: segment.contentSha256
    });
    payload.records = [segment];
    const execute = vi.fn(async (sql: unknown, _parameters?: unknown[]) => {
      void _parameters;
      if (String(sql).includes("FROM collected_events")) {
        return [[{
          id: eventDatabaseId,
          session_id: sessionDatabaseId,
          project_id: null,
          event_id: eventId,
          source_event_id: sourceEventId,
          sequence: 42,
          kind: "TOOL_RESULT",
          reply_to_event_id: null,
          mirror_of_event_id: null,
          occurred_at: new Date("2026-08-21T02:00:01.000Z"),
          source_time_zone: "Asia/Shanghai",
          content_hash: contentSha256,
          raw_payload_sha256: sha256Hex(JSON.stringify({ output: rawText })),
          current_version: 0,
          session_device_id: identity.deviceId,
          session_source_type: source.type,
          session_source_instance_id: source.instanceId
        }], []];
      }
      return [{ affectedRows: 1 }, []];
    });

    await expect(persistAgentSyncRecords({
      connection: { execute } as never,
      identity,
      payload,
      batchDatabaseId: "batch-db"
    })).rejects.toThrow(AgentPayloadIntegrityError);
    expect(execute.mock.calls.some((call) =>
      String(call[0]).includes("INSERT INTO agent_text_segments")
    )).toBe(false);
  });

  it("rejects raw text whose group digest differs from its raw payload declaration", async () => {
    const payload = validBatch();
    const event = payload.records.find((record) => record.recordType === "EVENT");
    const segment = payload.records.find((record) =>
      record.recordType === "TEXT_SEGMENT"
    );
    if (
      !event || event.recordType !== "EVENT" ||
      !segment || segment.recordType !== "TEXT_SEGMENT"
    ) throw new Error("fixture");
    const declaredRaw = event.rawPayloadSha256;
    const changedRaw = JSON.stringify({ output: "changed raw payload" });
    segment.purpose = "RAW_PAYLOAD";
    segment.text = changedRaw;
    segment.contentSha256 = sha256Hex(changedRaw);
    segment.byteLength = Buffer.byteLength(changedRaw);
    segment.segmentId = buildAgentTextSegmentId({
      eventId,
      ordinal: 0,
      purpose: segment.purpose,
      contentSha256: segment.contentSha256
    });
    payload.records = [segment];
    const execute = vi.fn(async (sql: unknown, _parameters?: unknown[]) => {
      void _parameters;
      if (String(sql).includes("FROM collected_events")) {
        return [[{
          id: eventDatabaseId,
          session_id: sessionDatabaseId,
          project_id: null,
          event_id: eventId,
          source_event_id: sourceEventId,
          sequence: 42,
          kind: "TOOL_RESULT",
          reply_to_event_id: null,
          mirror_of_event_id: null,
          occurred_at: new Date("2026-08-21T02:00:01.000Z"),
          source_time_zone: "Asia/Shanghai",
          content_hash: contentSha256,
          raw_payload_sha256: declaredRaw,
          current_version: 0,
          session_device_id: identity.deviceId,
          session_source_type: source.type,
          session_source_instance_id: source.instanceId
        }], []];
      }
      return [{ affectedRows: 1 }, []];
    });

    await expect(persistAgentSyncRecords({
      connection: { execute } as never,
      identity,
      payload,
      batchDatabaseId: "batch-db"
    })).rejects.toThrow(AgentPayloadIntegrityError);
  });

  it("writes identities before content and keeps raw bodies out of SQL text", async () => {
    const execute = vi.fn(async (sql: unknown, _parameters?: unknown[]) => {
      void _parameters;
      const statement = String(sql);
      if (statement.includes("FROM sessions") && statement.includes("run_id")) {
        return [[{
          id: sessionDatabaseId,
          account_id: identity.accountId,
          device_id: identity.deviceId,
          project_id: null,
          run_id: runId,
          source_type: source.type,
          source_instance_id: source.instanceId,
          source_session_id: sourceSessionId
        }], []];
      }
      if (statement.includes("session_device_id")) {
        return [[{
          id: eventDatabaseId,
          session_id: sessionDatabaseId,
          event_id: eventId,
          source_event_id: sourceEventId,
          sequence: 42,
          kind: "TOOL_RESULT",
          reply_to_event_id: null,
          mirror_of_event_id: null,
          occurred_at: new Date("2026-08-21T02:00:01.000Z"),
          source_time_zone: "Asia/Shanghai",
          content_hash: contentSha256,
          current_version: 0,
          project_id: null,
          session_device_id: identity.deviceId,
          session_source_type: source.type,
          session_source_instance_id: source.instanceId
        }], []];
      }
      if (statement.includes("FROM event_versions")) {
        return [[{ max_version: 0 }], []];
      }
      if (statement.includes("FROM blob_objects")) return [[], []];
      return [{ affectedRows: 1 }, []];
    });

    const result = await persistAgentSyncRecords({
      connection: { execute } as never,
      identity,
      payload: validBatch(),
      batchDatabaseId: "batch-db"
    });

    const statements = execute.mock.calls.map((call) => String(call[0]));
    const indexOf = (needle: string) => statements.findIndex((sql) => sql.includes(needle));
    expect(indexOf("INSERT INTO sessions")).toBeLessThan(
      indexOf("INSERT INTO collected_events")
    );
    expect(indexOf("INSERT INTO collected_events")).toBeLessThan(
      indexOf("INSERT INTO agent_text_segments")
    );
    expect(indexOf("INSERT INTO agent_text_segments")).toBeLessThan(
      indexOf("INSERT INTO event_blob_references")
    );
    expect(statements.join("\n")).not.toContain("sk-live-preserve-me");
    expect(execute.mock.calls.some((call) =>
      Array.isArray(call[1]) && call[1].includes(rawText)
    )).toBe(true);
    expect(result).toEqual({ insertedCount: 4, duplicateCount: 0, changedCount: 0 });
  });

  it("rejects a text-only follow-up batch for another device's event", async () => {
    const payload = validBatch();
    payload.records = payload.records.filter(
      (record) => record.recordType === "TEXT_SEGMENT"
    );
    const execute = vi.fn(async (sql: unknown, _parameters?: unknown[]) => {
      void _parameters;
      if (String(sql).includes("FROM collected_events")) {
        return [[{
          id: eventDatabaseId,
          session_id: sessionDatabaseId,
          project_id: null,
          event_id: eventId,
          source_event_id: sourceEventId,
          sequence: 42,
          kind: "TOOL_RESULT",
          reply_to_event_id: null,
          mirror_of_event_id: null,
          occurred_at: new Date("2026-08-21T02:00:01.000Z"),
          source_time_zone: "Asia/Shanghai",
          content_hash: contentSha256,
          current_version: 0,
          session_device_id: "another-device",
          session_source_type: source.type,
          session_source_instance_id: source.instanceId
        }], []];
      }
      return [{ affectedRows: 1 }, []];
    });

    await expect(persistAgentSyncRecords({
      connection: { execute } as never,
      identity,
      payload,
      batchDatabaseId: "batch-db"
    })).rejects.toThrow(AgentPayloadIntegrityError);
    expect(execute.mock.calls.some((call) =>
      String(call[0]).includes("INSERT INTO agent_text_segments")
    )).toBe(false);
  });

  it("projects v2 user originals and marks the account-local summary date dirty", async () => {
    const payload = validBatch();
    const event = payload.records.find((record) => record.recordType === "EVENT");
    const segment = payload.records.find((record) => record.recordType === "TEXT_SEGMENT");
    if (!event || event.recordType !== "EVENT" || !segment || segment.recordType !== "TEXT_SEGMENT") {
      throw new Error("fixture");
    }
    event.kind = "USER";
    segment.purpose = "RENDERED_CONTENT";
    segment.segmentId = buildAgentTextSegmentId({
      eventId,
      ordinal: 0,
      purpose: segment.purpose,
      contentSha256
    });
    payload.records = payload.records.filter((record) =>
      record.recordType !== "BLOB_REFERENCE"
    );
    const execute = vi.fn(async (sql: unknown, _parameters?: unknown[]) => {
      void _parameters;
      const statement = String(sql);
      if (statement.includes("FROM sessions") && statement.includes("run_id")) {
        return [[{
          id: sessionDatabaseId,
          account_id: identity.accountId,
          device_id: identity.deviceId,
          project_id: null,
          run_id: runId,
          source_type: source.type,
          source_instance_id: source.instanceId,
          source_session_id: sourceSessionId
        }], []];
      }
      if (statement.includes("session_device_id")) {
        return [[{
          id: eventDatabaseId,
          session_id: sessionDatabaseId,
          project_id: null,
          event_id: eventId,
          source_event_id: sourceEventId,
          sequence: 42,
          kind: "USER",
          reply_to_event_id: null,
          mirror_of_event_id: null,
          occurred_at: new Date("2026-08-21T16:30:00.000Z"),
          source_time_zone: "Asia/Shanghai",
          content_hash: contentSha256,
          current_version: 0,
          session_device_id: identity.deviceId,
          session_source_type: source.type,
          session_source_instance_id: source.instanceId
        }], []];
      }
      if (statement.includes("COUNT(*) AS segment_count")) {
        return [[{
          segment_count: 1,
          total_byte_length: Buffer.byteLength(rawText),
          min_ordinal: 0,
          max_ordinal: 0,
          min_group_byte_length: Buffer.byteLength(rawText),
          max_group_byte_length: Buffer.byteLength(rawText),
          min_group_segment_count: 1,
          max_group_segment_count: 1
        }], []];
      }
      if (statement.includes("SELECT content, content_sha256")) {
        return [[{
          content: rawText,
          content_sha256: contentSha256,
          byte_length: Buffer.byteLength(rawText),
          ordinal: 0,
          group_byte_length: Buffer.byteLength(rawText),
          group_segment_count: 1
        }], []];
      }
      if (statement.includes("SELECT id, version FROM event_versions")) return [[], []];
      if (statement.includes("MAX(version)")) return [[{ max_version: 0 }], []];
      if (statement.includes("SELECT time_zone FROM accounts")) {
        return [[{ time_zone: "Asia/Shanghai" }], []];
      }
      return [{ affectedRows: 1 }, []];
    });

    await persistAgentSyncRecords({
      connection: { execute } as never,
      identity,
      payload,
      batchDatabaseId: "batch-db"
    });

    const calls = execute.mock.calls;
    expect(calls.some((call) => String(call[0]).includes("INSERT INTO prompt_entries")))
      .toBe(true);
    expect(calls.some((call) =>
      String(call[0]).includes("CONCAT(sanitized_content, ?)")
    )).toBe(true);
    expect(calls.some((call) =>
      String(call[0]).includes("SELECT content, byte_length, ordinal")
    )).toBe(false);
    const summaryJob = calls.find((call) =>
      String(call[0]).includes("INSERT INTO summary_jobs")
    );
    expect(summaryJob?.[1]).toEqual([identity.accountId, "2026-08-22"]);
    expect(calls.some((call) =>
      Array.isArray(call[1]) && call[1].includes(rawText)
    )).toBe(true);
  });
});

describe("commitAgentSyncBatch", () => {
  it("commits an event-first batch through the v2 transaction path", async () => {
    const payload = validBatch();
    payload.records = payload.records.filter((record) =>
      record.recordType === "RUN" || record.recordType === "EVENT"
    );
    const payloadHash = sha256Hex(JSON.stringify(payload));
    const execute = vi.fn(async (sql: unknown, _parameters?: unknown[]) => {
      void _parameters;
      const statement = String(sql);
      if (statement.includes("FROM devices")) {
        return [[{ id: identity.deviceId }], []];
      }
      if (statement.includes("FROM device_tokens")) {
        return [[{ id: identity.deviceTokenId }], []];
      }
      if (statement.includes("FROM sync_batches")) {
        return [[{
          id: "batch-db",
          payload_hash: payloadHash,
          status: "RECEIVED",
          result: null
        }], []];
      }
      if (statement.includes("FROM sessions") && statement.includes("run_id")) {
        return [[{
          id: sessionDatabaseId,
          account_id: identity.accountId,
          device_id: identity.deviceId,
          project_id: null,
          run_id: runId,
          source_type: source.type,
          source_instance_id: source.instanceId,
          source_session_id: sourceSessionId
        }], []];
      }
      if (statement.includes("session_device_id")) {
        return [[{
          id: eventDatabaseId,
          session_id: sessionDatabaseId,
          project_id: null,
          event_id: eventId,
          source_event_id: sourceEventId,
          sequence: 42,
          kind: "TOOL_RESULT",
          reply_to_event_id: null,
          mirror_of_event_id: null,
          occurred_at: new Date("2026-08-21T02:00:01.000Z"),
          source_time_zone: "Asia/Shanghai",
          content_hash: contentSha256,
          current_version: 0,
          session_device_id: identity.deviceId,
          session_source_type: source.type,
          session_source_instance_id: source.instanceId
        }], []];
      }
      return [{ affectedRows: 1 }, []];
    });
    const connection = {
      execute,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      destroy: vi.fn()
    };

    const result = await commitAgentSyncBatch({
      pool: { getConnection: vi.fn().mockResolvedValue(connection) } as never,
      identity,
      validated: { payload, payloadHash },
      requestId: "request-v2"
    });

    expect(result.status).toBe("COMMITTED");
    expect(result.receivedCount).toBe(2);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });
});
