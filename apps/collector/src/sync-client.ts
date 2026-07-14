import { SyncBatchResultSchema } from "@ai-worklog/contracts";
import { sha256Hex } from "@ai-worklog/core";
import type { Outbox, PendingBatch } from "./outbox.js";

export interface SyncResult {
  attempted: number;
  acked: number;
  failed: number;
}

function validatedEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  const isLocalHttp = url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("Sync endpoint must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (url.username || url.password) throw new Error("Sync endpoint must not contain credentials");
  return url;
}

function failureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)) return error.message;
  return "SYNC_FAILED";
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("ACK_TOO_LARGE");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      throw new Error("ACK_TOO_LARGE");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function uploadBatch(options: {
  batch: PendingBatch;
  endpoint: URL;
  token: string;
  timeoutMs: number;
}): Promise<void> {
  if (sha256Hex(options.batch.payloadJson) !== options.batch.payloadSha256) {
    throw new Error("PAYLOAD_DIGEST_MISMATCH");
  }

  const response = await fetch(options.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.token}`,
      "idempotency-key": options.batch.batchId,
      "x-payload-sha256": options.batch.payloadSha256
    },
    body: options.batch.payloadJson,
    signal: AbortSignal.timeout(options.timeoutMs)
  });

  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const responseText = await readLimitedResponse(response, 64 * 1024);

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("INVALID_ACK_JSON");
  }
  const ack = SyncBatchResultSchema.safeParse(parsed);
  if (!ack.success) throw new Error("INVALID_ACK_SCHEMA");
  if (ack.data.batchId !== options.batch.batchId) throw new Error("ACK_BATCH_MISMATCH");
}

export async function syncPending(options: {
  outbox: Outbox;
  endpoint: string;
  token: string;
  limit?: number;
  timeoutMs?: number;
}): Promise<SyncResult> {
  if (!options.token) throw new Error("Device token is required");
  const endpoint = validatedEndpoint(options.endpoint);
  const batches = options.outbox.listPending(options.limit ?? 20);
  const result: SyncResult = { attempted: 0, acked: 0, failed: 0 };

  for (const batch of batches) {
    result.attempted += 1;
    options.outbox.recordAttempt(batch.batchId);
    try {
      await uploadBatch({
        batch,
        endpoint,
        token: options.token,
        timeoutMs: options.timeoutMs ?? 15_000
      });
      options.outbox.markAcked(batch.batchId);
      result.acked += 1;
    } catch (error) {
      options.outbox.recordFailure(batch.batchId, failureCode(error));
      result.failed += 1;
    }
  }

  return result;
}
