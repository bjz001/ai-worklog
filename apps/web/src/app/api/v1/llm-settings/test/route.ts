import {
  getRuntimeLlmSettings,
  llmConnectionTestRateLimiter,
  parseLlmEncryptionKey,
  testLlmConnection
} from "@ai-worklog/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonMutation } from "@/lib/mutation-security";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const id = requestId();
  try {
    const body = await readJsonMutation(request);
    z.object({}).strict().parse(body);
    const { pool, accountId } = serverContext();
    llmConnectionTestRateLimiter.consume(accountId);
    const settings = await getRuntimeLlmSettings({
      pool,
      accountId,
      masterKey: parseLlmEncryptionKey()
    });
    const result = await testLlmConnection({ settings });
    return NextResponse.json({
      data: {
        ok: true,
        provider: settings.provider,
        model: settings.model,
        latencyMs: result.latencyMs
      }
    });
  } catch (error) {
    return apiError(error, id);
  }
}
