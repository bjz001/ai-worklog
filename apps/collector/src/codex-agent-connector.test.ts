import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAgentConnector } from "./codex-agent-connector.js";

describe("CodexAgentConnector", () => {
  it("captures every exposed raw event and normalized Agent-loop kind without redaction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-agent-"));
    const path = join(directory, "session.jsonl");
    const records = [
      { timestamp: "2026-08-21T00:00:00.000Z", type: "session_meta", payload: { id: "codex-session", cwd: directory, source_time_zone: "UTC" } },
      { timestamp: "2026-08-21T00:00:01.000Z", type: "turn_context", payload: { system_prompt: "SYSTEM FULL", tools: [{ name: "bash" }] } },
      { timestamp: "2026-08-21T00:00:02.000Z", type: "response_item", payload: { id: "u1", type: "message", role: "user", content: [{ type: "input_text", text: "api_key=FAKE_SECRET_KEEP" }] } },
      { timestamp: "2026-08-21T00:00:03.000Z", type: "response_item", payload: { id: "r1", type: "reasoning", summary: [{ type: "summary_text", text: "source-exposed reasoning" }] } },
      { timestamp: "2026-08-21T00:00:04.000Z", type: "response_item", payload: { call_id: "shared-tool-call", type: "function_call", name: "bash", arguments: JSON.stringify({ command: `cat '${join(directory, "result.txt")}'` }) } },
      { timestamp: "2026-08-21T00:00:05.000Z", type: "response_item", payload: { call_id: "shared-tool-call", type: "function_call_output", output: "complete tool output" } },
      { timestamp: "2026-08-21T00:00:06.000Z", type: "future_record", payload: { future: "preserve unknown" } }
    ];
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    writeFileSync(join(directory, "result.txt"), "attachment content");
    const connector = new CodexAgentConnector({
      accountId: "account-1",
      deviceId: "device-1",
      sourceInstanceId: "codex-device-1"
    });

    const [capture] = await connector.readSource(path);
    const events = capture?.records.filter((record) => record.recordType === "EVENT") ?? [];
    const kinds = events.map((event) => event.recordType === "EVENT" ? event.kind : "");
    const serialized = JSON.stringify(capture);

    expect(kinds).toEqual(expect.arrayContaining([
      "STATE", "CONTEXT", "USER", "REASONING", "TOOL_CALL", "TOOL_RESULT", "SOURCE_EVENT"
    ]));
    expect(events).toHaveLength(records.length);
    expect(serialized).toContain("FAKE_SECRET_KEEP");
    expect(serialized).toContain("preserve unknown");
    expect(serialized).not.toContain("[REDACTED]");
    expect(capture?.attachmentRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestedPath: path, purpose: "SOURCE_TRANSCRIPT" }),
      expect.objectContaining({ requestedPath: join(directory, "result.txt") })
    ]));
  });

  it("stores source ciphertext but marks encrypted-only reasoning unreadable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-agent-"));
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
      { timestamp: "2026-08-21T00:00:00.000Z", type: "session_meta", payload: { id: "encrypted-session" } },
      { timestamp: "2026-08-21T00:00:01.000Z", type: "response_item", payload: { id: "reasoning-1", type: "reasoning", encrypted_content: "BASE64_CIPHERTEXT" } }
    ].map((record) => JSON.stringify(record)).join("\n"));
    const [capture] = await new CodexAgentConnector({
      accountId: "account-1",
      deviceId: "device-1",
      sourceInstanceId: "codex-device-1"
    }).readSource(path);
    const reasoning = capture?.records.find((record) =>
      record.recordType === "EVENT" && record.kind === "REASONING"
    );

    expect(reasoning).toMatchObject({
      rawCaptureStatus: "UNREADABLE",
      normalizedCoverage: "NONE"
    });
    expect(JSON.stringify(capture)).toContain("BASE64_CIPHERTEXT");
  });

  it("folds only adjacent cross-envelope mirrors, not later repeated prompts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-agent-"));
    const path = join(directory, "session.jsonl");
    writeFileSync(path, [
      { timestamp: "2026-08-21T00:00:00.000Z", type: "session_meta", payload: { id: "mirror-session" } },
      { timestamp: "2026-08-21T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "repeat me" } },
      { timestamp: "2026-08-21T00:00:02.000Z", type: "response_item", payload: { id: "u1", type: "message", role: "user", content: [{ type: "input_text", text: "repeat me" }] } },
      { timestamp: "2026-08-21T00:00:03.000Z", type: "turn_context", payload: { turn: 2 } },
      { timestamp: "2026-08-21T00:00:04.000Z", type: "turn_context", payload: { turn: 2, phase: 2 } },
      { timestamp: "2026-08-21T00:00:05.000Z", type: "event_msg", payload: { type: "user_message", message: "repeat me" } }
    ].map((record) => JSON.stringify(record)).join("\n"));
    const [capture] = await new CodexAgentConnector({
      accountId: "account-1",
      deviceId: "device-1",
      sourceInstanceId: "codex-device-1"
    }).readSource(path);
    const users = capture?.records.filter((record) =>
      record.recordType === "EVENT" && record.kind === "USER"
    ) ?? [];

    expect(users).toHaveLength(3);
    expect(users[0]?.recordType === "EVENT" && users[0].mirrorOfEventId).toBeNull();
    expect(users[1]?.recordType === "EVENT" && users[1].mirrorOfEventId).toBe(
      users[0]?.recordType === "EVENT" ? users[0].eventId : null
    );
    expect(users[2]?.recordType === "EVENT" && users[2].mirrorOfEventId).toBeNull();
  });
});
