import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SYNC_BATCH_BODY_BYTES } from "@ai-worklog/contracts";
import { sha256Hex } from "@ai-worklog/core";
import { CodexConnector } from "./codex-connector.js";
import { Outbox } from "./outbox.js";
import { prepareFile } from "./prepare.js";
import type { PromptConnector } from "./prompt-connector.js";

const openOutboxes: Outbox[] = [];
const fixturesRoot = fileURLToPath(new URL("../../../fixtures/codex/", import.meta.url));

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

afterEach(() => {
  for (const outbox of openOutboxes.splice(0)) outbox.close();
});

describe("Outbox", () => {
  it("persists only redacted payloads and deduplicates a repeated prepare", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-outbox-"));
    const databasePath = join(directory, "collector.sqlite");
    const outbox = new Outbox(databasePath);
    openOutboxes.push(outbox);
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "windows-device",
      sourceInstanceId: "windows-codex"
    });
    const fixturePath = resolve(fixturesRoot, "windows/session.jsonl");

    const first = await prepareFile({ connector, outbox, filePath: fixturePath });
    const second = await prepareFile({ connector, outbox, filePath: fixturePath });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(outbox.status()).toEqual({ pending: 1, acked: 0, total: 1 });
    expect(outbox.listPending(10)[0]?.payloadJson).toContain("[REDACTED]");
    expect(outbox.listPending(10)[0]?.payloadJson).not.toContain("FAKE_TEST_SECRET_CANARY_1234567890");
    expect(readFileSync(databasePath)).not.toContain(Buffer.from("FAKE_TEST_SECRET_CANARY_1234567890"));
  });

  it("queues a v2 envelope beside a legacy v1 Outbox batch without reusing its identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-outbox-v1-migration-"));
    const outbox = new Outbox(join(directory, "collector.sqlite"));
    openOutboxes.push(outbox);
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "windows-device",
      sourceInstanceId: "windows-codex"
    });
    const fixturePath = resolve(fixturesRoot, "windows/session.jsonl");
    const session = await connector.readFile(fixturePath);
    const eventIdentity = session.events
      .map((event) => `${event.eventId}:${event.contentHash}`)
      .join("\u001f");
    const legacyBatchId = sha256Hex([
      "batch-v1",
      connector.sourceType,
      connector.sourceInstanceId,
      eventIdentity
    ].join("\u001f"));
    const legacyCreatedAt = session.events
      .map((event) => event.occurredAt)
      .sort()[0];
    if (!legacyCreatedAt) throw new Error("fixture unexpectedly had no events");
    const legacyPayloadJson = canonicalJson({
      protocolVersion: 1,
      batchId: legacyBatchId,
      createdAt: legacyCreatedAt,
      source: {
        type: connector.sourceType,
        instanceId: connector.sourceInstanceId,
        parserVersion: "codex-jsonl-v1"
      },
      events: session.events
    });
    outbox.enqueue({
      batchId: legacyBatchId,
      createdAt: legacyCreatedAt,
      payloadJson: legacyPayloadJson,
      payloadSha256: sha256Hex(legacyPayloadJson)
    });

    const migrated = await prepareFile({ connector, outbox, filePath: fixturePath });
    const batches = outbox.listPending(10).map((batch) =>
      JSON.parse(batch.payloadJson) as {
        batchId: string;
        source: { parserVersion: string };
        events: Array<{ eventId: string; messageIndex: number }>;
      }
    );

    expect(migrated.batchId).not.toBe(legacyBatchId);
    expect(outbox.status()).toEqual({ pending: 2, acked: 0, total: 2 });
    expect(batches.map((batch) => batch.source.parserVersion).sort()).toEqual([
      "codex-jsonl-v1",
      "codex-jsonl-v4"
    ]);
    expect(batches[0]?.events.map(({ eventId, messageIndex }) => ({
      eventId,
      messageIndex
    }))).toEqual(batches[1]?.events.map(({ eventId, messageIndex }) => ({
      eventId,
      messageIndex
    })));
  });

  it("keeps a batch pending until an explicit matching ACK marks it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-outbox-"));
    const outbox = new Outbox(join(directory, "collector.sqlite"));
    openOutboxes.push(outbox);
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });
    const prepared = await prepareFile({
      connector,
      outbox,
      filePath: resolve(fixturesRoot, "macos/session.jsonl")
    });

    expect(outbox.status().pending).toBe(1);
    expect(() => outbox.markAcked("not-the-batch-id")).toThrow(/unknown batch/i);
    expect(outbox.status().pending).toBe(1);
    if (!prepared.batchId) throw new Error("fixture unexpectedly had no events");
    outbox.markAcked(prepared.batchId);
    expect(outbox.status()).toEqual({ pending: 0, acked: 1, total: 1 });
  });

  it("queues a new batch when content changes while preserving stable event identities", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-outbox-"));
    const databasePath = join(directory, "collector.sqlite");
    const sourcePath = join(directory, "session.jsonl");
    const fixture = readFileSync(resolve(fixturesRoot, "macos/session.jsonl"), "utf8");
    writeFileSync(sourcePath, fixture);
    const outbox = new Outbox(databasePath);
    openOutboxes.push(outbox);
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });

    const firstSession = await connector.readFile(sourcePath);
    const first = await prepareFile({ connector, outbox, filePath: sourcePath });
    writeFileSync(sourcePath, fixture.replace("补充 macOS", "更新 macOS"));
    const secondSession = await connector.readFile(sourcePath);
    const second = await prepareFile({ connector, outbox, filePath: sourcePath });

    expect(secondSession.events.map((event) => event.eventId)).toEqual(
      firstSession.events.map((event) => event.eventId)
    );
    expect(second.batchId).not.toBe(first.batchId);
    expect(second.inserted).toBe(true);
    expect(outbox.status().pending).toBe(2);
  });

  it("splits sessions larger than the protocol batch limit without dropping events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-outbox-"));
    const databasePath = join(directory, "collector.sqlite");
    const sourcePath = join(directory, "large-session.jsonl");
    const records = [
      {
        timestamp: "2026-07-14T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "large-session",
          cwd: "/Users/demo/work/large",
          source_time_zone: "UTC",
          git: { repository_url: "https://github.com/acme/large.git" }
        }
      },
      ...Array.from({ length: 201 }, (_, index) => ({
        timestamp: new Date(Date.UTC(2026, 6, 14, 0, index)).toISOString(),
        type: "response_item",
        payload: {
          id: `large-message-${index}`,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `Prompt ${index}` }]
        }
      }))
    ];
    writeFileSync(sourcePath, records.map((record) => JSON.stringify(record)).join("\n"));
    const outbox = new Outbox(databasePath);
    openOutboxes.push(outbox);
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });

    const result = await prepareFile({ connector, outbox, filePath: sourcePath });

    expect(result).toMatchObject({ eventCount: 201, batchCount: 2, insertedCount: 2 });
    expect(outbox.status()).toEqual({ pending: 2, acked: 0, total: 2 });
  });

  it("prepares streamed sessions independently instead of collecting one source", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-outbox-stream-"));
    const outbox = new Outbox(join(directory, "collector.sqlite"));
    openOutboxes.push(outbox);
    const event = (sessionId: string, index: number) => {
      const content = `Prompt ${sessionId}`;
      return {
        eventId: sha256Hex(`${sessionId}:${index}`),
        kind: "USER_PROMPT" as const,
        sourceSessionId: sessionId,
        sourceMessageId: `message-${index}`,
        messageIndex: index,
        occurredAt: `2026-07-14T00:0${index}:00.000Z`,
        sourceTimeZone: "UTC",
        sanitizedContent: content,
        contentHash: sha256Hex(content),
        redactionVersion: "RAW_V1",
        metadata: {}
      };
    };
    const connector: PromptConnector = {
      sourceType: "DSH",
      sourceInstanceId: "windows-dsh",
      parserVersion: "dsh-official-session-v1-prompt-v1",
      readFile: async () => {
        throw new Error("streaming path should not call readFile");
      },
      readFileSessions: async (_path, onSession) => {
        await onSession({ sessionId: "session-1", events: [event("session-1", 0)] });
        await onSession({ sessionId: "session-2", events: [event("session-2", 1)] });
      }
    };

    const result = await prepareFile({
      connector,
      outbox,
      filePath: "/tmp/dsh"
    });

    expect(result).toMatchObject({
      eventCount: 2,
      batchCount: 2,
      insertedCount: 2,
      inserted: true
    });
    expect(outbox.status()).toEqual({ pending: 2, acked: 0, total: 2 });
  });

  it("splits UTF-8-heavy sessions below the API body limit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-outbox-"));
    const databasePath = join(directory, "collector.sqlite");
    const sourcePath = join(directory, "large-content-session.jsonl");
    const records = [
      {
        timestamp: "2026-07-14T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "large-content-session",
          cwd: "/Users/demo/work/large-content",
          source_time_zone: "UTC"
        }
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        timestamp: new Date(Date.UTC(2026, 6, 14, 0, index)).toISOString(),
        type: "response_item",
        payload: {
          id: `large-content-message-${index}`,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `Prompt ${index} ${"界".repeat(80_000)}` }]
        }
      }))
    ];
    writeFileSync(
      sourcePath,
      records.map((record) => JSON.stringify(record)).join("\n")
    );
    const outbox = new Outbox(databasePath);
    openOutboxes.push(outbox);
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });

    const result = await prepareFile({ connector, outbox, filePath: sourcePath });
    const batches = outbox.listPending(100);
    const eventCount = batches.reduce((count, batch) => {
      const payload = JSON.parse(batch.payloadJson) as { events: unknown[] };
      return count + payload.events.length;
    }, 0);

    expect(result.batchCount).toBeGreaterThan(1);
    expect(eventCount).toBe(12);
    expect(
      batches.every(
        (batch) => Buffer.byteLength(batch.payloadJson, "utf8") <= MAX_SYNC_BATCH_BODY_BYTES
      )
    ).toBe(true);
  });

  it("quarantines pending non-v1 batches and blobs without deleting their source files", () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-outbox-quarantine-"));
    const databasePath = join(directory, "collector.sqlite");
    const blobPath = join(directory, "legacy-attachment.txt");
    const blobContent = Buffer.from("legacy attachment");
    writeFileSync(blobPath, blobContent);
    const outbox = new Outbox(databasePath);
    openOutboxes.push(outbox);
    const legacyPayload = JSON.stringify({ protocolVersion: 2, events: [{ kind: "RUN" }] });

    outbox.enqueue({
      batchId: "b".repeat(64),
      createdAt: "2026-08-31T00:00:00.000Z",
      payloadJson: legacyPayload,
      payloadSha256: sha256Hex(legacyPayload)
    });
    outbox.enqueueBlob({
      sha256: sha256Hex(blobContent),
      localPath: blobPath,
      byteLength: blobContent.byteLength,
      mediaType: "text/plain",
      filename: "legacy-attachment.txt"
    });

    expect(outbox.quarantineLegacyPending()).toEqual({ batches: 1, blobs: 1 });
    expect(outbox.status()).toEqual({ pending: 0, acked: 0, total: 0 });
    expect(outbox.pendingBlobCount()).toBe(0);
    expect(readFileSync(blobPath)).toEqual(blobContent);
  });
});
