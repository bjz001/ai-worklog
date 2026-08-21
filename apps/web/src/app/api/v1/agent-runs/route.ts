import { listAgentRuns, parseAgentRunQuery } from "@ai-worklog/server";
import { NextRequest, NextResponse } from "next/server";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const id = requestId();
  try {
    const { pool, accountId } = serverContext();
    const query = parseAgentRunQuery(request.nextUrl.searchParams);
    return NextResponse.json(await listAgentRuns({ pool, accountId, query }));
  } catch (error) {
    return apiError(error, id);
  }
}
