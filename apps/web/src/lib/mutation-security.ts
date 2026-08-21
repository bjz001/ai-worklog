import type { NextRequest } from "next/server";
import { readBoundedRequestBytes } from "./bounded-request-body";

const MAX_MUTATION_BODY_BYTES = 16 * 1024;

export class MutationSecurityError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "MutationSecurityError";
    this.code = code;
    this.status = status;
  }
}

function canonicalOrigin(appBaseUrl: string | undefined): string {
  if (!appBaseUrl) {
    throw new MutationSecurityError(
      "APP_BASE_URL_NOT_CONFIGURED",
      503,
      "APP_BASE_URL 尚未配置"
    );
  }
  try {
    return new URL(appBaseUrl).origin;
  } catch {
    throw new MutationSecurityError(
      "APP_BASE_URL_NOT_CONFIGURED",
      503,
      "APP_BASE_URL 配置无效"
    );
  }
}

export async function readJsonMutation(
  request: NextRequest,
  appBaseUrl: string | undefined = process.env.APP_BASE_URL
): Promise<unknown> {
  const origin = request.headers.get("origin");
  if (
    origin !== canonicalOrigin(appBaseUrl) ||
    request.headers.get("x-ai-worklog-request") !== "1"
  ) {
    throw new MutationSecurityError(
      "CSRF_CHECK_FAILED",
      403,
      "请求未通过同源安全校验"
    );
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new MutationSecurityError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "请求必须使用 application/json"
    );
  }
  const bytes = await readBoundedRequestBytes(
    request,
    MAX_MUTATION_BODY_BYTES,
    () => new MutationSecurityError(
      "PAYLOAD_TOO_LARGE",
      413,
      "请求体超过允许大小"
    )
  );
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(body) as unknown;
  } catch {
    throw new MutationSecurityError(
      "INVALID_JSON",
      400,
      "请求体不是有效的 JSON"
    );
  }
}
