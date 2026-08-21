#!/usr/bin/env node
/* global process */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  stat
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
  const spoolRoot = resolve(
    argument("--spool") ||
    process.env.AI_WORKLOG_ZCODE_SPOOL ||
    process.env.ZCODE_PLUGIN_DATA ||
    "."
  );
  const sessionId = String(input.session_id || input.sessionId || "unknown-session");
  const sessionRoot = join(spoolRoot, safeSegment(sessionId));
  const transcriptRoot = join(sessionRoot, "transcripts");
  await mkdir(transcriptRoot, { recursive: true, mode: 0o700 });
  await chmod(spoolRoot, 0o700);
  await chmod(sessionRoot, 0o700);
  await chmod(transcriptRoot, 0o700);

  let persistedTranscriptPath = null;
  let transcriptCaptureStatus = "NOT_PROVIDED";
  let transcriptCaptureError = null;
  const temporaryTranscript = input.transcript_path || input.transcriptPath;
  if (typeof temporaryTranscript === "string" && temporaryTranscript) {
    try {
      const info = await stat(temporaryTranscript);
      if (info.isFile()) {
        const suffix = createHash("sha256")
          .update(`${Date.now()}\u001f${randomUUID()}\u001f${temporaryTranscript}\u001f${info.size}`)
          .digest("hex");
        persistedTranscriptPath = join(transcriptRoot, `${suffix}.jsonl`);
        await copyFile(temporaryTranscript, persistedTranscriptPath, constants.COPYFILE_EXCL);
        await chmod(persistedTranscriptPath, 0o600);
        transcriptCaptureStatus = "CAPTURED";
      } else {
        transcriptCaptureStatus = "NOT_REGULAR";
      }
    } catch (error) {
      transcriptCaptureStatus = "READ_ERROR";
      transcriptCaptureError = error && typeof error === "object" && "code" in error
        ? String(error.code).slice(0, 64)
        : "IO_ERROR";
    }
  }
  const row = JSON.stringify({
    capturedAt: new Date().toISOString(),
    hookInput: input,
    rawHookInput: raw.replace(/\r?\n$/u, ""),
    persistedTranscriptPath,
    transcriptCaptureStatus,
    transcriptCaptureError
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
