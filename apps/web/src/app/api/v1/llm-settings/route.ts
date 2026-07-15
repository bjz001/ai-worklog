import { LlmSettingsUpdateSchema } from "@ai-worklog/contracts";
import {
  LlmSettingsError,
  getLlmSettingsView,
  parseLlmEncryptionKey,
  saveLlmSettings
} from "@ai-worklog/server";
import { NextRequest, NextResponse } from "next/server";
import { readJsonMutation } from "@/lib/mutation-security";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const id = requestId();
  try {
    const { pool, accountId } = serverContext();
    return NextResponse.json({
      data: await getLlmSettingsView({ pool, accountId })
    });
  } catch (error) {
    return apiError(error, id);
  }
}

export async function PUT(request: NextRequest) {
  const id = requestId();
  try {
    const raw = await readJsonMutation(request);
    const parsed = LlmSettingsUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LlmSettingsError(
        "INVALID_LLM_SETTINGS",
        422,
        "LLM 配置格式无效"
      );
    }
    const { pool, accountId } = serverContext();
    const data = await saveLlmSettings({
      pool,
      accountId,
      input: parsed.data,
      masterKey: parseLlmEncryptionKey()
    });
    return NextResponse.json({ data });
  } catch (error) {
    return apiError(error, id);
  }
}
