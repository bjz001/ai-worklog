import { getCalendar, parseCalendarMonth } from "@ai-worklog/server";
import { NextRequest, NextResponse } from "next/server";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const id = requestId();
  try {
    const { pool, accountId } = serverContext();
    const month = parseCalendarMonth(request.nextUrl.searchParams.get("month"));
    return NextResponse.json(await getCalendar({ pool, accountId, month }));
  } catch (error) {
    return apiError(error, id);
  }
}
