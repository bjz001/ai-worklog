import {
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync
} from "node:fs";
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
  it.each(["prepare", "sync", "status", "run-fixtures"] as const)(
    "accepts the %s command",
    (command) => {
      expect(parseCommand([command]).command).toBe(command);
    }
  );

  it("rejects unknown commands without echoing environment secrets", () => {
    expect(() => parseCommand(["unknown", "fixture-device-token"])).toThrow("Unknown command: unknown");
  });

  it("accepts a v2 source limiter and advances an unchanged-source cursor", async () => {
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

    expect(payloads[0]).toContain('"protocolVersion":2');
    expect(payloads.join("\n")).toContain("FAKE_TEST_SECRET_CANARY_1234567890");
    expect(payloads.join("\n")).not.toContain("[REDACTED]");
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      protocolVersion: 2,
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

  it("selects the Claude Code connector for prepare through AI_WORKLOG_SOURCE_TYPE", async () => {
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
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      command: "prepare",
      status: "complete",
      scanned: 1,
      inserted: 1,
      events: 2,
      sourceType: "CLAUDE_CODE"
    });
  });

  it("keeps Codex as the default prepare connector", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-"));
    const databasePath = join(directory, "collector.sqlite");
    const output: string[] = [];

    await runCli(["prepare"], {
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
    await runCli(["prepare"], {
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

    await expect(runCli(["prepare"], {
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
