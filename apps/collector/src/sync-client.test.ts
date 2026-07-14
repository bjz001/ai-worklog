import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexConnector } from "./codex-connector.js";
import { Outbox } from "./outbox.js";
import { prepareFile } from "./prepare.js";
import { syncPending } from "./sync-client.js";

const openOutboxes: Outbox[] = [];
const fixturesRoot = fileURLToPath(new URL("../../../fixtures/codex/", import.meta.url));

afterEach(() => {
  for (const outbox of openOutboxes.splice(0)) outbox.close();
});

describe("syncPending", () => {
  it("uploads the payload with authentication, idempotency, and digest headers before ACKing", async () => {
    const outbox = new Outbox(join(mkdtempSync(join(tmpdir(), "collector-sync-")), "collector.sqlite"));
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

    const observed: Record<string, string | undefined> = {};
    const server = createServer((request, response) => {
      observed.authorization = request.headers.authorization;
      observed.idempotency = request.headers["idempotency-key"] as string | undefined;
      observed.digest = request.headers["x-payload-sha256"] as string | undefined;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        batchId: prepared.batchId,
        status: "COMMITTED",
        receivedCount: 2,
        insertedCount: 2,
        duplicateCount: 0,
        changedCount: 0,
        committedAt: "2026-07-14T15:00:00.000Z"
      }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    try {
      const result = await syncPending({
        outbox,
        endpoint: `http://127.0.0.1:${address.port}/v1/sync/batches`,
        token: "fixture-device-token"
      });

      expect(result).toEqual({ attempted: 1, acked: 1, failed: 0 });
      expect(observed).toEqual({
        authorization: "Bearer fixture-device-token",
        idempotency: prepared.batchId,
        digest: prepared.payloadSha256
      });
      expect(outbox.status().acked).toBe(1);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => error ? rejectClose(error) : resolveClose())
      );
    }
  });

  it("leaves a batch pending when the server does not ACK it", async () => {
    const outbox = new Outbox(join(mkdtempSync(join(tmpdir(), "collector-sync-")), "collector.sqlite"));
    openOutboxes.push(outbox);
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "windows-device",
      sourceInstanceId: "windows-codex"
    });
    await prepareFile({
      connector,
      outbox,
      filePath: resolve(fixturesRoot, "windows/session.jsonl")
    });
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "UNAVAILABLE" } }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    try {
      const result = await syncPending({
        outbox,
        endpoint: `http://127.0.0.1:${address.port}/v1/sync/batches`,
        token: "fixture-device-token"
      });

      expect(result).toEqual({ attempted: 1, acked: 0, failed: 1 });
      expect(outbox.status().pending).toBe(1);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => error ? rejectClose(error) : resolveClose())
      );
    }
  });

  it("rejects a committed ACK for a different batch", async () => {
    const outbox = new Outbox(join(mkdtempSync(join(tmpdir(), "collector-sync-")), "collector.sqlite"));
    openOutboxes.push(outbox);
    const connector = new CodexConnector({
      accountId: "account-1",
      deviceId: "mac-device",
      sourceInstanceId: "mac-codex"
    });
    await prepareFile({
      connector,
      outbox,
      filePath: resolve(fixturesRoot, "macos/session.jsonl")
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        batchId: "different-batch",
        status: "COMMITTED",
        receivedCount: 2,
        insertedCount: 2,
        duplicateCount: 0,
        changedCount: 0,
        committedAt: "2026-07-14T15:00:00.000Z"
      }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    try {
      const result = await syncPending({
        outbox,
        endpoint: `http://127.0.0.1:${address.port}/v1/sync/batches`,
        token: "fixture-device-token"
      });

      expect(result).toEqual({ attempted: 1, acked: 0, failed: 1 });
      expect(outbox.status()).toEqual({ pending: 1, acked: 0, total: 1 });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => error ? rejectClose(error) : resolveClose())
      );
    }
  });
});
