import {
  authenticateDevice,
  commitAgentSyncBatch,
  commitSyncBatch,
  syncPreAuthRateLimiter,
  syncRateLimiter
} from "@ai-worklog/server";
import { MAX_SYNC_BATCH_BODY_BYTES } from "@ai-worklog/contracts";
import { validateIncomingBatch } from "@ai-worklog/sync";
import { NextRequest, NextResponse } from "next/server";
import { readBoundedRequestBytes } from "../../../../../lib/bounded-request-body";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class RequestBoundaryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "RequestBoundaryError";
  }
}

async function readBoundedJsonBody(request: NextRequest): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new RequestBoundaryError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "同步请求必须使用 application/json"
    );
  }
  const bytes = await readBoundedRequestBytes(
    request,
    MAX_SYNC_BATCH_BODY_BYTES,
    () => new RequestBoundaryError(
      "PAYLOAD_TOO_LARGE",
      413,
      "同步请求超过 2 MiB 限制"
    )
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestBoundaryError(
      "INVALID_ENCODING",
      422,
      "同步请求不是合法 UTF-8"
    );
  }
}

export async function POST(request: NextRequest) {
  const id = requestId();
  try {
    syncPreAuthRateLimiter.consume("sync-batches");
    const { pool } = serverContext();
    const identity = await authenticateDevice({
      pool,
      authorization: request.headers.get("authorization"),
      tokenPepper: process.env.DEVICE_TOKEN_PEPPER
    });
    syncRateLimiter.consume(identity.deviceId);
    const body = await readBoundedJsonBody(request);
    const validated = validateIncomingBatch({
      body,
      idempotencyKey: request.headers.get("idempotency-key"),
      declaredPayloadHash: request.headers.get("x-payload-sha256")
    });
    const result = validated.payload.protocolVersion === 2
      ? await commitAgentSyncBatch({
          pool,
          identity,
          validated: { ...validated, payload: validated.payload },
          requestId: id
        })
      : await commitSyncBatch({
          pool,
          identity,
          validated: { ...validated, payload: validated.payload },
          requestId: id
        });
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error, id);
  }
}
