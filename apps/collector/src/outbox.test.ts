import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexConnector } from "./codex-connector.js";
import { Outbox } from "./outbox.js";
import { prepareFile } from "./prepare.js";

const openOutboxes: Outbox[] = [];
const fixturesRoot = fileURLToPath(new URL("../../../fixtures/codex/", import.meta.url));

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
});
