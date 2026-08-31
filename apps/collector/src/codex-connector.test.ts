import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildEventId } from "@ai-worklog/core";
import { CodexConnector } from "./codex-connector.js";

const fixturesRoot = fileURLToPath(new URL("../../../fixtures/codex/", import.meta.url));

describe("CodexConnector", () => {
  it.each(["修复它", "好"])(
    "pairs the short visible prompt %s with a wrapped response without passthrough metadata",
    async (visiblePrompt) => {
    const directory = mkdtempSync(join(tmpdir(), "codex-short-prompt-"));
    const path = join(directory, "session.jsonl");
    const records = [
      {
        timestamp: "2026-07-15T08:00:00.000Z",
        type: "session_meta",
        payload: { id: "short-session", source_time_zone: "UTC" }
      },
      {
        timestamp: "2026-07-15T08:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: "short-client",
          message: visiblePrompt,
          images: [],
          local_images: [],
          text_elements: []
        }
      },
      {
        timestamp: "2026-07-15T08:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: `Synthetic wrapper context\n${visiblePrompt}`
          }]
        }
      }
    ];
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });

    const session = await connector.readFile(path);

    expect(session.events).toHaveLength(1);
    expect(session.events[0]).toMatchObject({
      kind: "USER_PROMPT",
      sanitizedContent: visiblePrompt,
      sourceMessageId: "short-client",
      metadata: {
        legacyEventAliases: [{
          eventId: expect.stringMatching(/^[a-f0-9]{64}$/u),
          sourceSessionId: "short-session"
        }]
      }
    });

    const rawSession = await new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex",
      captureMode: "raw-prompts"
    }).readFile(path);
    expect(rawSession.events).toHaveLength(1);
    expect(rawSession.events[0]).toMatchObject({
      kind: "USER_PROMPT",
      sanitizedContent: visiblePrompt,
      redactionVersion: "RAW_V1",
      metadata: {}
    });
    expect(rawSession.events[0]).not.toHaveProperty("projectHint");
  });

  it("emits both current-segment v3 and first-segment v2 aliases", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-multi-segment-alias-"));
    const path = join(directory, "session.jsonl");
    const records = [
      {
        timestamp: "2026-07-15T08:00:00.000Z",
        type: "session_meta",
        payload: { id: "segment-a", source_time_zone: "UTC" }
      },
      {
        timestamp: "2026-07-15T08:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: "client-a",
          message: "Prompt from segment A",
          images: [],
          local_images: [],
          text_elements: []
        }
      },
      {
        timestamp: "2026-07-15T08:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Prompt from segment A" }]
        }
      },
      {
        timestamp: "2026-07-15T08:01:00.000Z",
        type: "session_meta",
        payload: { id: "segment-b", source_time_zone: "UTC" }
      },
      {
        timestamp: "2026-07-15T08:01:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: "client-b",
          message: "Prompt from segment B",
          images: [],
          local_images: [],
          text_elements: []
        }
      },
      {
        timestamp: "2026-07-15T08:01:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Prompt from segment B" }]
        }
      },
      {
        timestamp: "2026-07-15T08:01:04.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Response only from segment B" }]
        }
      }
    ];
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });

    const session = await connector.readFile(path);
    const currentSegmentAlias = buildEventId({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceType: "CODEX",
      sourceInstanceId: "mac-codex",
      sourceSessionId: "segment-b",
      sourceMessageId: null,
      messageIndex: 1
    });
    const firstSegmentV2Alias = buildEventId({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceType: "CODEX",
      sourceInstanceId: "mac-codex",
      sourceSessionId: "segment-a",
      sourceMessageId: null,
      messageIndex: 1
    });
    const responseOnlyV2Alias = buildEventId({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceType: "CODEX",
      sourceInstanceId: "mac-codex",
      sourceSessionId: "segment-a",
      sourceMessageId: null,
      messageIndex: 2
    });

    expect(session.events.find((event) =>
      event.sourceSessionId === "segment-b"
    )?.metadata.legacyEventAliases).toEqual([
      { eventId: currentSegmentAlias, sourceSessionId: "segment-b" },
      { eventId: firstSegmentV2Alias, sourceSessionId: "segment-a" }
    ]);
    expect(session.events.find((event) =>
      event.sanitizedContent === "Response only from segment B"
    )?.metadata.legacyEventAliases).toEqual([
      { eventId: responseOnlyV2Alias, sourceSessionId: "segment-a" }
    ]);
  });

  it("keeps canonical event_msg identities when paired response_item records are appended later", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-append-identity-"));
    const path = join(directory, "session.jsonl");
    const initialRecords = [
      {
        timestamp: "2026-07-15T08:00:00.000Z",
        type: "session_meta",
        payload: { id: "append-session", source_time_zone: "UTC" }
      },
      {
        timestamp: "2026-07-15T08:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: "canonical-user-client",
          message: "Stable prompt",
          images: [],
          local_images: [],
          text_elements: []
        }
      },
      {
        timestamp: "2026-07-15T08:00:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Stable result" }
      }
    ];
    const appendedResponses = [
      {
        timestamp: "2026-07-15T08:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Stable prompt" }]
        }
      },
      {
        timestamp: "2026-07-15T08:00:02.000Z",
        type: "response_item",
        payload: {
          id: "legacy-assistant-response",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Stable result" }]
        }
      }
    ];
    writeFileSync(path, initialRecords.map((record) => JSON.stringify(record)).join("\n"));
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });

    const beforeAppend = await connector.readFile(path);
    writeFileSync(
      path,
      [...initialRecords, ...appendedResponses]
        .map((record) => JSON.stringify(record))
        .join("\n")
    );
    const afterAppend = await connector.readFile(path);
    const legacyEventIds = [
      buildEventId({
        accountId: "account-1",
        deviceId: "mac-device",
        sourceType: "CODEX",
        sourceInstanceId: "mac-codex",
        sourceSessionId: "append-session",
        sourceMessageId: null,
        messageIndex: 0
      }),
      buildEventId({
        accountId: "account-1",
        deviceId: "mac-device",
        sourceType: "CODEX",
        sourceInstanceId: "mac-codex",
        sourceSessionId: "append-session",
        sourceMessageId: "legacy-assistant-response",
        messageIndex: 1
      })
    ];

    expect(connector.parserVersion).toBe("codex-jsonl-v4");
    expect(afterAppend.events.map((event) => event.eventId)).toEqual(
      beforeAppend.events.map((event) => event.eventId)
    );
    expect(afterAppend.events.map((event) => ({
      kind: event.kind,
      sourceMessageId: event.sourceMessageId,
      messageIndex: event.messageIndex,
      legacyEventAliases: event.metadata.legacyEventAliases
    }))).toEqual([
      {
        kind: "USER_PROMPT",
        sourceMessageId: "canonical-user-client",
        messageIndex: 1,
        legacyEventAliases: [{
          eventId: legacyEventIds[0],
          sourceSessionId: "append-session"
        }]
      },
      {
        kind: "VISIBLE_RESULT",
        sourceMessageId: "event-agent-line:3",
        messageIndex: 2,
        legacyEventAliases: [{
          eventId: legacyEventIds[1],
          sourceSessionId: "append-session"
        }]
      }
    ]);
  });

  it("uses the latest session_meta for alternating session segments", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-segments-"));
    const path = join(directory, "session.jsonl");
    const records = [
      {
        timestamp: "2026-07-15T08:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-a", cwd: join(directory, "project-a"), source_time_zone: "UTC" }
      },
      {
        timestamp: "2026-07-15T08:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: "client-a-1",
          message: "Visible prompt A1",
          images: [],
          local_images: [],
          text_elements: []
        }
      },
      {
        timestamp: "2026-07-15T08:00:02.000Z",
        type: "session_meta",
        payload: { id: "session-b", cwd: join(directory, "project-b"), source_time_zone: "UTC" }
      },
      {
        timestamp: "2026-07-15T08:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: "client-b-1",
          message: "Visible prompt B1",
          images: [],
          local_images: [],
          text_elements: []
        }
      },
      {
        timestamp: "2026-07-15T08:00:04.000Z",
        type: "session_meta",
        payload: { id: "session-a", cwd: join(directory, "project-a"), source_time_zone: "UTC" }
      },
      {
        timestamp: "2026-07-15T08:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: "client-a-2",
          message: "Visible prompt A2",
          images: [],
          local_images: [],
          text_elements: []
        }
      }
    ];
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex",
      pathHmacKey: "synthetic-path-key"
    });

    const session = await connector.readFile(path);
    const rawSession = await new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex",
      captureMode: "raw-prompts"
    }).readFile(path);

    expect(session.events.map((event) => event.sourceSessionId)).toEqual([
      "session-a",
      "session-b",
      "session-a"
    ]);
    expect(session.events.map((event) => event.projectHint?.repoRootName)).toEqual([
      "project-a",
      "project-b",
      "project-a"
    ]);
    expect(rawSession.events.map((event) => event.sourceSessionId)).toEqual([
      "session-a",
      "session-b",
      "session-a"
    ]);
    expect(rawSession.events.map((event) => event.projectHint?.repoRootName)).toEqual([
      "project-a",
      "project-b",
      "project-a"
    ]);
  });

  it("collects event_msg user and agent messages as visible conversation events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-visible-events-"));
    const path = join(directory, "session.jsonl");
    const records = [
      {
        timestamp: "2026-07-15T08:00:00.000Z",
        type: "session_meta",
        payload: { id: "visible-session", source_time_zone: "UTC" }
      },
      {
        timestamp: "2026-07-15T08:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: "visible-client",
          message: "Visible user prompt",
          images: [],
          local_images: [],
          text_elements: []
        }
      },
      {
        timestamp: "2026-07-15T08:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Visible final result",
          phase: "final_answer",
          memory_citation: "synthetic-citation-that-must-not-be-stored"
        }
      }
    ];
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });

    const session = await connector.readFile(path);

    expect(connector.parserVersion).toBe("codex-jsonl-v4");
    expect(session.events.map((event) => ({
      kind: event.kind,
      content: event.sanitizedContent,
      sourceMessageId: event.sourceMessageId,
      replyToEventId: event.replyToEventId
    }))).toEqual([
      {
        kind: "USER_PROMPT",
        content: "Visible user prompt",
        sourceMessageId: "visible-client",
        replyToEventId: undefined
      },
      {
        kind: "VISIBLE_RESULT",
        content: "Visible final result",
        sourceMessageId: "event-agent-line:3",
        replyToEventId: expect.any(String)
      }
    ]);
    expect(JSON.stringify(session.events)).not.toContain("synthetic-citation-that-must-not-be-stored");
  });

  it("keeps an image-only user prompt using a placeholder and count-only metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-image-event-"));
    const path = join(directory, "session.jsonl");
    const records = [
      {
        timestamp: "2026-07-15T08:00:00.000Z",
        type: "session_meta",
        payload: { id: "image-session", source_time_zone: "UTC" }
      },
      {
        timestamp: "2026-07-15T08:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: "image-client",
          message: "",
          images: ["synthetic-image-one", "synthetic-image-two"],
          local_images: ["synthetic-local-image"],
          text_elements: [{ text: "synthetic-text-element" }]
        }
      }
    ];
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });

    const session = await connector.readFile(path);

    expect(session.events).toHaveLength(1);
    expect(session.events[0]).toMatchObject({
      kind: "USER_PROMPT",
      sanitizedContent: "[图片输入]",
      sourceMessageId: "image-client",
      metadata: {
        sourceFormat: "codex:event:user;img=2;local=1;text=1"
      }
    });
    const serialized = JSON.stringify(session.events[0]);
    expect(serialized).not.toContain("synthetic-image-one");
    expect(serialized).not.toContain("synthetic-image-two");
    expect(serialized).not.toContain("synthetic-local-image");
    expect(serialized).not.toContain("synthetic-text-element");
  });

  it("deduplicates response_item pairs, prefers visible text, and exposes response aliases", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-visible-dedup-"));
    const path = join(directory, "session.jsonl");
    const records = [
      {
        timestamp: "2026-07-15T08:00:00.000Z",
        type: "session_meta",
        payload: { id: "dedup-session", source_time_zone: "UTC" }
      },
      {
        timestamp: "2026-07-15T08:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: "visible-client-id",
          message: "Visible prompt body",
          images: [],
          local_images: [],
          text_elements: []
        }
      },
      {
        timestamp: "2026-07-15T08:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          internal_chat_message_metadata_passthrough: { client_id: "visible-client-id" },
          content: [{
            type: "input_text",
            text: "Synthetic injected context\nVisible prompt body"
          }]
        }
      },
      {
        timestamp: "2026-07-15T08:00:02.000Z",
        type: "response_item",
        payload: {
          id: "response-assistant-id",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Visible assistant body" }]
        }
      },
      {
        timestamp: "2026-07-15T08:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Visible assistant body",
          phase: "final_answer",
          memory_citation: null
        }
      }
    ];
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });

    const session = await connector.readFile(path);
    const legacyUserEventId = buildEventId({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceType: "CODEX",
      sourceInstanceId: "mac-codex",
      sourceSessionId: "dedup-session",
      sourceMessageId: null,
      messageIndex: 0
    });
    const legacyAssistantEventId = buildEventId({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceType: "CODEX",
      sourceInstanceId: "mac-codex",
      sourceSessionId: "dedup-session",
      sourceMessageId: "response-assistant-id",
      messageIndex: 1
    });
    const expectedUserEventId = buildEventId({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceType: "CODEX",
      sourceInstanceId: "mac-codex",
      sourceSessionId: "dedup-session",
      sourceMessageId: "visible-client-id",
      messageIndex: 1
    });
    const expectedAssistantEventId = buildEventId({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceType: "CODEX",
      sourceInstanceId: "mac-codex",
      sourceSessionId: "dedup-session",
      sourceMessageId: "event-agent-line:5",
      messageIndex: 4
    });

    expect(session.events.map((event) => ({
      eventId: event.eventId,
      kind: event.kind,
      content: event.sanitizedContent,
      sourceMessageId: event.sourceMessageId,
      messageIndex: event.messageIndex,
      replyToEventId: event.replyToEventId,
      legacyEventAliases: event.metadata.legacyEventAliases
    }))).toEqual([
      {
        eventId: expectedUserEventId,
        kind: "USER_PROMPT",
        content: "Visible prompt body",
        sourceMessageId: "visible-client-id",
        messageIndex: 1,
        replyToEventId: undefined,
        legacyEventAliases: [{
          eventId: legacyUserEventId,
          sourceSessionId: "dedup-session"
        }]
      },
      {
        eventId: expectedAssistantEventId,
        kind: "VISIBLE_RESULT",
        content: "Visible assistant body",
        sourceMessageId: "event-agent-line:5",
        messageIndex: 4,
        replyToEventId: expectedUserEventId,
        legacyEventAliases: [{
          eventId: legacyAssistantEventId,
          sourceSessionId: "dedup-session"
        }]
      }
    ]);
  });

  it("normalizes Windows and macOS paths into the same Git project without retaining raw paths", async () => {
    const windows = new CodexConnector({
      accountId: "account-1",
      deviceId: "windows-device",
      sourceInstanceId: "windows-codex"
    });
    const macos = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });
    const windowsRawPrompts = new CodexConnector({
      accountId: "account-1",
      deviceId: "windows-device",
      sourceInstanceId: "windows-codex",
      captureMode: "raw-prompts"
    });

    const windowsSession = await windows.readFile(resolve(fixturesRoot, "windows/session.jsonl"));
    const macosSession = await macos.readFile(resolve(fixturesRoot, "macos/session.jsonl"));
    const windowsRawSession = await windowsRawPrompts.readFile(
      resolve(fixturesRoot, "windows/session.jsonl")
    );

    expect(windowsSession.events).toHaveLength(2);
    expect(macosSession.events).toHaveLength(2);
    expect(windowsRawSession.events).toHaveLength(1);
    expect(windowsSession.events[0]?.projectHint?.gitRemoteKey).toBe("github.com/acme/ai-worklog");
    expect(macosSession.events[0]?.projectHint?.gitRemoteKey).toBe("github.com/acme/ai-worklog");
    expect(windowsRawSession.events[0]?.projectHint?.gitRemoteKey).toBe("github.com/acme/ai-worklog");
    expect(windowsRawSession.events[0]?.projectHint?.repoRootName).toBe("ai-worklog");
    expect(windowsSession.events[0]?.projectHint?.repoRootName).toBe("ai-worklog");
    expect(macosSession.events[0]?.projectHint?.repoRootName).toBe("ai-worklog");
    expect(JSON.stringify(windowsSession)).not.toContain("C:\\\\Users\\\\demo");
    expect(JSON.stringify(macosSession)).not.toContain("/Users/demo/work");
  });

  it("redacts fixture secrets before returning events and creates stable event IDs", async () => {
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "windows-device",
      sourceInstanceId: "windows-codex"
    });
    const path = resolve(fixturesRoot, "windows/session.jsonl");

    const first = await connector.readFile(path);
    const second = await connector.readFile(path);

    expect(first.events[0]?.sanitizedContent).toContain("[REDACTED]");
    expect(first.events[0]?.sanitizedContent).not.toContain("FAKE_TEST_SECRET_CANARY_1234567890");
    expect(first.events.map((event) => event.eventId)).toEqual(
      second.events.map((event) => event.eventId)
    );
    expect(first.events.map((event) => event.messageIndex)).toEqual([0, 1]);
    expect(first.events.every((event) => /^[a-f0-9]{64}$/.test(event.contentHash))).toBe(true);
  });

  it("keeps a raw Prompt longer than the former 128 KiB cap intact", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-raw-prompt-"));
    const path = join(directory, "session.jsonl");
    const rawPrompt = "api_key=FAKE_LONG_PROMPT_CANARY\n" + "完整 Prompt ".repeat(20_000);
    writeFileSync(path, [
      {
        timestamp: "2026-07-14T08:00:00.000Z",
        type: "session_meta",
        payload: { id: "raw-prompt-session", source_time_zone: "UTC" }
      },
      {
        timestamp: "2026-07-14T08:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: "raw-prompt-message",
          message: rawPrompt,
          images: [],
          local_images: [],
          text_elements: []
        }
      }
    ].map((record) => JSON.stringify(record)).join("\n"));

    const session = await new CodexConnector({
      accountId: "account-1",
      deviceId: "windows-device",
      sourceInstanceId: "windows-codex",
      captureMode: "raw-prompts"
    }).readFile(path);

    expect(rawPrompt.length).toBeGreaterThan(131_072);
    expect(session.events).toHaveLength(1);
    expect(session.events[0]?.sanitizedContent).toBe(rawPrompt);
    expect(session.events[0]?.redactionVersion).toBe("RAW_V1");
  });

  it("preserves v1 server identities when ignored records surround messages without IDs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-v1-identity-"));
    const path = join(directory, "session.jsonl");
    const records = [
      {
        timestamp: "2026-07-14T08:00:00.000Z",
        type: "session_meta",
        payload: { id: "legacy-session", source_time_zone: "UTC" }
      },
      {
        timestamp: "2026-07-14T08:00:30.000Z",
        type: "event_msg",
        payload: { type: "token_count" }
      },
      {
        timestamp: "2026-07-14T08:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Legacy prompt" }]
        }
      },
      {
        timestamp: "2026-07-14T08:01:30.000Z",
        type: "event_msg",
        payload: { type: "token_count" }
      },
      {
        timestamp: "2026-07-14T08:02:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Legacy result" }]
        }
      }
    ];
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });

    const session = await connector.readFile(path);
    const legacyEventIds = [0, 1].map((messageIndex) => buildEventId({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceType: "CODEX",
      sourceInstanceId: "mac-codex",
      sourceSessionId: "legacy-session",
      sourceMessageId: null,
      messageIndex
    }));

    expect(session.events.map((event) => ({
      eventId: event.eventId,
      kind: event.kind,
      sourceSessionId: event.sourceSessionId,
      sourceMessageId: event.sourceMessageId,
      messageIndex: event.messageIndex,
      replyToEventId: event.replyToEventId
    }))).toEqual([
      {
        eventId: legacyEventIds[0],
        kind: "USER_PROMPT",
        sourceSessionId: "legacy-session",
        sourceMessageId: null,
        messageIndex: 0,
        replyToEventId: undefined
      },
      {
        eventId: legacyEventIds[1],
        kind: "VISIBLE_RESULT",
        sourceSessionId: "legacy-session",
        sourceMessageId: null,
        messageIndex: 1,
        replyToEventId: legacyEventIds[0]
      }
    ]);
  });

  it("streams session files larger than the former 10 MiB limit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-stream-"));
    const path = join(directory, "large.jsonl");
    const ignored = JSON.stringify({
      timestamp: "2026-07-14T08:00:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(120_000) }
    });
    const records = [
      JSON.stringify({
        timestamp: "2026-07-14T08:00:00.000Z",
        type: "session_meta",
        payload: { id: "large-session", cwd: "/work/large", source_time_zone: "UTC" }
      }),
      ...Array.from({ length: 90 }, () => ignored),
      JSON.stringify({
        timestamp: "2026-07-14T08:01:00.000Z",
        type: "response_item",
        payload: {
          id: "message-1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Summarize this session" }]
        }
      })
    ];
    writeFileSync(path, records.join("\n"));
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });

    const session = await connector.readFile(path);

    expect(session.events).toHaveLength(1);
    expect(session.events[0]?.sanitizedContent).toBe("Summarize this session");
  });
});
