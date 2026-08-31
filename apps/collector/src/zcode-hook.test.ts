import {
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installZcodeHook } from "./zcode-hook-installer.js";
import { ZCodeAgentConnector } from "./zcode-agent-connector.js";

describe("ZCode Hook integration", () => {
  it("backs up and leaves only the user-prompt hook idempotently", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zcode-hook-"));
    const configPath = join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify({
      theme: "dark",
      hooks: {
        enabled: false,
        events: {
          PreToolUse: [{ matcher: "Write", hooks: [{ type: "process", command: "custom", args: [] }] }]
        }
      }
    }));
    const first = await installZcodeHook({
      configPath,
      spoolPath: join(directory, "spool"),
      hookScriptPath: "/opt/ai-worklog/zcode-capture-hook.mjs",
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    const afterFirst = readFileSync(configPath, "utf8");
    const second = await installZcodeHook({
      configPath,
      spoolPath: join(directory, "spool"),
      hookScriptPath: "/opt/ai-worklog/zcode-capture-hook.mjs",
      now: () => new Date("2026-08-21T00:01:00.000Z")
    });
    const parsed = JSON.parse(afterFirst) as {
      theme: string;
      hooks: { enabled: boolean; events: Record<string, unknown[]> };
    };

    expect(first.changed).toBe(true);
    expect(first.backupPath).toContain("20260821T000000000Z");
    expect(second).toMatchObject({ changed: false, backupPath: null });
    expect(readFileSync(configPath, "utf8")).toBe(afterFirst);
    expect(parsed.theme).toBe("dark");
    expect(parsed.hooks.enabled).toBe(true);
    expect(Object.keys(parsed.hooks.events).sort()).toEqual([
      "PreToolUse",
      "UserPromptSubmit"
    ]);
    expect(JSON.stringify(parsed)).toContain("custom");
  });

  it("persists only the complete UserPromptSubmit payload", () => {
    const directory = mkdtempSync(join(tmpdir(), "zcode-hook-script-"));
    const spool = join(directory, "spool");
    const script = join(process.cwd(), "apps/collector/scripts/zcode-capture-hook.mjs");
    execFileSync(process.execPath, [script, "--spool", spool], {
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "z-session",
        cwd: directory,
        prompt: "api_key=FAKE_ZCODE_RAW_PROMPT"
      }),
      encoding: "utf8"
    });
    const sessionDirectory = createHash("sha256")
      .update("z-session")
      .digest("hex")
      .slice(0, 32);
    const row = JSON.parse(readFileSync(join(spool, sessionDirectory, "events.jsonl"), "utf8"));

    expect(row).toMatchObject({
      hookInput: {
        hook_event_name: "UserPromptSubmit",
        session_id: "z-session",
        prompt: "api_key=FAKE_ZCODE_RAW_PROMPT"
      }
    });
    expect(row.hookInput).not.toHaveProperty("cwd");
    expect(JSON.stringify(row)).not.toContain("transcript");
  });

  it("normalizes hook events and the persisted temporary transcript", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zcode-spool-"));
    const transcript = join(directory, "persisted-transcript.jsonl");
    writeFileSync(transcript, [
      { sessionId: "z-session", uuid: "u1", timestamp: "2026-08-21T00:00:01.000Z", type: "user", message: { role: "user", content: "full transcript prompt" } },
      { sessionId: "z-session", uuid: "a1", timestamp: "2026-08-21T00:00:02.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "exposed zcode reasoning" }, { type: "text", text: "full assistant result" }] } }
    ].map((row) => JSON.stringify(row)).join("\n"));
    const spool = join(directory, "events.jsonl");
    const hooks = [
      { hook_event_name: "SessionStart", session_id: "z-session", cwd: directory, source: "startup" },
      { hook_event_name: "UserPromptSubmit", session_id: "z-session", cwd: directory, prompt: "api_key=FAKE_ZCODE_KEEP" },
      { hook_event_name: "PreToolUse", session_id: "z-session", cwd: directory, tool_name: "Read", tool_use_id: "tool-1", tool_input: { file_path: transcript } },
      { hook_event_name: "PostToolUse", session_id: "z-session", cwd: directory, tool_name: "Read", tool_use_id: "tool-1", tool_response: "complete output" },
      { hook_event_name: "Stop", session_id: "z-session", cwd: directory, last_assistant_message: "final answer" }
    ];
    writeFileSync(spool, hooks.map((hook, index) => JSON.stringify({
      capturedAt: `2026-08-21T00:00:0${index}.000Z`,
      hookInput: hook,
      rawHookInput: JSON.stringify(hook),
      persistedTranscriptPath: transcript
    })).join("\n"));
    const [capture] = await new ZCodeAgentConnector({
      accountId: "account-1",
      deviceId: "device-1",
      sourceInstanceId: "zcode-device-1"
    }).readSource(spool);
    const kinds = capture?.records.flatMap((record) =>
      record.recordType === "EVENT" ? [record.kind] : []
    );
    const serialized = JSON.stringify(capture);

    expect(kinds).toEqual(expect.arrayContaining([
      "STATE", "USER", "TOOL_CALL", "TOOL_RESULT", "ASSISTANT", "REASONING"
    ]));
    expect(serialized).toContain("FAKE_ZCODE_KEEP");
    expect(serialized).toContain("exposed zcode reasoning");
    expect(serialized).toContain("full assistant result");
    expect(serialized).not.toContain("[REDACTED]");
    expect(capture?.attachmentRequests.some((request) =>
      request.requestedPath === transcript && request.purpose === "SOURCE_TRANSCRIPT"
    )).toBe(true);
  });
});
