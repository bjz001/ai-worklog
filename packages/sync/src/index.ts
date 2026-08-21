import { timingSafeEqual } from "node:crypto";
import {
  SyncRequestSchema,
  type AgentSyncBatchRequest,
  type SyncBatchRequest,
  type SyncRequest
} from "@ai-worklog/contracts";
import { sha256Hex } from "@ai-worklog/core";

export class InvalidBatchError extends Error {
  readonly code = "INVALID_BATCH";
  readonly status = 422;

  constructor(message = "同步批次格式无效") {
    super(message);
    this.name = "InvalidBatchError";
  }
}

export class BatchPayloadMismatchError extends Error {
  readonly code = "BATCH_PAYLOAD_MISMATCH";
  readonly status = 409;

  constructor(message = "请求正文摘要与声明值不一致") {
    super(message);
    this.name = "BatchPayloadMismatchError";
  }
}

export interface IncomingBatchInput {
  body: string;
  idempotencyKey: string | null;
  declaredPayloadHash: string | null;
}

export interface ValidatedIncomingBatch {
  payload: SyncRequest;
  payloadHash: string;
}

export interface ValidatedIncomingV1Batch extends ValidatedIncomingBatch {
  payload: SyncBatchRequest;
}

export interface ValidatedIncomingV2Batch extends ValidatedIncomingBatch {
  payload: AgentSyncBatchRequest;
}

function equalHexDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function validateIncomingBatch(
  input: IncomingBatchInput
): ValidatedIncomingBatch {
  const payloadHash = sha256Hex(input.body);
  if (
    !input.declaredPayloadHash ||
    !equalHexDigest(payloadHash, input.declaredPayloadHash)
  ) {
    throw new BatchPayloadMismatchError();
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(input.body);
  } catch {
    throw new InvalidBatchError("请求正文不是合法 JSON");
  }

  const parsed = SyncRequestSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new InvalidBatchError();
  }

  if (!input.idempotencyKey || input.idempotencyKey !== parsed.data.batchId) {
    throw new InvalidBatchError("Idempotency-Key 与 batchId 不一致");
  }

  return { payload: parsed.data, payloadHash };
}
