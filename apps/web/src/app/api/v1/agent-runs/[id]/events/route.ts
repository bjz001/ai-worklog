import { listAgentEvents, parseAgentEventQuery } from "@ai-worklog/server";
import { NextRequest, NextResponse } from "next/server";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function runId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) throw new Error("Invalid run id");
  return value;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const id = requestId();
  try {
    const { pool, accountId } = serverContext();
    const params = await context.params;
    const query = parseAgentEventQuery(request.nextUrl.searchParams);
    return NextResponse.json(await listAgentEvents({
      pool,
      accountId,
      runId: runId(params.id),
      query
    }));
  } catch (error) {
    return apiError(error, id);
  }
}
