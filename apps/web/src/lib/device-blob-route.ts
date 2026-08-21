import { MAX_BLOB_CHUNK_BYTES } from "@ai-worklog/contracts";
import {
  BlobService,
  MysqlBlobRepository,
  authenticateDevice,
  blobRootFromEnvironment,
  syncPreAuthRateLimiter,
  syncRateLimiter
} from "@ai-worklog/server";
import type { NextRequest } from "next/server";
import { readBoundedRequestBytes } from "./bounded-request-body";
import { serverContext } from "@/lib/server-api";

export class BlobRouteBoundaryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "BlobRouteBoundaryError";
  }
}

export async function authenticatedBlobContext(request: NextRequest) {
  syncPreAuthRateLimiter.consume("sync-blobs");
  const { pool } = serverContext();
  const identity = await authenticateDevice({
    pool,
    authorization: request.headers.get("authorization"),
    tokenPepper: process.env.DEVICE_TOKEN_PEPPER
  });
  syncRateLimiter.consume(identity.deviceId);
  return {
    identity,
    service: new BlobService({
      root: blobRootFromEnvironment(),
      repository: new MysqlBlobRepository(pool)
    })
  };
}

export async function readSmallJson(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new BlobRouteBoundaryError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "Blob 清单必须使用 application/json"
    );
  }
  const bytes = await readBoundedRequestBytes(
    request,
    64 * 1024,
    () => new BlobRouteBoundaryError("PAYLOAD_TOO_LARGE", 413, "Blob 清单过大")
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BlobRouteBoundaryError("INVALID_JSON", 422, "Blob 清单不是合法 JSON");
  }
}

export async function readBlobChunk(request: NextRequest): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/octet-stream")) {
    throw new BlobRouteBoundaryError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "Blob 分块必须使用 application/octet-stream"
    );
  }
  return readBoundedRequestBytes(
    request,
    MAX_BLOB_CHUNK_BYTES,
    () => new BlobRouteBoundaryError("PAYLOAD_TOO_LARGE", 413, "Blob 分块超过 1 MiB")
  );
}

export function parseChunkIndex(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new BlobRouteBoundaryError("INVALID_BLOB_CHUNK", 422, "Blob 分块索引无效");
  }
  const index = Number(value);
  if (!Number.isSafeInteger(index)) {
    throw new BlobRouteBoundaryError("INVALID_BLOB_CHUNK", 422, "Blob 分块索引无效");
  }
  return index;
}
