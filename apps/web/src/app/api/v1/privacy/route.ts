import { getPrivacyResponse } from "@ai-worklog/server";
import { NextResponse } from "next/server";
import { apiError, requestId } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const id = requestId();
  try {
    return NextResponse.json(getPrivacyResponse());
  } catch (error) {
    return apiError(error, id);
  }
}
