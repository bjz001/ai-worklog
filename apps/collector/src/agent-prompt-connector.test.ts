import { describe, expect, it } from "vitest";
import { sha256Hex } from "@ai-worklog/core";
import type {
  AgentCapture,
  AgentConnector
} from "./agent-connector.js";
import { AgentPromptConnector } from "./agent-prompt-connector.js";

const runId = "r".repeat(64);

function capture(): AgentCapture {
  const userEventId = "u".repeat(64);
  const contextEventId = "c".repeat(64);
  const userText = "api_key=FAKE_PROMPT_CANARY_1234567890";
  const contextText = "FULL SYSTEM CONTEXT MUST NOT BE SENT";
  return {
    accountId: "account-1",
    deviceId: "device-1",
    sourceType: "ZCODE",
    sourceInstanceId: "zcode-device-1",
    parserVersion: "zcode-hook-spool-v1",
    sourceSessionId: "z-session-1",
    attachmentRequests: [],
    records: [
      {
        recordType: "RUN",
        runId,
        sourceSessionId: "z-session-1",
        startedAt: "2026-08-28T01:00:00.000Z",
        endedAt: "2026-08-28T01:01:00.000Z",
        sourceTimeZone: "UTC",
        projectHint: { repoRootName: "worklog" },
        rawCaptureStatus: "CAPTURED",
        normalizedCoverage: "FULL",
        attachmentStatus: "NOT_APPLICABLE",
        metadata: {}
      },
      {
        recordType: "EVENT",
        eventId: contextEventId,
        runId,
        sourceEventId: "request/header",
        sequence: 1,
        turnIndex: null,
        stepIndex: null,
        kind: "CONTEXT",
        occurredAt: "2026-08-28T01:00:01.000Z",
        sourceTimeZone: "UTC",
        replyToEventId: null,
        mirrorOfEventId: null,
        contentSha256: sha256Hex(contextText),
        rawPayloadSha256: sha256Hex(contextText),
        rawCaptureStatus: "CAPTURED",
        normalizedCoverage: "FULL",
        attachmentStatus: "NOT_APPLICABLE",
        metadata: {}
      },
      {
        recordType: "TEXT_SEGMENT",
        segmentId: "s".repeat(64),
        eventId: contextEventId,
        ordinal: 0,
        format: "TEXT",
        purpose: "RENDERED_CONTENT",
        text: contextText,
        contentSha256: sha256Hex(contextText),
        byteLength: Buffer.byteLength(contextText),
        groupSha256: sha256Hex(contextText),
        groupByteLength: Buffer.byteLength(contextText),
        groupSegmentCount: 1,
        isSearchable: true
      },
      {
        recordType: "EVENT",
        eventId: userEventId,
        runId,
        sourceEventId: "UserPromptSubmit:event:line:2",
        sequence: 2,
        turnIndex: 1,
        stepIndex: null,
        kind: "USER",
        occurredAt: "2026-08-28T01:00:02.000Z",
        sourceTimeZone: "UTC",
        replyToEventId: null,
        mirrorOfEventId: null,
        contentSha256: sha256Hex(userText),
        rawPayloadSha256: sha256Hex(userText),
        rawCaptureStatus: "CAPTURED",
        normalizedCoverage: "FULL",
        attachmentStatus: "NOT_APPLICABLE",
        metadata: {}
      },
      {
        recordType: "TEXT_SEGMENT",
        segmentId: "t".repeat(64),
        eventId: userEventId,
        ordinal: 0,
        format: "TEXT",
        purpose: "RENDERED_CONTENT",
        text: userText,
        contentSha256: sha256Hex(userText),
        byteLength: Buffer.byteLength(userText),
        groupSha256: sha256Hex(userText),
        groupByteLength: Buffer.byteLength(userText),
        groupSegmentCount: 1,
        isSearchable: true
      }
    ]
  };
}

describe("AgentPromptConnector", () => {
  it("emits only complete raw user prompts and drops context/assistant data", async () => {
    const source: AgentConnector = {
      sourceType: "ZCODE",
      sourceInstanceId: "zcode-device-1",
      parserVersion: "zcode-hook-spool-v1",
      readSource: async () => [capture()]
    };

    const session = await new AgentPromptConnector({ connector: source })
      .readFile("/tmp/events.jsonl");
    const event = session.events[0];

    expect(session.events).toHaveLength(1);
    expect(event).toMatchObject({
      kind: "USER_PROMPT",
      sourceSessionId: "z-session-1",
      sanitizedContent: "api_key=FAKE_PROMPT_CANARY_1234567890",
      redactionVersion: "RAW_V1",
      projectHint: { repoRootName: "worklog" },
      contentHash: sha256Hex("api_key=FAKE_PROMPT_CANARY_1234567890")
    });
    expect(JSON.stringify(session)).not.toContain("FULL SYSTEM CONTEXT");
  });

  it("forwards streamed captures one session at a time", async () => {
    const source: AgentConnector = {
      sourceType: "ZCODE",
      sourceInstanceId: "zcode-device-1",
      parserVersion: "zcode-hook-spool-v1",
      readSource: async () => [],
      readSourceEach: async (_path, onCapture) => {
        await onCapture(capture());
        await onCapture({
          ...capture(),
          sourceSessionId: "z-session-2"
        });
      }
    };
    const sessions: string[] = [];

    await new AgentPromptConnector({ connector: source }).readFileSessions(
      "/tmp/events.jsonl",
      async (session) => {
        sessions.push(session.events[0]?.sourceSessionId ?? "");
      }
    );

    expect(sessions).toEqual(["z-session-1", "z-session-2"]);
  });

  it("prefers a prompt-only stream over materializing full captures", async () => {
    const source: AgentConnector = {
      sourceType: "DSH",
      sourceInstanceId: "windows-dsh",
      parserVersion: "dsh-official-session-v1-prompt-v1",
      readSource: async () => [],
      readSourceEach: async () => {
        throw new Error("full capture path should not be used");
      },
      readPromptSourceEach: async (_path, onSession) => {
        await onSession({ sessionId: "dsh-session-1", events: [] });
      }
    };
    const sessions: string[] = [];

    await new AgentPromptConnector({ connector: source }).readFileSessions(
      "/tmp/dsh",
      async (session) => {
        sessions.push(session.sessionId);
      }
    );

    expect(sessions).toEqual(["dsh-session-1"]);
  });
});
