import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dailyFilename: vi.fn(() => "ai-worklog-daily-2026-07-15.md"),
  getPeriodSummary: vi.fn(),
  getSummary: vi.fn(),
  periodFilename: vi.fn(() => "ai-worklog-week-2026-07-13.md"),
  renderDaily: vi.fn(() => "# daily\n"),
  renderPeriod: vi.fn(() => "# weekly\n"),
  serverContext: vi.fn()
}));

vi.mock("@ai-worklog/server", () => ({
  dailySummaryExportFilename: mocks.dailyFilename,
  getPeriodSummary: mocks.getPeriodSummary,
  getSummaryForDate: mocks.getSummary,
  periodSummaryExportFilename: mocks.periodFilename,
  renderDailySummaryMarkdown: mocks.renderDaily,
  renderPeriodSummaryMarkdown: mocks.renderPeriod
}));

vi.mock("@/lib/server-api", () => ({
  apiError: vi.fn((error: unknown, requestId: string) => {
    const value = error as { code?: string; message?: string; status?: number };
    return NextResponse.json(
      {
        error: {
          code: value.code ?? "INTERNAL_ERROR",
          message: value.message ?? "error",
          retryable: false,
          requestId
        }
      },
      { status: value.status ?? 500 }
    );
  }),
  requestId: vi.fn(() => "request-test"),
  serverContext: mocks.serverContext
}));

import { GET as exportPeriodSummary } from "./period-summaries/export/route";
import { GET as exportDailySummary } from "./summaries/export/route";

const dailySummary = {
  id: "summary-1",
  workDate: "2026-07-15",
  status: "complete",
  highlights: [],
  projectProgress: [],
  decisions: [],
  blockers: [],
  nextActions: [],
  completenessNote: "数据完整。",
  evidence: []
};

const periodSummary = {
  id: "period-1",
  periodType: "WEEK",
  periodStart: "2026-07-13",
  periodEnd: "2026-07-19",
  dataCompleteness: "complete",
  hasContent: true,
  inputTruncated: false,
  overview: [],
  majorAccomplishments: [],
  projectProgress: [],
  decisions: [],
  blockers: [],
  nextFocus: [],
  completenessNote: "数据完整。",
  evidence: []
};

describe("summary export routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.serverContext.mockReturnValue({
      pool: { execute: vi.fn() },
      accountId: "account_demo"
    });
    mocks.getSummary.mockResolvedValue(dailySummary);
    mocks.getPeriodSummary.mockResolvedValue(periodSummary);
  });

  it("downloads only a saved daily summary as UTF-8 Markdown", async () => {
    const response = await exportDailySummary(new NextRequest(
      "http://172.18.209.21:3000/api/v1/summaries/export?date=2026-07-15"
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8"
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="ai-worklog-daily-2026-07-15.md"'
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.text()).resolves.toBe("# daily\n");
    expect(mocks.getSummary).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_demo",
      workDate: "2026-07-15"
    }));
  });

  it("returns 404 instead of generating a missing daily summary", async () => {
    mocks.getSummary.mockResolvedValue(null);

    const response = await exportDailySummary(new NextRequest(
      "http://172.18.209.21:3000/api/v1/summaries/export?date=2026-07-15"
    ));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SUMMARY_NOT_FOUND" }
    });
    expect(mocks.renderDaily).not.toHaveBeenCalled();
  });

  it("downloads only a saved weekly summary with a safe filename", async () => {
    const response = await exportPeriodSummary(new NextRequest(
      "http://172.18.209.21:3000/api/v1/period-summaries/export?periodType=WEEK&periodStart=2026-07-13"
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8"
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="ai-worklog-week-2026-07-13.md"'
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.text()).resolves.toBe("# weekly\n");
    expect(mocks.getPeriodSummary).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_demo",
      periodType: "WEEK",
      periodStart: "2026-07-13"
    }));
  });

  it("returns 404 instead of generating a missing period summary", async () => {
    mocks.getPeriodSummary.mockResolvedValue(null);

    const response = await exportPeriodSummary(new NextRequest(
      "http://172.18.209.21:3000/api/v1/period-summaries/export?periodType=WEEK&periodStart=2026-07-13"
    ));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PERIOD_SUMMARY_NOT_FOUND" }
    });
    expect(mocks.renderPeriod).not.toHaveBeenCalled();
  });

  it("rejects invalid period export input before reading a summary", async () => {
    const response = await exportPeriodSummary(new NextRequest(
      "http://172.18.209.21:3000/api/v1/period-summaries/export?periodType=MONTH&periodStart=2026-07-02"
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_PERIOD_SUMMARY_REQUEST" }
    });
    expect(mocks.getPeriodSummary).not.toHaveBeenCalled();
  });
});
