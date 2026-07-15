import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
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
    const databasePath = join(
      mkdtempSync(join(tmpdir(), "collector-sync-")),
      "collector.sqlite"
    );
    const outbox = new Outbox(databasePath);
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
      response.end(JSON.stringify({
        error: {
          code: "SYNTHETIC_UNAVAILABLE",
          message: "synthetic test failure",
          retryable: true,
          requestId: "synthetic-request-id"
        }
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
      expect(outbox.status().pending).toBe(1);
      const inspector = new Database(databasePath, { readonly: true });
      try {
        const row = inspector.prepare(
          "SELECT last_error_code FROM outbox_batches LIMIT 1"
        ).get() as { last_error_code: string };
        expect(row.last_error_code).toBe("SYNTHETIC_UNAVAILABLE");
      } finally {
        inspector.close();
      }
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => error ? rejectClose(error) : resolveClose())
      );
    }
  });

  it("never forwards a batch body to a redirect destination", async () => {
    const outbox = new Outbox(join(mkdtempSync(join(tmpdir(), "collector-sync-")), "collector.sqlite"));
    openOutboxes.push(outbox);
    await prepareFile({
      connector: new CodexConnector({
        accountId: "account-1",
        deviceId: "mac-device",
        sourceInstanceId: "mac-codex"
      }),
      outbox,
      filePath: resolve(fixturesRoot, "macos/session.jsonl")
    });
    let redirectedRequestCount = 0;
    const sink = createServer((_request, response) => {
      redirectedRequestCount += 1;
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolveListen) =>
      sink.listen(0, "127.0.0.1", resolveListen)
    );
    const sinkAddress = sink.address();
    if (!sinkAddress || typeof sinkAddress === "string") {
      throw new Error("test sink did not bind");
    }
    const source = createServer((_request, response) => {
      response.writeHead(307, {
        location: `http://127.0.0.1:${sinkAddress.port}/unexpected`
      });
      response.end();
    });
    await new Promise<void>((resolveListen) =>
      source.listen(0, "127.0.0.1", resolveListen)
    );
    const sourceAddress = source.address();
    if (!sourceAddress || typeof sourceAddress === "string") {
      throw new Error("test source did not bind");
    }

    try {
      const result = await syncPending({
        outbox,
        endpoint: `http://127.0.0.1:${sourceAddress.port}/v1/sync/batches`,
        token: "fixture-device-token"
      });

      expect(result).toEqual({ attempted: 1, acked: 0, failed: 1 });
      expect(redirectedRequestCount).toBe(0);
      expect(outbox.status().pending).toBe(1);
    } finally {
      await Promise.all([source, sink].map((server) =>
        new Promise<void>((resolveClose, rejectClose) =>
          server.close((error) => error ? rejectClose(error) : resolveClose())
        )
      ));
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

  it("honors Retry-After and continues the same batch after rate limiting", async () => {
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
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(429, { "retry-after": "2" });
        response.end();
        return;
      }
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
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen)
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind");
    }
    const sleeps: number[] = [];

    try {
      const result = await syncPending({
        outbox,
        endpoint: `http://127.0.0.1:${address.port}/v1/sync/batches`,
        token: "fixture-device-token",
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        }
      });

      expect(result).toEqual({ attempted: 1, acked: 1, failed: 0 });
      expect(sleeps).toEqual([2_000]);
      expect(requestCount).toBe(2);
      expect(outbox.status().acked).toBe(1);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => error ? rejectClose(error) : resolveClose())
      );
    }
  });

  it("bounds persistent rate-limit retries across the pending backlog", async () => {
    const outbox = new Outbox(join(mkdtempSync(join(tmpdir(), "collector-sync-")), "collector.sqlite"));
    openOutboxes.push(outbox);
    await prepareFile({
      connector: new CodexConnector({
        accountId: "account-1",
        deviceId: "mac-device",
        sourceInstanceId: "mac-codex"
      }),
      outbox,
      filePath: resolve(fixturesRoot, "macos/session.jsonl")
    });
    await prepareFile({
      connector: new CodexConnector({
        accountId: "account-1",
        deviceId: "windows-device",
        sourceInstanceId: "windows-codex"
      }),
      outbox,
      filePath: resolve(fixturesRoot, "windows/session.jsonl")
    });
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(429, { "retry-after": "1" });
      response.end();
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen)
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind");
    }
    const sleeps: number[] = [];

    try {
      const result = await syncPending({
        outbox,
        endpoint: `http://127.0.0.1:${address.port}/v1/sync/batches`,
        token: "fixture-device-token",
        limit: 10,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        }
      });

      expect(result).toEqual({ attempted: 1, acked: 0, failed: 1 });
      expect(requestCount).toBe(4);
      expect(sleeps).toEqual([1_000, 1_000, 1_000]);
      expect(outbox.status()).toEqual({ pending: 2, acked: 0, total: 2 });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => error ? rejectClose(error) : resolveClose())
      );
    }
  });
});
