import {
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Outbox } from "./outbox.js";
import { parseCommand, runCli } from "./cli.js";

const fixturesRoot = fileURLToPath(new URL("../../../fixtures/codex/", import.meta.url));
const claudeFixturesRoot = fileURLToPath(new URL("../../../fixtures/claude/", import.meta.url));

describe("collector CLI", () => {
  it.each(["prepare", "sync", "status", "run-fixtures", "quarantine-legacy"] as const)(
    "accepts the %s command",
    (command) => {
      expect(parseCommand([command]).command).toBe(command);
    }
  );

  it("rejects unknown commands without echoing environment secrets", () => {
    expect(() => parseCommand(["unknown", "fixture-device-token"])).toThrow("Unknown command: unknown");
  });

  it("defaults to raw Prompt-only v1 and advances an unchanged-source cursor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-v2-"));
    const databasePath = join(directory, "collector.sqlite");
    const output: string[] = [];
    const environment = {
      COLLECTOR_DB_PATH: databasePath,
      COLLECTOR_BLOB_ROOT: join(directory, "blobs"),
      AI_WORKLOG_ACCOUNT_ID: "account-1",
      AI_WORKLOG_DEVICE_ID: "windows-device",
      CODEX_SOURCE_INSTANCE_ID: "windows-codex",
      CODEX_SOURCE_PATH: resolve(fixturesRoot, "windows/session.jsonl")
    };

    expect(parseCommand(["prepare", "--source", "codex"])).toMatchObject({
      command: "prepare",
      source: "CODEX"
    });
    await runCli(["prepare", "--source=CODEX"], {
      env: environment,
      write: (line) => output.push(line)
    });
    await runCli(["prepare", "--source=CODEX"], {
      env: environment,
      write: (line) => output.push(line)
    });
    const outbox = new Outbox(databasePath);
    const payloads = outbox.listPending(100).map((batch) => batch.payloadJson);
    outbox.close();

    expect(payloads[0]).toContain('"protocolVersion":1');
    expect(payloads.join("\n")).toContain("FAKE_TEST_SECRET_CANARY_1234567890");
    expect(payloads.join("\n")).not.toContain("[REDACTED]");
    expect(payloads.join("\n")).not.toContain("VISIBLE_RESULT");
    const batch = JSON.parse(payloads[0] ?? "{}") as {
      events?: Array<Record<string, unknown>>;
    };
    expect(batch.events).toHaveLength(1);
    expect(batch.events?.[0]).toMatchObject({
      metadata: {},
      projectHint: {
        gitRemoteKey: "github.com/acme/ai-worklog",
        repoRootName: "ai-worklog",
        localPathHmac: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      protocolVersion: 1,
      sourceType: "CODEX",
      scanned: 1,
      failedFiles: 0
    });
    expect(JSON.parse(output[1] ?? "{}")).toMatchObject({
      scanned: 1,
      skippedFiles: 1,
      inserted: 0
    });
  });

  it("rejects the disabled Agent trajectory protocol", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-disabled-v2-"));
    await expect(runCli(["prepare"], {
      env: {
        COLLECTOR_DB_PATH: join(directory, "collector.sqlite"),
        AI_WORKLOG_ACCOUNT_ID: "account-1",
        AI_WORKLOG_DEVICE_ID: "device-1",
        AI_WORKLOG_PROTOCOL_VERSION: "2"
      },
      write: () => undefined
    })).rejects.toThrow("Agent trajectory collection is disabled");
  });

  it("runs both platform fixtures and reports counts without exposing a configured token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-"));
    const databasePath = join(directory, "collector.sqlite");
    const output: string[] = [];
    const token = "fixture-token-must-not-be-printed";

    await runCli(["run-fixtures"], {
      env: {
        COLLECTOR_DB_PATH: databasePath,
        COLLECTOR_FIXTURES_ROOT: resolve(fixturesRoot),
        AI_WORKLOG_DEVICE_TOKEN: token
      },
      write: (line) => output.push(line)
    });

    const outbox = new Outbox(databasePath);
    expect(outbox.status()).toEqual({ pending: 2, acked: 0, total: 2 });
    outbox.close();
    expect(output.join("\n")).not.toContain(token);
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({ command: "run-fixtures", prepared: 2 });
  });

  it("reports only aggregate Outbox status", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-"));
    const databasePath = join(directory, "collector.sqlite");
    const output: string[] = [];

    await runCli(["status"], {
      env: { COLLECTOR_DB_PATH: databasePath },
      write: (line) => output.push(line)
    });

    expect(output).toEqual([
      JSON.stringify({
        command: "status",
        pending: 0,
        acked: 0,
        total: 0,
        pendingBlobs: 0
      })
    ]);
  });

  it("quarantines legacy pending data without uploading or deleting the local Blob", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-quarantine-"));
    const databasePath = join(directory, "collector.sqlite");
    const blobPath = join(directory, "legacy.txt");
    const blobContent = Buffer.from("legacy pending blob");
    writeFileSync(blobPath, blobContent);
    const legacyPayload = JSON.stringify({ protocolVersion: 2, events: [{ kind: "RUN" }] });
    const outbox = new Outbox(databasePath);
    outbox.enqueue({
      batchId: "c".repeat(64),
      createdAt: "2026-08-31T00:00:00.000Z",
      payloadJson: legacyPayload,
      payloadSha256: createHash("sha256").update(legacyPayload).digest("hex")
    });
    outbox.enqueueBlob({
      sha256: createHash("sha256").update(blobContent).digest("hex"),
      localPath: blobPath,
      byteLength: blobContent.byteLength,
      mediaType: "text/plain",
      filename: "legacy.txt"
    });
    outbox.close();
    const output: string[] = [];

    await runCli(["quarantine-legacy"], {
      env: { COLLECTOR_DB_PATH: databasePath },
      write: (line) => output.push(line)
    });

    const inspected = new Outbox(databasePath);
    expect(inspected.status()).toEqual({ pending: 0, acked: 0, total: 0 });
    expect(inspected.pendingBlobCount()).toBe(0);
    inspected.close();
    expect(readFileSync(blobPath)).toEqual(blobContent);
    expect(output).toEqual([
      JSON.stringify({
        command: "quarantine-legacy",
        quarantinedBatches: 1,
        quarantinedBlobs: 1
      })
    ]);
  });

  it("passes the explicit private-LAN HTTP opt-in to sync", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-"));
    const databasePath = join(directory, "collector.sqlite");
    const output: string[] = [];

    await runCli(["sync"], {
      env: {
        COLLECTOR_DB_PATH: databasePath,
        AI_WORKLOG_SYNC_URL: "http://172.18.209.21:3000/api/v1/sync/batches",
        AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP: "true",
        AI_WORKLOG_DEVICE_TOKEN: "fixture-device-token"
      },
      write: (line) => output.push(line)
    });

    expect(output).toEqual([
      JSON.stringify({
        command: "sync",
        attempted: 0,
        acked: 0,
        failed: 0,
        remainingPending: 0,
        blobAttempted: 0,
        blobAcked: 0,
        blobFailed: 0,
        remainingPendingBlobs: 0
      })
    ]);
  });

  it("selects the Claude Code prompt connector for prepare through AI_WORKLOG_SOURCE_TYPE", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-"));
    const databasePath = join(directory, "collector.sqlite");
    const output: string[] = [];

    await runCli(["prepare"], {
      env: {
        COLLECTOR_DB_PATH: databasePath,
        AI_WORKLOG_ACCOUNT_ID: "account-1",
        AI_WORKLOG_DEVICE_ID: "windows-device",
        AI_WORKLOG_PROTOCOL_VERSION: "1",
        AI_WORKLOG_SOURCE_TYPE: "CLAUDE_CODE",
        CLAUDE_CODE_SOURCE_INSTANCE_ID: "windows-claude",
        CLAUDE_CODE_SOURCE_PATH: resolve(claudeFixturesRoot, "windows/session.jsonl")
      },
      write: (line) => output.push(line)
    });

    const outbox = new Outbox(databasePath);
    const payload = outbox.listPending(10)[0]?.payloadJson ?? "";
    expect(outbox.status()).toEqual({ pending: 1, acked: 0, total: 1 });
    outbox.close();
    expect(payload).toContain('"type":"CLAUDE_CODE"');
    expect(payload).toContain('"parserVersion":"claude-code-jsonl-v2"');
    expect(payload).toContain("FAKE_CLAUDE_SECRET_CANARY_1234567890");
    expect(payload).not.toContain("[REDACTED]");
    const batch = JSON.parse(payload) as {
      events?: Array<Record<string, unknown>>;
    };
    expect(batch.events).toHaveLength(1);
    expect(batch.events?.[0]).toMatchObject({ metadata: {} });
    expect(batch.events?.[0]).not.toHaveProperty("projectHint");
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      command: "prepare",
      status: "complete",
      scanned: 1,
      inserted: 1,
      events: 1,
      sourceType: "CLAUDE_CODE"
    });
  });

  it("selects the Codex prompt connector for prepare", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-"));
    const databasePath = join(directory, "collector.sqlite");
    const output: string[] = [];

    await runCli(["prepare", "--source=CODEX"], {
      env: {
        COLLECTOR_DB_PATH: databasePath,
        AI_WORKLOG_ACCOUNT_ID: "account-1",
        AI_WORKLOG_DEVICE_ID: "windows-device",
        AI_WORKLOG_PROTOCOL_VERSION: "1",
        CODEX_SOURCE_INSTANCE_ID: "windows-codex",
        CODEX_SOURCE_PATH: resolve(fixturesRoot, "windows/session.jsonl")
      },
      write: (line) => output.push(line)
    });

    const outbox = new Outbox(databasePath);
    const payload = outbox.listPending(10)[0]?.payloadJson ?? "";
    outbox.close();
    expect(payload).toContain('"type":"CODEX"');
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({ sourceType: "CODEX" });
  });

  it("fails the sync command when a batch remains unacknowledged", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-"));
    const databasePath = join(directory, "collector.sqlite");
    const output: string[] = [];
    const sharedEnvironment = {
      COLLECTOR_DB_PATH: databasePath,
      AI_WORKLOG_ACCOUNT_ID: "account-1",
      AI_WORKLOG_DEVICE_ID: "windows-device",
      AI_WORKLOG_PROTOCOL_VERSION: "1",
      CODEX_SOURCE_INSTANCE_ID: "windows-codex",
      CODEX_SOURCE_PATH: resolve(fixturesRoot, "windows/session.jsonl")
    };
    await runCli(["prepare", "--source=CODEX"], {
      env: sharedEnvironment,
      write: () => undefined
    });

    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "UNAVAILABLE" } }));
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen)
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind");
    }

    try {
      await expect(runCli(["sync"], {
        env: {
          ...sharedEnvironment,
          AI_WORKLOG_SYNC_URL: `http://127.0.0.1:${address.port}/api/v1/sync/batches`,
          AI_WORKLOG_DEVICE_TOKEN: "fixture-device-token"
        },
        write: (line) => output.push(line)
      })).rejects.toThrow("SYNC_INCOMPLETE");

      expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
        command: "sync",
        attempted: 1,
        acked: 0,
        failed: 1,
        remainingPending: 1
      });
      expect(output.join("\n")).not.toContain("fixture-device-token");
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => error ? rejectClose(error) : resolveClose())
      );
    }
  });

  it("blocks sync while legacy batches or Blobs remain outside quarantine", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-quarantine-guard-"));
    const databasePath = join(directory, "collector.sqlite");
    const blobPath = join(directory, "legacy-attachment.txt");
    const blobContent = Buffer.from("legacy pending attachment");
    const blobSha256 = createHash("sha256").update(blobContent).digest("hex");
    writeFileSync(blobPath, blobContent);
    const legacyPayload = JSON.stringify({ protocolVersion: 2, events: [{ kind: "RUN" }] });
    const outbox = new Outbox(databasePath);
    outbox.enqueue({
      batchId: "a".repeat(64),
      createdAt: "2026-08-24T00:00:00.000Z",
      payloadJson: legacyPayload,
      payloadSha256: createHash("sha256").update(legacyPayload).digest("hex")
    });
    outbox.enqueueBlob({
      sha256: blobSha256,
      localPath: blobPath,
      byteLength: blobContent.byteLength,
      mediaType: "text/plain",
      filename: "attachment.txt"
    });
    outbox.close();
    const output: string[] = [];

    await expect(runCli(["sync"], {
      env: { COLLECTOR_DB_PATH: databasePath },
      write: (line) => output.push(line)
    })).rejects.toThrow("LEGACY_OUTBOX_REQUIRES_QUARANTINE");

    const inspected = new Outbox(databasePath);
    expect(inspected.status().pending).toBe(1);
    expect(inspected.pendingBlobCount()).toBe(1);
    inspected.close();
    expect(readFileSync(blobPath)).toEqual(blobContent);
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      command: "sync",
      status: "blocked",
      errorCode: "LEGACY_OUTBOX_REQUIRES_QUARANTINE",
      pendingLegacyBatches: 1,
      remainingPending: 1,
      remainingPendingBlobs: 1
    });
  });

  it("queues healthy files while isolating empty, malformed, and oversized files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-"));
    const databasePath = join(directory, "collector.sqlite");
    writeFileSync(join(directory, "broken.jsonl"), "{not-json}\n");
    writeFileSync(join(directory, "empty.jsonl"), "");
    writeFileSync(
      join(directory, "healthy.jsonl"),
      readFileSync(resolve(fixturesRoot, "windows/session.jsonl"), "utf8")
    );
    writeFileSync(
      join(directory, "metadata-only.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-07-15T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "metadata-only", source_time_zone: "UTC" }
      })}\n`
    );
    const oversizedPath = join(directory, "oversized.jsonl");
    writeFileSync(oversizedPath, "");
    truncateSync(oversizedPath, 256 * 1024 * 1024 + 1);
    const output: string[] = [];

    await expect(runCli(["prepare", "--source=CODEX"], {
      env: {
        COLLECTOR_DB_PATH: databasePath,
        AI_WORKLOG_ACCOUNT_ID: "account-1",
        AI_WORKLOG_DEVICE_ID: "windows-device",
        AI_WORKLOG_PROTOCOL_VERSION: "1",
        CODEX_SOURCE_INSTANCE_ID: "windows-codex",
        CODEX_SOURCE_PATH: directory
      },
      write: (line) => output.push(line)
    })).rejects.toThrow("PREPARE_PARTIAL");

    const outbox = new Outbox(databasePath);
    expect(outbox.status().pending).toBe(1);
    outbox.close();
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      status: "partial",
      scanned: 5,
      inserted: 1,
      skippedFiles: 1,
      failedFiles: 3
    });
    expect(output.join("\n")).not.toContain("broken.jsonl");
    rmSync(directory, { recursive: true, force: true });
  });
});
