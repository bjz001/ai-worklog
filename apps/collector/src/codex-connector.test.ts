import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildEventId } from "@ai-worklog/core";
import { CodexConnector } from "./codex-connector.js";

const fixturesRoot = fileURLToPath(new URL("../../../fixtures/codex/", import.meta.url));

describe("CodexConnector", () => {
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

    const windowsSession = await windows.readFile(resolve(fixturesRoot, "windows/session.jsonl"));
    const macosSession = await macos.readFile(resolve(fixturesRoot, "macos/session.jsonl"));

    expect(windowsSession.events).toHaveLength(2);
    expect(macosSession.events).toHaveLength(2);
    expect(windowsSession.events[0]?.projectHint?.gitRemoteKey).toBe("github.com/acme/ai-worklog");
    expect(macosSession.events[0]?.projectHint?.gitRemoteKey).toBe("github.com/acme/ai-worklog");
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
