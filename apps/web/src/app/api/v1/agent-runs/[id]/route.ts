import { getAgentRunDetail } from "@ai-worklog/server";
import { NextRequest, NextResponse } from "next/server";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function runId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) throw new Error("Invalid run id");
  return value;
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const id = requestId();
  try {
    const { pool, accountId } = serverContext();
    const params = await context.params;
    return NextResponse.json(await getAgentRunDetail({
      pool,
      accountId,
      runId: runId(params.id)
    }));
  } catch (error) {
    return apiError(error, id);
  }
}
