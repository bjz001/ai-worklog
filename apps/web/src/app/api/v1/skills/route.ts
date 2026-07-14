import { getSkillsResponse } from "@ai-worklog/server";
import { NextResponse } from "next/server";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const id = requestId();
  try {
    const { pool, accountId } = serverContext();
    return NextResponse.json(await getSkillsResponse(pool, accountId));
  } catch (error) {
    return apiError(error, id);
  }
}
