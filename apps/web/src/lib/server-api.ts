import { getPool } from "@ai-worklog/db/client";
import { parseServerIdentity } from "@ai-worklog/server";
import { NextResponse } from "next/server";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

let environmentLoaded = false;

function loadEnvironmentOnce(): void {
  if (environmentLoaded) return;
  environmentLoaded = true;
  const candidates = [
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), "../../.env.local")
  ];
  for (const candidate of candidates) {
    try {
      loadEnvFile(candidate);
      return;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
}

export function serverContext() {
  loadEnvironmentOnce();
  return { pool: getPool(), ...parseServerIdentity() };
}

function knownError(error: unknown): {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
} | null {
  if (!error || typeof error !== "object") return null;
  const value = error as Record<string, unknown>;
  if (
    typeof value.status !== "number" ||
    typeof value.code !== "string" ||
    typeof value.message !== "string"
  ) {
    return null;
  }
  return {
    status: value.status,
    code: value.code,
    message: value.message,
    retryable: value.status === 429 || value.status >= 500,
    retryAfterSeconds:
      typeof value.retryAfterSeconds === "number" &&
      Number.isFinite(value.retryAfterSeconds) &&
      value.retryAfterSeconds > 0
        ? Math.ceil(value.retryAfterSeconds)
        : null
  };
}

export function safeErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{3,64}$/.test(error.code)
  ) {
    return error.code;
  }
  return "INTERNAL_ERROR";
}

export function apiError(error: unknown, requestId: string): NextResponse {
  const known = knownError(error);
  if (known) {
    const response = NextResponse.json(
      {
        error: {
          code: known.code,
          message: known.message,
          retryable: known.retryable,
          requestId
        }
      },
      { status: known.status }
    );
    if (known.retryAfterSeconds !== null) {
      response.headers.set("Retry-After", String(known.retryAfterSeconds));
    }
    return response;
  }
  if (error instanceof Error && error.message.startsWith("Invalid ")) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_QUERY",
          message: "查询参数无效",
          retryable: false,
          requestId
        }
      },
      { status: 400 }
    );
  }
  return NextResponse.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "服务暂时不可用，请稍后重试",
        retryable: true,
        requestId
      }
    },
    { status: 500 }
  );
}

export function requestId(): string {
  return crypto.randomUUID();
}
