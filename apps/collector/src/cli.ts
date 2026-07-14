import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeConnector } from "./claude-connector.js";
import { CodexConnector } from "./codex-connector.js";
import { Outbox } from "./outbox.js";
import { prepareFile } from "./prepare.js";
import type { PromptConnector, PromptSourceType } from "./prompt-connector.js";
import { discoverPromptFiles } from "./source-files.js";
import { syncPending } from "./sync-client.js";

export const COMMANDS = ["prepare", "sync", "status", "run-fixtures"] as const;
export type CollectorCommand = typeof COMMANDS[number];

interface CliOptions {
  env?: Record<string, string | undefined>;
  write?: (line: string) => void;
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  if (value.length > 4_096) throw new Error(`Environment variable is too long: ${name}`);
  return value;
}

function databasePath(env: Record<string, string | undefined>): string {
  return env.COLLECTOR_DB_PATH?.trim()
    || join(homedir(), ".ai-worklog", "collector.sqlite");
}

function configuredSourceType(env: Record<string, string | undefined>): PromptSourceType {
  const value = env.AI_WORKLOG_SOURCE_TYPE?.trim().toUpperCase() || "CODEX";
  if (value === "CODEX" || value === "CLAUDE_CODE") return value;
  throw new Error("Unsupported AI_WORKLOG_SOURCE_TYPE; expected CODEX or CLAUDE_CODE");
}

function createConfiguredConnector(
  env: Record<string, string | undefined>
): { connector: PromptConnector; sourcePath: string; sourceLabel: string } {
  const sourceType = configuredSourceType(env);
  const shared = {
    accountId: requiredEnv(env, "AI_WORKLOG_ACCOUNT_ID"),
    deviceId: requiredEnv(env, "AI_WORKLOG_DEVICE_ID"),
    pathHmacKey: env.AI_WORKLOG_PATH_HMAC_KEY
  };

  if (sourceType === "CLAUDE_CODE") {
    return {
      connector: new ClaudeCodeConnector({
        ...shared,
        sourceInstanceId: requiredEnv(env, "CLAUDE_CODE_SOURCE_INSTANCE_ID")
      }),
      sourcePath: requiredEnv(env, "CLAUDE_CODE_SOURCE_PATH"),
      sourceLabel: "Claude Code"
    };
  }

  return {
    connector: new CodexConnector({
      ...shared,
      sourceInstanceId: requiredEnv(env, "CODEX_SOURCE_INSTANCE_ID")
    }),
    sourcePath: requiredEnv(env, "CODEX_SOURCE_PATH"),
    sourceLabel: "Codex"
  };
}

export function parseCommand(argv: string[]): { command: CollectorCommand } {
  const command = argv[0];
  if (COMMANDS.includes(command as CollectorCommand)) {
    return { command: command as CollectorCommand };
  }
  const safeCommand = command && /^[a-z-]{1,32}$/u.test(command) ? command : "(invalid)";
  throw new Error(`Unknown command: ${safeCommand}`);
}

async function runPrepare(
  env: Record<string, string | undefined>,
  write: (line: string) => void
): Promise<void> {
  const outbox = new Outbox(databasePath(env));
  try {
    const { connector, sourcePath, sourceLabel } = createConfiguredConnector(env);
    const files = await discoverPromptFiles(sourcePath, sourceLabel);
    let inserted = 0;
    let events = 0;
    let skippedFiles = 0;
    let failedFiles = 0;
    for (const filePath of files) {
      try {
        const result = await prepareFile({ connector, outbox, filePath });
        inserted += result.insertedCount;
        events += result.eventCount;
        if (result.eventCount === 0) skippedFiles += 1;
      } catch {
        failedFiles += 1;
      }
    }
    write(JSON.stringify({
      command: "prepare",
      sourceType: connector.sourceType,
      scanned: files.length,
      inserted,
      events,
      skippedFiles,
      failedFiles
    }));
    if (failedFiles > 0) throw new Error("PREPARE_PARTIAL");
  } finally {
    outbox.close();
  }
}

async function runSync(
  env: Record<string, string | undefined>,
  write: (line: string) => void
): Promise<void> {
  const outbox = new Outbox(databasePath(env));
  try {
    const endpoint = requiredEnv(env, "AI_WORKLOG_SYNC_URL");
    const token = requiredEnv(env, "AI_WORKLOG_DEVICE_TOKEN");
    const result = { attempted: 0, acked: 0, failed: 0 };

    // Drain bounded pages so a normal backlog is cleared in one scheduled run.
    // Stop after the first failed page to preserve Outbox retry semantics without
    // immediately hammering an unavailable server.
    for (let page = 0; page < 10; page += 1) {
      const pageResult = await syncPending({
        outbox,
        endpoint,
        token,
        limit: 100
      });
      result.attempted += pageResult.attempted;
      result.acked += pageResult.acked;
      result.failed += pageResult.failed;
      if (pageResult.failed > 0 || pageResult.attempted === 0) break;
    }

    const remainingPending = outbox.status().pending;
    write(JSON.stringify({ command: "sync", ...result, remainingPending }));
    if (result.failed > 0 || remainingPending > 0) {
      throw new Error("SYNC_INCOMPLETE");
    }
  } finally {
    outbox.close();
  }
}

async function runStatus(
  env: Record<string, string | undefined>,
  write: (line: string) => void
): Promise<void> {
  const outbox = new Outbox(databasePath(env));
  try {
    write(JSON.stringify({ command: "status", ...outbox.status() }));
  } finally {
    outbox.close();
  }
}

async function runFixtures(
  env: Record<string, string | undefined>,
  write: (line: string) => void
): Promise<void> {
  const outbox = new Outbox(databasePath(env));
  const fixturesRoot = env.COLLECTOR_FIXTURES_ROOT?.trim()
    || fileURLToPath(new URL("../../../fixtures/codex/", import.meta.url));
  const accountId = env.AI_WORKLOG_ACCOUNT_ID?.trim() || "fixture-account";
  const fixtureInputs = [
    { platform: "windows", deviceId: "fixture-windows", sourceInstanceId: "fixture-windows-codex" },
    { platform: "macos", deviceId: "fixture-macos", sourceInstanceId: "fixture-macos-codex" }
  ] as const;

  try {
    let inserted = 0;
    let events = 0;
    for (const fixture of fixtureInputs) {
      const connector = new CodexConnector({
        accountId,
        deviceId: fixture.deviceId,
        sourceInstanceId: fixture.sourceInstanceId,
        pathHmacKey: env.AI_WORKLOG_PATH_HMAC_KEY || "fixture-path-hmac-key"
      });
      const result = await prepareFile({
        connector,
        outbox,
        filePath: resolve(fixturesRoot, fixture.platform, "session.jsonl")
      });
      inserted += result.insertedCount;
      events += result.eventCount;
    }
    write(JSON.stringify({
      command: "run-fixtures",
      prepared: fixtureInputs.length,
      inserted,
      events
    }));
  } finally {
    outbox.close();
  }
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const { command } = parseCommand(argv);
  if (command === "prepare") return runPrepare(env, write);
  if (command === "sync") return runSync(env, write);
  if (command === "status") return runStatus(env, write);
  return runFixtures(env, write);
}
