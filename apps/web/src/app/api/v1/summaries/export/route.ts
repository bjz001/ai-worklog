import { WorkDateSchema } from "@ai-worklog/contracts";
import {
  dailySummaryExportFilename,
  getSummaryForDate,
  renderDailySummaryMarkdown
} from "@ai-worklog/server";
import { NextRequest, NextResponse } from "next/server";

import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class SummaryExportRouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "SummaryExportRouteError";
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
    const parsed = WorkDateSchema.safeParse(
      request.nextUrl.searchParams.get("date")
    );
    if (!parsed.success) {
      throw new SummaryExportRouteError(
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
    if (!summary) {
      throw new SummaryExportRouteError(
        "SUMMARY_NOT_FOUND",
        404,
        "尚未生成该日总结"
      );
    }
    return markdownResponse(
      renderDailySummaryMarkdown(summary),
      dailySummaryExportFilename(summary)
    );
  } catch (error) {
    return exportError(error, id);
  }
}
