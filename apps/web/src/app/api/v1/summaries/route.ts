import {
  SummaryGenerationRequestSchema,
  WorkDateSchema
} from "@ai-worklog/contracts";
import {
  getSummaryForDate,
  refreshDailyInsights,
  summaryGenerationRateLimiter
} from "@ai-worklog/server";
import { NextRequest, NextResponse } from "next/server";

import { readJsonMutation } from "@/lib/mutation-security";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class SummaryRouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "SummaryRouteError";
    this.code = code;
    this.status = status;
  }
}

function noStoreJson(body: unknown, status = 200): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: NextRequest) {
  const id = requestId();
  try {
    const parsed = WorkDateSchema.safeParse(
      request.nextUrl.searchParams.get("date")
    );
    if (!parsed.success) {
      throw new SummaryRouteError(
        "INVALID_WORK_DATE",
        400,
        "工作日期格式无效"
      );
    }
    const { pool, accountId } = serverContext();
    const summary = await getSummaryForDate({
      pool,
      accountId,
      workDate: parsed.data
    });
    return noStoreJson({ data: { summary } });
  } catch (error) {
    return apiError(error, id);
  }
}

export async function POST(request: NextRequest) {
  const id = requestId();
  try {
    const parsed = SummaryGenerationRequestSchema.safeParse(
      await readJsonMutation(request)
    );
    if (!parsed.success) {
      throw new SummaryRouteError(
        "INVALID_SUMMARY_REQUEST",
        422,
        "总结请求格式无效"
      );
    }
    const { pool, accountId } = serverContext();
    summaryGenerationRateLimiter.consume(accountId);
    const result = await refreshDailyInsights({
      pool,
      accountId,
      workDate: parsed.data.workDate,
      regenerationKey: crypto.randomUUID()
    });
    const summary = await getSummaryForDate({
      pool,
      accountId,
      workDate: parsed.data.workDate
    });
    if (!summary) {
      throw new SummaryRouteError(
        "SUMMARY_NOT_AVAILABLE",
        500,
        "总结生成后暂时无法读取"
      );
    }
    return noStoreJson({
      data: {
        summary,
        generated: result.generated
      }
    });
  } catch (error) {
    return apiError(error, id);
  }
}
