import {
  ApiErrorSchema,
  SyncBatchResultSchema
} from "@ai-worklog/contracts";
import { sha256Hex } from "@ai-worklog/core";
import type { Outbox, PendingBatch } from "./outbox.js";

export interface SyncResult {
  attempted: number;
  acked: number;
  failed: number;
}

class ServerRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("HTTP_429");
    this.name = "ServerRateLimitError";
  }
}

function retryAfterMilliseconds(response: Response): number {
  const value = response.headers.get("retry-after")?.trim() ?? "";
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.ceil(seconds * 1_000), 5 * 60_000);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(1_000, date - Date.now()), 5 * 60_000);
  }
  return 60_000;
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

async function serverFailureCode(response: Response): Promise<string> {
  const fallback = `HTTP_${response.status}`;
  try {
    const body = await readLimitedResponse(response, 64 * 1024);
    const parsed = ApiErrorSchema.safeParse(JSON.parse(body));
    return parsed.success && /^[A-Z][A-Z0-9_]{2,63}$/u.test(parsed.data.error.code)
      ? parsed.data.error.code
      : fallback;
  } catch {
    await response.body?.cancel().catch(() => undefined);
    return fallback;
  }
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
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.token}`,
      "idempotency-key": options.batch.batchId,
      "x-payload-sha256": options.batch.payloadSha256
    },
    body: options.batch.payloadJson,
    signal: AbortSignal.timeout(options.timeoutMs)
  });

  if (!response.ok) {
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      throw new ServerRateLimitError(retryAfterMilliseconds(response));
    }
    throw new Error(await serverFailureCode(response));
  }
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
  maxRateLimitRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<SyncResult> {
  if (!options.token) throw new Error("Device token is required");
  const endpoint = validatedEndpoint(options.endpoint);
  const batches = options.outbox.listPending(options.limit ?? 20);
  const result: SyncResult = { attempted: 0, acked: 0, failed: 0 };
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const maxRateLimitRetries = Math.max(
    0,
    Math.min(Math.trunc(options.maxRateLimitRetries ?? 3), 20)
  );

  for (const batch of batches) {
    result.attempted += 1;
    options.outbox.recordAttempt(batch.batchId);
    let rateLimitRetries = 0;
    while (true) {
      try {
        await uploadBatch({
          batch,
          endpoint,
          token: options.token,
          // Remote MySQL may need more than 15 seconds for a first historical
          // batch while preserving atomic event/version/job writes.
          timeoutMs: options.timeoutMs ?? 60_000
        });
        options.outbox.markAcked(batch.batchId);
        result.acked += 1;
        break;
      } catch (error) {
        if (
          error instanceof ServerRateLimitError &&
          rateLimitRetries < maxRateLimitRetries
        ) {
          rateLimitRetries += 1;
          await sleep(error.retryAfterMs);
          continue;
        }
        options.outbox.recordFailure(batch.batchId, failureCode(error));
        result.failed += 1;
        // A persistent 429 applies to the device, not just this batch. Once the
        // bounded retry budget is exhausted, leave later batches untouched for
        // the next scheduled run instead of multiplying waits by backlog size.
        if (error instanceof ServerRateLimitError) return result;
        break;
      }
    }
  }

  return result;
}
