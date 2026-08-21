import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import {
  BlobChunkResponseSchema,
  BlobCompleteResponseSchema,
  BlobInitializeResponseSchema,
  MAX_BLOB_CHUNK_BYTES
} from "@ai-worklog/contracts";
import type { Outbox, PendingBlob } from "./outbox.js";
import { validatedSyncEndpoint } from "./sync-client.js";

export interface BlobSyncResult {
  attempted: number;
  acked: number;
  failed: number;
}

function blobRootEndpoint(endpoint: string, allowInsecureLanHttp: boolean): URL {
  const url = validatedSyncEndpoint(endpoint, allowInsecureLanHttp);
  if (/\/batches\/?$/u.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/batches\/?$/u, "/blobs");
  } else if (/\/sync\/?$/u.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/sync\/?$/u, "/sync/blobs");
  } else {
    throw new Error("Sync endpoint must end in /sync or /sync/batches");
  }
  url.search = "";
  url.hash = "";
  return url;
}

async function responseJson(response: Response): Promise<unknown> {
  const maxBytes = 64 * 1024;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("BLOB_ACK_TOO_LARGE");
  }
  if (!response.body) throw new Error("INVALID_BLOB_ACK_JSON");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("BLOB_ACK_TOO_LARGE");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("INVALID_BLOB_ACK_JSON");
  }
}

async function requestJson(options: {
  url: URL;
  token: string;
  method: "PUT" | "POST";
  contentType: string;
  body: BodyInit;
  timeoutMs: number;
  headers?: Record<string, string>;
}): Promise<unknown> {
  const response = await fetch(options.url, {
    method: options.method,
    redirect: "manual",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": options.contentType,
      ...(options.headers ?? {})
    },
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs)
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP_${response.status}`);
  }
  return responseJson(response);
}

async function verifyLocalBlob(blob: PendingBlob): Promise<void> {
  const file = await stat(blob.localPath);
  if (!file.isFile() || file.size !== blob.byteLength) {
    throw new Error("LOCAL_BLOB_CHANGED");
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(blob.localPath)) {
    digest.update(chunk as Buffer);
  }
  if (digest.digest("hex") !== blob.sha256) {
    throw new Error("LOCAL_BLOB_CHANGED");
  }
}

async function readChunk(
  file: Awaited<ReturnType<typeof open>>,
  index: number,
  byteLength: number
): Promise<Buffer> {
  const start = index * MAX_BLOB_CHUNK_BYTES;
  const length = Math.min(MAX_BLOB_CHUNK_BYTES, byteLength - start);
  if (length < 0) throw new Error("INVALID_BLOB_CHUNK_INDEX");
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, start + offset);
    if (bytesRead === 0) throw new Error("LOCAL_BLOB_CHANGED");
    offset += bytesRead;
  }
  return buffer;
}

async function uploadBlob(options: {
  blob: PendingBlob;
  root: URL;
  token: string;
  timeoutMs: number;
}): Promise<void> {
  await verifyLocalBlob(options.blob);
  const objectUrl = new URL(`${options.root.pathname}/${options.blob.sha256}`, options.root);
  const initialized = BlobInitializeResponseSchema.parse(await requestJson({
    url: objectUrl,
    token: options.token,
    method: "PUT",
    contentType: "application/json",
    body: JSON.stringify({
      byteLength: options.blob.byteLength,
      chunkSize: MAX_BLOB_CHUNK_BYTES,
      mediaType: options.blob.mediaType,
      ...(options.blob.filename ? { filename: options.blob.filename } : {})
    }),
    timeoutMs: options.timeoutMs
  }));
  const expectedChunkCount = Math.ceil(
    options.blob.byteLength / MAX_BLOB_CHUNK_BYTES
  );
  if (
    initialized.data.sha256 !== options.blob.sha256 ||
    initialized.data.chunkCount !== expectedChunkCount
  ) {
    throw new Error("BLOB_INIT_MISMATCH");
  }
  if (initialized.data.status === "COMPLETE") return;

  const received = new Set(initialized.data.receivedChunks);
  const file = await open(options.blob.localPath, "r");
  try {
    for (let index = 0; index < expectedChunkCount; index += 1) {
      if (received.has(index)) continue;
      const chunk = await readChunk(file, index, options.blob.byteLength);
      const chunkSha256 = createHash("sha256").update(chunk).digest("hex");
      const url = new URL(`${objectUrl.pathname}/chunks/${index}`, objectUrl);
      const response = BlobChunkResponseSchema.parse(await requestJson({
        url,
        token: options.token,
        method: "PUT",
        contentType: "application/octet-stream",
        body: new Uint8Array(chunk),
        timeoutMs: options.timeoutMs,
        headers: {
          "content-length": String(chunk.byteLength),
          "x-chunk-sha256": chunkSha256
        }
      }));
      if (
        response.data.sha256 !== options.blob.sha256 ||
        response.data.index !== index ||
        response.data.chunkSha256 !== chunkSha256
      ) {
        throw new Error("BLOB_CHUNK_ACK_MISMATCH");
      }
    }
  } finally {
    await file.close();
  }

  const completeUrl = new URL(`${objectUrl.pathname}/complete`, objectUrl);
  const completed = BlobCompleteResponseSchema.parse(await requestJson({
    url: completeUrl,
    token: options.token,
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({
      byteLength: options.blob.byteLength,
      chunkCount: expectedChunkCount,
      sha256: options.blob.sha256
    }),
    timeoutMs: options.timeoutMs
  }));
  if (
    completed.data.sha256 !== options.blob.sha256 ||
    completed.data.byteLength !== options.blob.byteLength
  ) {
    throw new Error("BLOB_COMPLETE_ACK_MISMATCH");
  }
}

function failureCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^[A-Z][A-Z0-9_]{2,63}$/u.test(error.message)
  ) return error.message;
  return "BLOB_SYNC_FAILED";
}

export async function syncPendingBlobs(options: {
  outbox: Outbox;
  endpoint: string;
  token: string;
  limit?: number;
  timeoutMs?: number;
  allowInsecureLanHttp?: boolean;
}): Promise<BlobSyncResult> {
  if (!options.token) throw new Error("Device token is required");
  const root = blobRootEndpoint(
    options.endpoint,
    options.allowInsecureLanHttp === true
  );
  const blobs = options.outbox.listPendingBlobs(options.limit ?? 20);
  const result: BlobSyncResult = { attempted: 0, acked: 0, failed: 0 };
  for (const blob of blobs) {
    result.attempted += 1;
    options.outbox.recordBlobAttempt(blob.sha256);
    try {
      await uploadBlob({
        blob,
        root,
        token: options.token,
        timeoutMs: options.timeoutMs ?? 60_000
      });
      options.outbox.markBlobAcked(blob.sha256);
      result.acked += 1;
    } catch (error) {
      options.outbox.recordBlobFailure(blob.sha256, failureCode(error));
      result.failed += 1;
    }
  }
  return result;
}
