import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
    expect(first.events.every((event) => /^[a-f0-9]{64}$/.test(event.contentHash))).toBe(true);
  });
});
