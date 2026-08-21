import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BLOB_CHUNK_BYTES } from "@ai-worklog/contracts";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  initialize: vi.fn(),
  putChunk: vi.fn(),
  complete: vi.fn(),
  preAuthConsume: vi.fn(),
  rateConsume: vi.fn(),
  serverContext: vi.fn()
}));

vi.mock("@ai-worklog/server", () => ({
  authenticateDevice: mocks.authenticate,
  blobRootFromEnvironment: vi.fn(() => "/tmp/ai-worklog-test-blobs"),
  MysqlBlobRepository: class MysqlBlobRepository {},
  BlobService: class BlobService {
    initialize = mocks.initialize;
    putChunk = mocks.putChunk;
    complete = mocks.complete;
  },
  syncPreAuthRateLimiter: { consume: mocks.preAuthConsume },
  syncRateLimiter: { consume: mocks.rateConsume }
}));

vi.mock("@/lib/server-api", () => ({
  apiError: vi.fn((error: { status?: number; code?: string }, requestId: string) =>
    NextResponse.json({
      error: {
        code: error.code ?? "INTERNAL_ERROR",
        message: "test",
        retryable: false,
        requestId
      }
    }, { status: error.status ?? 500 })
  ),
  requestId: vi.fn(() => "request-test"),
  serverContext: mocks.serverContext
}));

import { PUT as initializeBlob } from "./sync/blobs/[sha256]/route";
import { PUT as uploadChunk } from "./sync/blobs/[sha256]/chunks/[index]/route";
import { POST as completeBlob } from "./sync/blobs/[sha256]/complete/route";

const sha256 = "a".repeat(64);
const identity = {
  accountId: "account-a",
  deviceId: "device-a",
  deviceTokenId: "token-a"
};

describe("device-authenticated Blob routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.serverContext.mockReturnValue({ pool: { execute: vi.fn() } });
    mocks.authenticate.mockResolvedValue(identity);
    mocks.initialize.mockResolvedValue({
      status: "PENDING",
      chunkCount: 2,
      receivedChunks: [0]
    });
    mocks.putChunk.mockResolvedValue({
      index: 1,
      sha256: "b".repeat(64),
      wasDuplicate: false
    });
    mocks.complete.mockResolvedValue({
      status: "COMPLETE",
      sha256,
      byteLength: MAX_BLOB_CHUNK_BYTES + 1,
      path: "/must/not/leave/server"
    });
  });

  it("initializes a resumable one-MiB manifest", async () => {
    const manifest = {
      byteLength: MAX_BLOB_CHUNK_BYTES + 1,
      chunkSize: MAX_BLOB_CHUNK_BYTES,
      mediaType: "application/octet-stream",
      filename: "trace.bin"
    };
    const response = await initializeBlob(
      new NextRequest(`http://localhost/api/v1/sync/blobs/${sha256}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${"c".repeat(64)}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(manifest)
      }),
      { params: Promise.resolve({ sha256 }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        sha256,
        status: "PENDING",
        chunkSize: MAX_BLOB_CHUNK_BYTES,
        chunkCount: 2,
        receivedChunks: [0]
      }
    });
    expect(mocks.initialize).toHaveBeenCalledWith(identity.accountId, sha256, manifest);
  });

  it("accepts one binary chunk and reports its digest", async () => {
    const bytes = new Uint8Array([1]);
    const response = await uploadChunk(
      new NextRequest(
        `http://localhost/api/v1/sync/blobs/${sha256}/chunks/1`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${"c".repeat(64)}`,
            "content-type": "application/octet-stream"
          },
          body: bytes
        }
      ),
      { params: Promise.resolve({ sha256, index: "1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        sha256,
        index: 1,
        chunkSha256: "b".repeat(64),
        wasDuplicate: false
      }
    });
    expect(mocks.putChunk).toHaveBeenCalledWith(
      identity.accountId,
      sha256,
      1,
      expect.any(Uint8Array)
    );
  });

  it("completes without exposing the central filesystem path", async () => {
    const body = {
      byteLength: MAX_BLOB_CHUNK_BYTES + 1,
      chunkCount: 2,
      sha256
    };
    const response = await completeBlob(
      new NextRequest(`http://localhost/api/v1/sync/blobs/${sha256}/complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"c".repeat(64)}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      }),
      { params: Promise.resolve({ sha256 }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        sha256,
        status: "COMPLETE",
        byteLength: MAX_BLOB_CHUNK_BYTES + 1
      }
    });
  });
});
