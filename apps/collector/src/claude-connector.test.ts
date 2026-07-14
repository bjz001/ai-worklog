import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEventId } from "@ai-worklog/core";
import { ClaudeCodeConnector } from "./claude-connector.js";

const fixturesRoot = fileURLToPath(new URL("../../../fixtures/claude/", import.meta.url));

describe("ClaudeCodeConnector", () => {
  it("normalizes common Claude Code records into prompts and visible results", async () => {
    const connector = new ClaudeCodeConnector({
      accountId: "account-1",
      deviceId: "windows-device",
      sourceInstanceId: "windows-claude"
    });

    const session = await connector.readFile(resolve(fixturesRoot, "windows/session.jsonl"));

    expect(session.events).toHaveLength(2);
    expect(session.events.map((event) => event.kind)).toEqual([
      "USER_PROMPT",
      "VISIBLE_RESULT"
    ]);
    expect(session.events[1]?.replyToEventId).toBe(session.events[0]?.eventId);
    expect(session.events.some((event) => event.sanitizedContent.includes("tool output"))).toBe(false);
    expect(session.events.some((event) => event.sanitizedContent.includes("chain of thought"))).toBe(false);
    expect(session.events.some((event) => event.sanitizedContent.includes("sidechain"))).toBe(false);
    expect(session.events[0]?.metadata).toEqual({ gitBranch: "feature/windows-sync" });
  });

  it("groups Windows and macOS paths by Git Remote without retaining raw paths", async () => {
    const windows = new ClaudeCodeConnector({
      accountId: "account-1",
      deviceId: "windows-device",
      sourceInstanceId: "windows-claude"
    });
    const macos = new ClaudeCodeConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-claude"
    });

    const windowsSession = await windows.readFile(resolve(fixturesRoot, "windows/session.jsonl"));
    const macosSession = await macos.readFile(resolve(fixturesRoot, "macos/session.jsonl"));

    expect(windowsSession.events[0]?.projectHint?.gitRemoteKey).toBe("github.com/acme/ai-worklog");
    expect(macosSession.events[0]?.projectHint?.gitRemoteKey).toBe("github.com/acme/ai-worklog");
    expect(windowsSession.events[0]?.projectHint?.localPathHmac).toMatch(/^[a-f0-9]{64}$/u);
    expect(macosSession.events[0]?.projectHint?.localPathHmac).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(windowsSession)).not.toContain("C:\\\\Users\\\\demo");
    expect(JSON.stringify(macosSession)).not.toContain("/Users/demo/work");
  });

  it("redacts secrets and creates stable event identities", async () => {
    const connector = new ClaudeCodeConnector({
      accountId: "account-1",
      deviceId: "windows-device",
      sourceInstanceId: "windows-claude"
    });
    const path = resolve(fixturesRoot, "windows/session.jsonl");

    const first = await connector.readFile(path);
    const second = await connector.readFile(path);

    expect(first.events[0]?.sanitizedContent).toContain("[REDACTED]");
    expect(first.events[0]?.sanitizedContent).not.toContain("FAKE_CLAUDE_SECRET_CANARY_1234567890");
    expect(first.events.map((event) => event.eventId)).toEqual(
      second.events.map((event) => event.eventId)
    );
    expect(first.events.every((event) => /^[a-f0-9]{64}$/u.test(event.contentHash))).toBe(true);
  });

  it("preserves v1 server identities when ignored records surround messages without IDs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-v1-identity-"));
    const path = join(directory, "session.jsonl");
    const records = [
      {
        sessionId: "legacy-claude-session",
        sourceTimeZone: "UTC",
        type: "progress",
        timestamp: "2026-07-14T08:00:00.000Z"
      },
      {
        sessionId: "legacy-claude-session",
        sourceTimeZone: "UTC",
        type: "user",
        timestamp: "2026-07-14T08:01:00.000Z",
        message: { role: "user", content: "Legacy Claude prompt" }
      },
      {
        sessionId: "legacy-claude-session",
        sourceTimeZone: "UTC",
        type: "user",
        timestamp: "2026-07-14T08:01:30.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "ignored" }]
        }
      },
      {
        sessionId: "legacy-claude-session",
        sourceTimeZone: "UTC",
        type: "assistant",
        timestamp: "2026-07-14T08:02:00.000Z",
        message: { role: "assistant", content: "Legacy Claude result" }
      }
    ];
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));
    const connector = new ClaudeCodeConnector({
      accountId: "account-1",
      deviceId: "windows-device",
      sourceInstanceId: "windows-claude"
    });

    const session = await connector.readFile(path);
    const legacyEventIds = [0, 1].map((messageIndex) => buildEventId({
      accountId: "account-1",
      deviceId: "windows-device",
      sourceType: "CLAUDE_CODE",
      sourceInstanceId: "windows-claude",
      sourceSessionId: "legacy-claude-session",
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
        sourceSessionId: "legacy-claude-session",
        sourceMessageId: null,
        messageIndex: 0,
        replyToEventId: undefined
      },
      {
        eventId: legacyEventIds[1],
        kind: "VISIBLE_RESULT",
        sourceSessionId: "legacy-claude-session",
        sourceMessageId: null,
        messageIndex: 1,
        replyToEventId: legacyEventIds[0]
      }
    ]);
  });
});
