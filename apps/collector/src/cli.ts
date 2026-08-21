import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSourceType } from "@ai-worklog/contracts";
import { prepareAgentCapture } from "./agent-prepare.js";
import {
  collectorBlobRoot,
  createAgentConnectorRegistry,
  parseAgentSourceSelection
} from "./agent-source-registry.js";
import { stageCaptureAttachments } from "./attachment-capture.js";
import { syncPendingBlobs } from "./blob-sync-client.js";
import { ClaudeCodeConnector } from "./claude-connector.js";
import { CodexConnector } from "./codex-connector.js";
import { Outbox } from "./outbox.js";
import { prepareFile } from "./prepare.js";
import type { PromptConnector, PromptSourceType } from "./prompt-connector.js";
import { discoverPromptFiles } from "./source-files.js";
import { syncPending } from "./sync-client.js";
import { installZcodeHook } from "./zcode-hook-installer.js";

export const COMMANDS = [
  "prepare",
  "sync",
  "status",
  "run-fixtures",
  "install-zcode-hook"
] as const;
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

function allowInsecureLanHttp(env: Record<string, string | undefined>): boolean {
  const value = env.AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP?.trim().toLowerCase() ?? "";
  if (value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error("AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP must be true or false");
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

export function parseCommand(argv: string[]): {
  command: CollectorCommand;
  source?: AgentSourceType;
  forceHistory: boolean;
} {
  const command = argv[0];
  if (!COMMANDS.includes(command as CollectorCommand)) {
    const safeCommand = command && /^[a-z-]{1,32}$/u.test(command) ? command : "(invalid)";
    throw new Error(`Unknown command: ${safeCommand}`);
  }
  let source: AgentSourceType | undefined;
  let forceHistory = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force-history") {
      forceHistory = true;
      continue;
    }
    if (argument === "--source") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing --source value");
      source = parseAgentSourceSelection(value);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--source=")) {
      source = parseAgentSourceSelection(argument.slice("--source=".length));
      continue;
    }
    throw new Error("Unknown collector option");
  }
  if ((source || forceHistory) && command !== "prepare") {
    throw new Error("Source and history options are valid only for prepare");
  }
  return {
    command: command as CollectorCommand,
    ...(source ? { source } : {}),
    forceHistory
  };
}

async function runPrepareV1(
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
      status: failedFiles > 0 ? "partial" : "complete",
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

function protocolVersion(env: Record<string, string | undefined>): 1 | 2 {
  const value = env.AI_WORKLOG_PROTOCOL_VERSION?.trim() || "2";
  if (value === "1") return 1;
  if (value === "2") return 2;
  throw new Error("AI_WORKLOG_PROTOCOL_VERSION must be 1 or 2");
}

function captureCwd(
  records: readonly { recordType: string; cwd?: string | null }[],
  candidatePath: string
): string {
  const run = records.find((record) => record.recordType === "RUN");
  return run?.cwd || dirname(candidatePath);
}

async function runPrepareV2(
  env: Record<string, string | undefined>,
  write: (line: string) => void,
  selectedSource: AgentSourceType | undefined,
  forceHistory: boolean
): Promise<void> {
  const outboxPath = databasePath(env);
  const outbox = new Outbox(outboxPath);
  try {
    const accountId = requiredEnv(env, "AI_WORKLOG_ACCOUNT_ID");
    const deviceId = requiredEnv(env, "AI_WORKLOG_DEVICE_ID");
    const selected = selectedSource ?? (env.AI_WORKLOG_SOURCE_TYPE
      ? parseAgentSourceSelection(env.AI_WORKLOG_SOURCE_TYPE)
      : undefined);
    const registry = await createAgentConnectorRegistry({
      env,
      accountId,
      deviceId,
      ...(selected ? { selectedSource: selected } : {})
    });
    const blobRoot = collectorBlobRoot(env, outboxPath);
    let scanned = 0;
    let inserted = 0;
    let events = 0;
    let records = 0;
    let skippedFiles = 0;
    let failedFiles = 0;
    const sourceTypes: AgentSourceType[] = [];
    for (const entry of registry) {
      sourceTypes.push(entry.connector.sourceType);
      for (const candidate of entry.candidates) {
        scanned += 1;
        if (
          !forceHistory &&
          !outbox.sourceNeedsPrepare(
            entry.connector.sourceType,
            candidate.path,
            candidate.fingerprint
          )
        ) {
          skippedFiles += 1;
          continue;
        }
        try {
          const captures = await entry.connector.readSource(candidate.path);
          if (captures.length === 0) skippedFiles += 1;
          for (const capture of captures) {
            const staged = await stageCaptureAttachments({
              capture,
              outbox,
              blobRoot,
              cwd: captureCwd(capture.records, candidate.path)
            });
            const result = prepareAgentCapture({ capture: staged, outbox });
            inserted += result.insertedCount;
            events += result.eventCount;
            records += result.recordCount;
          }
          outbox.markSourcePrepared(
            entry.connector.sourceType,
            candidate.path,
            candidate.fingerprint
          );
        } catch {
          failedFiles += 1;
        }
      }
    }
    write(JSON.stringify({
      command: "prepare",
      protocolVersion: 2,
      sourceTypes,
      ...(sourceTypes.length === 1 ? { sourceType: sourceTypes[0] } : {}),
      status: failedFiles > 0 ? "partial" : "complete",
      scanned,
      inserted,
      events,
      records,
      pendingBlobs: outbox.pendingBlobCount(),
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
        allowInsecureLanHttp: allowInsecureLanHttp(env),
        limit: 100
      });
      result.attempted += pageResult.attempted;
      result.acked += pageResult.acked;
      result.failed += pageResult.failed;
      if (pageResult.failed > 0 || pageResult.attempted === 0) break;
    }

    const remainingPending = outbox.status().pending;
    const blobResult = { attempted: 0, acked: 0, failed: 0 };
    if (result.failed === 0 && remainingPending === 0) {
      for (let page = 0; page < 10; page += 1) {
        const pageResult = await syncPendingBlobs({
          outbox,
          endpoint,
          token,
          allowInsecureLanHttp: allowInsecureLanHttp(env),
          limit: 20
        });
        blobResult.attempted += pageResult.attempted;
        blobResult.acked += pageResult.acked;
        blobResult.failed += pageResult.failed;
        if (pageResult.failed > 0 || pageResult.attempted === 0) break;
      }
    }
    const remainingPendingBlobs = outbox.pendingBlobCount();
    write(JSON.stringify({
      command: "sync",
      ...result,
      remainingPending,
      blobAttempted: blobResult.attempted,
      blobAcked: blobResult.acked,
      blobFailed: blobResult.failed,
      remainingPendingBlobs
    }));
    if (
      result.failed > 0 ||
      remainingPending > 0 ||
      blobResult.failed > 0 ||
      remainingPendingBlobs > 0
    ) {
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
    write(JSON.stringify({
      command: "status",
      ...outbox.status(),
      pendingBlobs: outbox.pendingBlobCount()
    }));
  } finally {
    outbox.close();
  }
}

async function runInstallZcodeHook(
  env: Record<string, string | undefined>,
  write: (line: string) => void
): Promise<void> {
  const configPath = env.ZCODE_CONFIG_PATH?.trim() ||
    join(homedir(), ".zcode", "cli", "config.json");
  const spoolPath = env.ZCODE_HOOK_SPOOL?.trim() ||
    join(homedir(), ".ai-worklog", "zcode-spool");
  const hookScriptPath = fileURLToPath(new URL(
    "../scripts/zcode-capture-hook.mjs",
    import.meta.url
  ));
  const result = await installZcodeHook({
    configPath,
    spoolPath,
    hookScriptPath
  });
  write(JSON.stringify({
    command: "install-zcode-hook",
    status: result.changed ? "installed" : "unchanged",
    backedUp: result.backupPath !== null
  }));
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
  const parsed = parseCommand(argv);
  const { command } = parsed;
  if (command === "prepare") {
    return protocolVersion(env) === 1
      ? runPrepareV1(env, write)
      : runPrepareV2(env, write, parsed.source, parsed.forceHistory);
  }
  if (command === "sync") return runSync(env, write);
  if (command === "status") return runStatus(env, write);
  if (command === "install-zcode-hook") return runInstallZcodeHook(env, write);
  return runFixtures(env, write);
}
