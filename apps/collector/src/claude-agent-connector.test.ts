import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAgentConnector } from "./claude-agent-connector.js";

describe("ClaudeCodeAgentConnector", () => {
  it("keeps thinking, tools, attachments, unknown blocks and sidechains in deterministic order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-agent-"));
    const attachment = join(directory, "diagram.png");
    writeFileSync(attachment, "fake image bytes");
    const path = join(directory, "session.jsonl");
    const rows = [
      {
        cwd: directory,
        sessionId: "claude-session",
        timestamp: "2026-08-21T00:00:00.000Z",
        type: "assistant",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "exposed thinking" },
            { type: "text", text: "visible answer" },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: attachment } },
            { type: "future_block", value: "unknown block" }
          ]
        }
      },
      {
        cwd: directory,
        sessionId: "claude-session",
        timestamp: "2026-08-21T00:00:01.000Z",
        type: "user",
        uuid: "result-1",
        isSidechain: true,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "full result" }] }
      }
    ];
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));

    const [capture] = await new ClaudeCodeAgentConnector({
      accountId: "account-1",
      deviceId: "device-1",
      sourceInstanceId: "claude-device-1"
    }).readSource(path);
    const events = capture?.records.filter((record) => record.recordType === "EVENT") ?? [];

    expect(events.map((event) => event.recordType === "EVENT" ? event.kind : ""))
      .toEqual(expect.arrayContaining([
        "ASSISTANT", "REASONING", "TOOL_CALL", "TOOL_RESULT", "SOURCE_EVENT"
      ]));
    expect(JSON.stringify(capture)).toContain("exposed thinking");
    expect(JSON.stringify(capture)).toContain("full result");
    expect(events.some((event) => event.recordType === "EVENT" &&
      event.metadata.isSidechain === true)).toBe(true);
    expect(capture?.attachmentRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestedPath: attachment })
    ]));
    const sequences = events.map((event) => event.recordType === "EVENT" ? event.sequence : -1);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
  });
});
