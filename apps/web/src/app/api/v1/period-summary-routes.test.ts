import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  getActivity: vi.fn(),
  getSummary: vi.fn(),
  readJsonMutation: vi.fn(),
  refresh: vi.fn(),
  serverContext: vi.fn()
}));

vi.mock("@ai-worklog/server", () => ({
  getPeriodActivity: mocks.getActivity,
  getPeriodSummary: mocks.getSummary,
  refreshPeriodInsights: mocks.refresh,
  summaryGenerationRateLimiter: { consume: mocks.consume }
}));

vi.mock("@/lib/mutation-security", () => ({
  readJsonMutation: mocks.readJsonMutation
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

import { GET, POST } from "./period-summaries/route";

const activity = {
  periodType: "WEEK",
  periodStart: "2026-07-13",
  periodEnd: "2026-07-19",
  promptCount: 12,
  projectCount: 3,
  activeDayCount: 4
};

const summary = {
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

describe("period summary routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.serverContext.mockReturnValue({
      pool: { getConnection: vi.fn() },
      accountId: "account_demo"
    });
    mocks.getActivity.mockResolvedValue(activity);
    mocks.getSummary.mockResolvedValue(summary);
    mocks.readJsonMutation.mockResolvedValue({
      periodType: "WEEK",
      periodStart: "2026-07-13"
    });
    mocks.refresh.mockResolvedValue({
      generated: true,
      summaryId: "period-1",
      promptCount: activity.promptCount
    });
  });

  it("returns activity and the saved summary for a canonical period", async () => {
    const response = await GET(new NextRequest(
      "http://172.18.209.21:3000/api/v1/period-summaries?periodType=WEEK&periodStart=2026-07-13"
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({
      data: { period: activity, generationState: "ready", summary }
    });
    expect(mocks.getActivity).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_demo",
      periodType: "WEEK",
      periodStart: "2026-07-13"
    }));
  });

  it("returns a missing state without generating an LLM summary", async () => {
    mocks.getSummary.mockResolvedValue(null);

    const response = await GET(new NextRequest(
      "http://172.18.209.21:3000/api/v1/period-summaries?periodType=WEEK&periodStart=2026-07-13"
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { period: activity, generationState: "missing", summary: null }
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("rejects a zero-evidence period before rate limiting or LLM generation", async () => {
    mocks.getActivity.mockResolvedValue({ ...activity, promptCount: 0 });

    const response = await POST(new NextRequest(
      "http://172.18.209.21:3000/api/v1/period-summaries",
      { method: "POST" }
    ));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PERIOD_HAS_NO_ACTIVITY" }
    });
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("runs an explicitly rate-limited period regeneration", async () => {
    const response = await POST(new NextRequest(
      "http://172.18.209.21:3000/api/v1/period-summaries",
      { method: "POST" }
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        period: activity,
        generationState: "ready",
        summary,
        generated: true
      }
    });
    expect(mocks.consume).toHaveBeenCalledWith("account_demo");
    expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_demo",
      periodType: "WEEK",
      periodStart: "2026-07-13",
      regenerationKey: expect.any(String)
    }));
  });

  it("returns a clear error when stored prompts have no summarizable evidence", async () => {
    mocks.refresh.mockResolvedValue({
      generated: false,
      summaryId: null,
      promptCount: activity.promptCount
    });
    mocks.getSummary.mockResolvedValue(null);

    const response = await POST(new NextRequest(
      "http://172.18.209.21:3000/api/v1/period-summaries",
      { method: "POST" }
    ));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PERIOD_HAS_NO_SUMMARIZABLE_EVIDENCE" }
    });
  });

  it("rejects a non-Monday weekly period at the API boundary", async () => {
    const response = await GET(new NextRequest(
      "http://172.18.209.21:3000/api/v1/period-summaries?periodType=WEEK&periodStart=2026-07-14"
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_PERIOD_SUMMARY_REQUEST" }
    });
    expect(mocks.getActivity).not.toHaveBeenCalled();
    expect(mocks.getSummary).not.toHaveBeenCalled();
  });
});
