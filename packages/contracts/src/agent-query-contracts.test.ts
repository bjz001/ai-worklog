import { describe, expect, it } from "vitest";
import {
  AgentRunDetailResponseSchema,
  AgentRunEventsResponseSchema,
  AgentRunsResponseSchema
} from "./index";

const run = {
  id: "session-db",
  runId: "a".repeat(64),
  sourceType: "DSH",
  sourceSessionId: "session-1",
  title: "实现轨迹采集",
  cwd: "/workspace/worklog",
  projectId: "project-1",
  projectName: "worklog",
  deviceId: "device-1",
  deviceName: "MacBook",
  startedAt: "2026-08-21T02:00:00.000Z",
  endedAt: null,
  eventCount: 49,
  turnCount: 3,
  matchedEventCount: 2,
  matchSnippet: "工具调用结果",
  rawCaptureStatus: "CAPTURED",
  normalizedCoverage: "FULL",
  attachmentStatus: "PENDING"
} as const;

describe("Agent trajectory query responses", () => {
  it("keeps list results grouped by run without embedding full content", () => {
    expect(AgentRunsResponseSchema.safeParse({
      data: [run],
      pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 }
    }).success).toBe(true);
    expect(AgentRunsResponseSchema.safeParse({
      data: [{ ...run, fullContent: "must stream separately" }],
      pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 }
    }).success).toBe(false);
  });

  it("returns a strict run detail and a cursor-paged event timeline", () => {
    expect(AgentRunDetailResponseSchema.safeParse({
      data: {
        run,
        metadata: { model: "deepseek-v4" },
        completeness: {
          missingReasons: [],
          textSegmentCount: 48,
          pendingBlobCount: 1
        },
        attachments: [{
          id: "run-reference-db",
          referenceId: "e".repeat(64),
          purpose: "SOURCE_TRANSCRIPT",
          filename: "session.jsonl",
          requestedPath: "/tmp/session.jsonl",
          realPath: "/private/tmp/session.jsonl",
          byteLength: 4_096,
          sha256: "f".repeat(64),
          mediaType: "application/x-ndjson",
          status: "CAPTURED",
          failureReason: null,
          downloadUrl: `/api/v1/blobs/${"f".repeat(64)}`
        }]
      }
    }).success).toBe(true);

    expect(AgentRunEventsResponseSchema.safeParse({
      data: [{
        id: "event-db",
        eventId: "b".repeat(64),
        sourceEventId: "42",
        sequence: 42,
        turnIndex: 2,
        stepIndex: 1,
        kind: "TOOL_RESULT",
        occurredAt: "2026-08-21T02:00:01.000Z",
        replyToEventId: null,
        mirrorOfEventId: null,
        contentPreview: "工具执行完成",
        contentPurposes: ["TOOL_RESULT"],
        contentUrl: "/api/v1/agent-events/event-db/content",
        rawPayloadUrl: null,
        rawCaptureStatus: "CAPTURED",
        normalizedCoverage: "FULL",
        attachmentStatus: "PENDING",
        missingReason: null,
        metadata: { toolName: "bash" },
        attachments: [{
          id: "reference-db",
          referenceId: "c".repeat(64),
          purpose: "ATTACHMENT",
          filename: "output.log",
          requestedPath: "/tmp/output.log",
          realPath: "/private/tmp/output.log",
          byteLength: 42,
          sha256: "d".repeat(64),
          mediaType: "text/plain",
          status: "PENDING",
          failureReason: null,
          downloadUrl: null
        }]
      }],
      pagination: { nextCursor: "opaque-cursor", hasMore: true }
    }).success).toBe(true);
  });
});
