import { PeriodSummaryRequestSchema } from "@ai-worklog/contracts";
import {
  getPeriodActivity,
  getPeriodSummary,
  refreshPeriodInsights,
  summaryGenerationRateLimiter
} from "@ai-worklog/server";
import { NextRequest, NextResponse } from "next/server";

import { readJsonMutation } from "@/lib/mutation-security";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class PeriodSummaryRouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "PeriodSummaryRouteError";
    this.code = code;
    this.status = status;
  }
}

function noStoreJson(body: unknown, status = 200): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function parsePeriodQuery(request: NextRequest) {
  const parsed = PeriodSummaryRequestSchema.safeParse({
    periodType: request.nextUrl.searchParams.get("periodType"),
    periodStart: request.nextUrl.searchParams.get("periodStart")
  });
  if (!parsed.success) {
    throw new PeriodSummaryRouteError(
      "INVALID_PERIOD_SUMMARY_REQUEST",
      400,
      "总结周期格式无效"
    );
  }
  return parsed.data;
}

export async function GET(request: NextRequest) {
  const id = requestId();
  try {
    const input = parsePeriodQuery(request);
    const { pool, accountId } = serverContext();
    const [period, summary] = await Promise.all([
      getPeriodActivity({ pool, accountId, ...input }),
      getPeriodSummary({ pool, accountId, ...input })
    ]);
    return noStoreJson({
      data: {
        period,
        generationState: summary ? "ready" : "missing",
        summary
      }
    });
  } catch (error) {
    return apiError(error, id);
  }
}

export async function POST(request: NextRequest) {
  const id = requestId();
  try {
    const parsed = PeriodSummaryRequestSchema.safeParse(
      await readJsonMutation(request)
    );
    if (!parsed.success) {
      throw new PeriodSummaryRouteError(
        "INVALID_PERIOD_SUMMARY_REQUEST",
        422,
        "总结周期格式无效"
      );
    }
    const { pool, accountId } = serverContext();
    const period = await getPeriodActivity({
      pool,
      accountId,
      ...parsed.data
    });
    if (period.promptCount === 0) {
      throw new PeriodSummaryRouteError(
        "PERIOD_HAS_NO_ACTIVITY",
        422,
        "当前周期没有可总结的提示词"
      );
    }
    summaryGenerationRateLimiter.consume(accountId);
    const result = await refreshPeriodInsights({
      pool,
      accountId,
      ...parsed.data,
      regenerationKey: crypto.randomUUID()
    });
    if (result.promptCount === 0) {
      throw new PeriodSummaryRouteError(
        "PERIOD_HAS_NO_ACTIVITY",
        422,
        "当前周期没有可总结的提示词"
      );
    }
    if (!result.summaryId) {
      throw new PeriodSummaryRouteError(
        "PERIOD_HAS_NO_SUMMARIZABLE_EVIDENCE",
        422,
        "当前周期没有可用于生成总结的有效证据"
      );
    }
    const summary = await getPeriodSummary({
      pool,
      accountId,
      ...parsed.data
    });
    if (!summary) {
      throw new PeriodSummaryRouteError(
        "PERIOD_SUMMARY_NOT_AVAILABLE",
        500,
        "总结生成后暂时无法读取"
      );
    }
    return noStoreJson({
      data: {
        period,
        generationState: "ready",
        summary,
        generated: result.generated
      }
    });
  } catch (error) {
    return apiError(error, id);
  }
}
