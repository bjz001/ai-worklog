import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexConnector } from "./codex-connector.js";
import { Outbox } from "./outbox.js";
import { prepareFile } from "./prepare.js";
import { discoverCodexFiles } from "./source-files.js";
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
    const connector = new CodexConnector({
      accountId: requiredEnv(env, "AI_WORKLOG_ACCOUNT_ID"),
      deviceId: requiredEnv(env, "AI_WORKLOG_DEVICE_ID"),
      sourceInstanceId: requiredEnv(env, "CODEX_SOURCE_INSTANCE_ID"),
      pathHmacKey: env.AI_WORKLOG_PATH_HMAC_KEY
    });
    const files = await discoverCodexFiles(requiredEnv(env, "CODEX_SOURCE_PATH"));
    let inserted = 0;
    let events = 0;
    for (const filePath of files) {
      const result = await prepareFile({ connector, outbox, filePath });
      inserted += result.insertedCount;
      events += result.eventCount;
    }
    write(JSON.stringify({ command: "prepare", scanned: files.length, inserted, events }));
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
    const result = await syncPending({
      outbox,
      endpoint: requiredEnv(env, "AI_WORKLOG_SYNC_URL"),
      token: requiredEnv(env, "AI_WORKLOG_DEVICE_TOKEN")
    });
    write(JSON.stringify({ command: "sync", ...result }));
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
