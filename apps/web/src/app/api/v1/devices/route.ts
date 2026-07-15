import { DeviceCreateSchema } from "@ai-worklog/contracts";
import {
  DeviceServiceError,
  createDeviceEnrollment,
  deviceMutationRateLimiter
} from "@ai-worklog/server";
import { NextRequest, NextResponse } from "next/server";
import { readJsonMutation } from "@/lib/mutation-security";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function oneTimeCredentialResponse(data: unknown, status: number): NextResponse {
  const response = NextResponse.json({ data }, { status });
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export async function POST(request: NextRequest) {
  const id = requestId();
  try {
    const raw = await readJsonMutation(request);
    const parsed = DeviceCreateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DeviceServiceError(
        "INVALID_DEVICE",
        422,
        "设备配置格式无效"
      );
    }
    const { pool, accountId } = serverContext();
    deviceMutationRateLimiter.consume(accountId);
    const data = await createDeviceEnrollment({
      pool,
      accountId,
      input: parsed.data,
      tokenPepper: process.env.DEVICE_TOKEN_PEPPER,
      appBaseUrl: process.env.APP_BASE_URL
    });
    return oneTimeCredentialResponse(data, 201);
  } catch (error) {
    return apiError(error, id);
  }
}
