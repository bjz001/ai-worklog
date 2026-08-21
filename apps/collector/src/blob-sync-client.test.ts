import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BLOB_CHUNK_BYTES } from "@ai-worklog/contracts";
import { syncPendingBlobs } from "./blob-sync-client.js";
import { Outbox } from "./outbox.js";

const open: Outbox[] = [];
afterEach(() => {
  for (const outbox of open.splice(0)) outbox.close();
  vi.restoreAllMocks();
});

describe("syncPendingBlobs", () => {
  it("resumes missing fixed-size chunks and completes by full SHA-256", async () => {
    const directory = mkdtempSync(join(tmpdir(), "blob-sync-"));
    const path = join(directory, "blob.bin");
    const bytes = Buffer.concat([
      Buffer.alloc(MAX_BLOB_CHUNK_BYTES, 0x41),
      Buffer.from("final chunk")
    ]);
    writeFileSync(path, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const outbox = new Outbox(join(directory, "collector.sqlite"));
    open.push(outbox);
    outbox.enqueueBlob({
      sha256,
      localPath: path,
      byteLength: bytes.byteLength,
      mediaType: "application/octet-stream",
      filename: "blob.bin"
    });
    const received: number[] = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "PUT" && url.pathname.endsWith(`/${sha256}`)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          data: {
            sha256,
            status: "UPLOADING",
            chunkSize: MAX_BLOB_CHUNK_BYTES,
            chunkCount: 2,
            receivedChunks: [0]
          }
        }));
        return;
      }
      const match = url.pathname.match(/\/chunks\/(\d+)$/u);
      if (request.method === "PUT" && match) {
        const index = Number(match[1]);
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          const chunk = Buffer.concat(chunks);
          received.push(index);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            data: {
              sha256,
              index,
              chunkSha256: createHash("sha256").update(chunk).digest("hex"),
              wasDuplicate: false
            }
          }));
        });
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/complete")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          data: { sha256, status: "COMPLETE", byteLength: bytes.byteLength }
        }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    try {
      await expect(syncPendingBlobs({
        outbox,
        endpoint: `http://127.0.0.1:${address.port}/api/v1/sync/batches`,
        token: "fixture-device-token"
      })).resolves.toEqual({ attempted: 1, acked: 1, failed: 0 });
      expect(received).toEqual([1]);
      expect(outbox.pendingBlobCount()).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });

  it("refuses a changed local snapshot without sending its content", async () => {
    const directory = mkdtempSync(join(tmpdir(), "blob-sync-"));
    const path = join(directory, "blob.txt");
    writeFileSync(path, "changed");
    const outbox = new Outbox(join(directory, "collector.sqlite"));
    open.push(outbox);
    outbox.enqueueBlob({
      sha256: "a".repeat(64),
      localPath: path,
      byteLength: 7,
      mediaType: "text/plain"
    });

    await expect(syncPendingBlobs({
      outbox,
      endpoint: "http://127.0.0.1:9/api/v1/sync/batches",
      token: "fixture-device-token",
      timeoutMs: 50
    })).resolves.toEqual({ attempted: 1, acked: 0, failed: 1 });
    expect(outbox.pendingBlobCount()).toBe(1);
  });

  it("cancels an oversized Blob acknowledgement while it is still streaming", async () => {
    const directory = mkdtempSync(join(tmpdir(), "blob-sync-"));
    const path = join(directory, "blob.txt");
    const content = Buffer.from("complete local blob");
    writeFileSync(path, content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const outbox = new Outbox(join(directory, "collector.sqlite"));
    open.push(outbox);
    outbox.enqueueBlob({
      sha256,
      localPath: path,
      byteLength: content.byteLength,
      mediaType: "text/plain"
    });
    let pulls = 0;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(16 * 1024));
          if (pulls === 10) controller.close();
        }
      }),
      { status: 200 }
    ));

    await expect(syncPendingBlobs({
      outbox,
      endpoint: "http://127.0.0.1:9/api/v1/sync/batches",
      token: "fixture-device-token"
    })).resolves.toEqual({ attempted: 1, acked: 0, failed: 1 });
    expect(pulls).toBeLessThan(10);
  });
});
