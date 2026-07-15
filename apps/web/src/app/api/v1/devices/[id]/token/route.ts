import { DeviceTokenRotateSchema } from "@ai-worklog/contracts";
import {
  DeviceServiceError,
  deviceMutationRateLimiter,
  rotateDeviceEnrollmentToken
} from "@ai-worklog/server";
import { NextRequest, NextResponse } from "next/server";
import { readJsonMutation } from "@/lib/mutation-security";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const requestIdentifier = requestId();
  try {
    const raw = await readJsonMutation(request);
    const parsed = DeviceTokenRotateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DeviceServiceError(
        "INVALID_DEVICE_TOKEN_ROTATION",
        422,
        "凭证轮换请求格式无效"
      );
    }
    const { id } = await context.params;
    const { pool, accountId } = serverContext();
    deviceMutationRateLimiter.consume(accountId);
    const data = await rotateDeviceEnrollmentToken({
      pool,
      accountId,
      deviceId: id,
      tokenPepper: process.env.DEVICE_TOKEN_PEPPER,
      appBaseUrl: process.env.APP_BASE_URL
    });
    const response = NextResponse.json({ data });
    response.headers.set("Cache-Control", "no-store, private");
    response.headers.set("Pragma", "no-cache");
    return response;
  } catch (error) {
    return apiError(error, requestIdentifier);
  }
}
