import { PeriodSummaryRequestSchema } from "@ai-worklog/contracts";
import {
  getPeriodSummary,
  periodSummaryExportFilename,
  renderPeriodSummaryMarkdown
} from "@ai-worklog/server";
import { NextRequest, NextResponse } from "next/server";

import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class PeriodSummaryExportRouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "PeriodSummaryExportRouteError";
    this.code = code;
    this.status = status;
  }
}

function safeAttachmentFilename(filename: string): string {
  return /^[a-z0-9][a-z0-9.-]{0,127}$/.test(filename)
    ? filename
    : "ai-worklog-summary.md";
}

function markdownResponse(markdown: string, filename: string): NextResponse {
  return new NextResponse(markdown, {
    status: 200,
    headers: {
      "Cache-Control": "no-store, private",
      "Content-Disposition": `attachment; filename="${safeAttachmentFilename(filename)}"`,
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function exportError(error: unknown, id: string): NextResponse {
  const response = apiError(error, id);
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export async function GET(request: NextRequest) {
  const id = requestId();
  try {
    const parsed = PeriodSummaryRequestSchema.safeParse({
      periodType: request.nextUrl.searchParams.get("periodType"),
      periodStart: request.nextUrl.searchParams.get("periodStart")
    });
    if (!parsed.success) {
      throw new PeriodSummaryExportRouteError(
        "INVALID_PERIOD_SUMMARY_REQUEST",
        400,
        "总结周期格式无效"
      );
    }
    const { pool, accountId } = serverContext();
    const summary = await getPeriodSummary({
      pool,
      accountId,
      ...parsed.data
    });
    if (!summary) {
      throw new PeriodSummaryExportRouteError(
        "PERIOD_SUMMARY_NOT_FOUND",
        404,
        "尚未生成该周期总结"
      );
    }
    return markdownResponse(
      renderPeriodSummaryMarkdown(summary),
      periodSummaryExportFilename(summary)
    );
  } catch (error) {
    return exportError(error, id);
  }
}
