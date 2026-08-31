#!/usr/bin/env node
/* global process */
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open
} from "node:fs/promises";
import { join, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function safeSegment(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

try {
  const input = JSON.parse(raw);
  if (
    input?.hook_event_name !== "UserPromptSubmit" ||
    typeof input.prompt !== "string" ||
    input.prompt.length === 0
  ) {
    process.exit(0);
  }
  const spoolRoot = resolve(
    argument("--spool") ||
    process.env.AI_WORKLOG_ZCODE_SPOOL ||
    process.env.ZCODE_PLUGIN_DATA ||
    "."
  );
  const sessionId = String(input.session_id || input.sessionId || "unknown-session");
  const sessionRoot = join(spoolRoot, safeSegment(sessionId));
  await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
  await chmod(spoolRoot, 0o700);
  await chmod(sessionRoot, 0o700);
  const hookInput = {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt: input.prompt
  };
  const row = JSON.stringify({
    capturedAt: new Date().toISOString(),
    hookInput
  }) + "\n";
  const eventLog = await open(join(sessionRoot, "events.jsonl"), "a", 0o600);
  try {
    await eventLog.write(row);
    await eventLog.sync();
  } finally {
    await eventLog.close();
  }
} catch (error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "CAPTURE_FAILED";
  process.stderr.write(`[ai-worklog-zcode-hook] ${code}\n`);
  process.exitCode = 1;
}
