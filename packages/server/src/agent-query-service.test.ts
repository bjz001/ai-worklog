import type { Pool } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { sha256Hex as sha256ForTest } from "@ai-worklog/core";
import {
  decodeAgentEventCursor,
  getAgentEventContent,
  getAgentRunDetail,
  listAgentEvents,
  listAgentRuns
} from "./agent-query-service";

describe("listAgentRuns", () => {
  it("pushes account scope and all filters into MySQL while grouping by run", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      async execute(sql: string, values: unknown[]) {
        calls.push({ sql, values });
        if (sql.includes("SELECT time_zone")) {
          return [[{ time_zone: "Asia/Shanghai" }], []];
        }
        if (sql.includes("COUNT(DISTINCT s.id)")) {
          return [[{ total: 7 }], []];
        }
        return [[{
          id: "session-db",
          run_id: "a".repeat(64),
          source_type: "DSH",
          source_session_id: "source-session",
          title: "工具轨迹",
          cwd: "/workspace/worklog",
          project_id: "project-1",
          project_name: "worklog",
          device_id: "device-1",
          device_name: "MacBook",
          started_at: new Date("2026-08-20T16:00:00.000Z"),
          ended_at: null,
          event_count: 49,
          turn_count: 3,
          matched_event_count: 2,
          match_snippet: "完整工具结果",
          raw_capture_status: "PARTIAL",
          normalized_coverage: "PARTIAL",
          attachment_status: "PENDING"
        }], []];
      }
    } as unknown as Pool;

    const response = await listAgentRuns({
      pool,
      accountId: "account-1",
      query: {
        page: 2,
        pageSize: 25,
        q: "工具结果",
        source: "DSH",
        from: "2026-08-01",
        to: "2026-08-21",
        projectId: "project-1",
        eventKind: "TOOL_RESULT",
        completeness: "PARTIAL"
      }
    });

    expect(response.pagination).toEqual({
      page: 2,
      pageSize: 25,
      totalItems: 7,
      totalPages: 1
    });
    expect(response.data[0]).toMatchObject({
      id: "session-db",
      sourceType: "DSH",
      eventCount: 49,
      matchedEventCount: 2,
      matchSnippet: "完整工具结果"
    });
    expect(calls).toHaveLength(3);
    expect(calls[1]?.sql).toContain("s.account_id = ?");
    expect(calls[1]?.sql).toContain("MATCH(ts.content) AGAINST");
    expect(calls[1]?.sql).toContain("ts.content LIKE");
    expect(calls[1]?.sql).toContain("br.requested_path LIKE");
    expect(calls[1]?.sql).toContain("run_br.collected_event_id IS NULL");
    expect(calls[1]?.sql).toContain("ce.kind = ?");
    expect(calls[1]?.values).toContain("account-1");
    expect(calls[1]?.values).toContain("TOOL_RESULT");
    expect(calls[2]?.sql).toContain("ORDER BY s.started_at DESC, s.id DESC");
    expect(calls[2]?.sql).toContain("LIMIT 25 OFFSET 25");
    expect(calls[2]?.sql).toContain("CASE WHEN ts.is_searchable = TRUE");
    expect(calls[2]?.values.filter((value) => value === "工具结果")).toHaveLength(4);
  });
});

describe("getAgentRunDetail", () => {
  it("returns run-level source transcripts that are not owned by an event", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const blobSha256 = "d".repeat(64);
    const pool = {
      async execute(sql: string, values: unknown[]) {
        calls.push({ sql, values });
        if (sql.includes("FROM event_blob_references")) {
          return [[{
            id: "run-reference-db",
            collected_event_id: null,
            reference_id: "c".repeat(64),
            purpose: "SOURCE_TRANSCRIPT",
            filename: "session.jsonl",
            requested_path: "/tmp/session.jsonl",
            real_path: "/private/tmp/session.jsonl",
            byte_length: 4_096,
            blob_sha256: blobSha256,
            media_type: "application/x-ndjson",
            status: "CAPTURED",
            failure_reason: null
          }], []];
        }
        return [[{
          id: "session-db",
          run_id: "a".repeat(64),
          source_type: "DSH",
          source_session_id: "source-session",
          title: "DSH trajectory",
          cwd: "/workspace/worklog",
          project_id: null,
          project_name: "worklog",
          device_id: "device-1",
          device_name: "MacBook",
          started_at: new Date("2026-08-21T02:00:00.000Z"),
          ended_at: null,
          event_count: 49,
          turn_count: 3,
          matched_event_count: 0,
          match_snippet: null,
          raw_capture_status: "CAPTURED",
          normalized_coverage: "FULL",
          attachment_status: "CAPTURED",
          agent_metadata: "{}",
          missing_reasons: "[]",
          text_segment_count: 98,
          pending_blob_count: 0
        }], []];
      }
    } as unknown as Pool;

    const response = await getAgentRunDetail({
      pool,
      accountId: "account-1",
      runId: "session-db"
    });

    expect(response.data.attachments).toEqual([
      expect.objectContaining({
        purpose: "SOURCE_TRANSCRIPT",
        downloadUrl: `/api/v1/blobs/${blobSha256}`
      })
    ]);
    expect(calls[1]?.sql).toContain("br.collected_event_id IS NULL");
    expect(calls[1]?.values).toEqual(["account-1", "session-db"]);
  });
});

describe("listAgentEvents", () => {
  it("normalizes legacy kinds and returns a stable cursor without leaking another run", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      async execute(sql: string, values: unknown[]) {
        calls.push({ sql, values });
        if (sql.includes("FROM event_blob_references")) return [[], []];
        return [[
          {
            id: "event-db-1",
            event_id: "b".repeat(64),
            source_event_id: "message-1",
            sequence: 1,
            message_index: 1,
            turn_index: 0,
            step_index: null,
            kind: "USER_PROMPT",
            occurred_at: new Date("2026-08-21T02:00:01.000Z"),
            reply_to_event_id: null,
            mirror_of_event_id: null,
            content_preview: "完整用户提示词",
            content_purposes: "RENDERED_CONTENT",
            segment_count: 1,
            raw_segment_count: 0,
            raw_payload_sha256: null,
            raw_capture_status: "CAPTURED",
            normalized_coverage: "FULL",
            attachment_status: "NOT_APPLICABLE",
            missing_reason: null,
            metadata: JSON.stringify({ model: "codex" })
          },
          {
            id: "event-db-2",
            event_id: "c".repeat(64),
            source_event_id: "message-2",
            sequence: 2,
            message_index: 2,
            turn_index: 0,
            step_index: null,
            kind: "VISIBLE_RESULT",
            occurred_at: new Date("2026-08-21T02:00:02.000Z"),
            reply_to_event_id: "b".repeat(64),
            mirror_of_event_id: null,
            content_preview: "助手结果",
            content_purposes: "RENDERED_CONTENT",
            segment_count: 1,
            raw_segment_count: 0,
            raw_payload_sha256: null,
            raw_capture_status: "CAPTURED",
            normalized_coverage: "FULL",
            attachment_status: "NOT_APPLICABLE",
            missing_reason: null,
            metadata: "{}"
          }
        ], []];
      }
    } as unknown as Pool;

    const response = await listAgentEvents({
      pool,
      accountId: "account-1",
      runId: "session-db",
      query: { pageSize: 1, cursor: null }
    });

    expect(response.data).toHaveLength(1);
    expect(response.data[0]?.kind).toBe("USER");
    expect(response.pagination.hasMore).toBe(true);
    expect(decodeAgentEventCursor(response.pagination.nextCursor ?? "")).toEqual({
      sequence: 1,
      eventId: "b".repeat(64)
    });
    expect(calls[0]?.sql).toContain("s.id = ? AND s.account_id = ?");
    expect(calls[0]?.sql).toContain("ts.ordinal = 0");
    expect(calls[0]?.sql).toContain("ts.created_at DESC");
    expect(calls[0]?.values).toContain("account-1");
  });
});

describe("getAgentEventContent", () => {
  it("streams and reassembles an unmodified text group only inside the route account", async () => {
    const raw = "FAKE_SECRET_CANARY=sk-live-preserve-me\n完整正文";
    const parts = [raw.slice(0, 24), raw.slice(24)];
    const groupSha256 = sha256ForTest(raw);
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      async execute(sql: string, values: unknown[]) {
        calls.push({ sql, values });
        if (sql.includes("ts.ordinal = 0")) {
          return [[{
            format: "TEXT",
            purpose: "RAW_PAYLOAD",
            group_sha256: groupSha256,
            group_byte_length: Buffer.byteLength(raw),
            group_segment_count: 2
          }], []];
        }
        const nextOrdinal = Number(values.at(-1));
        if (nextOrdinal > 0) return [[], []];
        return [[
          {
            format: "TEXT",
            content: parts[0],
            content_sha256: sha256ForTest(parts[0] ?? ""),
            byte_length: Buffer.byteLength(parts[0] ?? ""),
            ordinal: 0
          },
          {
            format: "TEXT",
            content: parts[1],
            content_sha256: sha256ForTest(parts[1] ?? ""),
            byte_length: Buffer.byteLength(parts[1] ?? ""),
            ordinal: 1
          }
        ], []];
      }
    } as unknown as Pool;

    const content = await getAgentEventContent({
      pool,
      accountId: "account-1",
      eventId: "event-db",
      purpose: "RAW_PAYLOAD"
    });

    expect(content?.text).toBe(raw);
    expect(calls[0]?.sql).toContain("ce.account_id = ?");
    expect(calls[0]?.values).toEqual([
      "account-1",
      "event-db",
      "RAW_PAYLOAD"
    ]);
    expect(calls[1]?.sql).toContain("ts.group_sha256 = ?");
    expect(calls[1]?.values).toContain("account-1");
  });
});
