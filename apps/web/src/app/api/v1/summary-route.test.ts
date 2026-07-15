import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  getSummary: vi.fn(),
  readJsonMutation: vi.fn(),
  refresh: vi.fn(),
  serverContext: vi.fn()
}));

vi.mock("@ai-worklog/server", () => ({
  getSummaryForDate: mocks.getSummary,
  refreshDailyInsights: mocks.refresh,
  summaryGenerationRateLimiter: { consume: mocks.consume }
}));

vi.mock("@/lib/mutation-security", () => ({
  readJsonMutation: mocks.readJsonMutation
}));

vi.mock("@/lib/server-api", () => ({
  apiError: vi.fn(() =>
    NextResponse.json({ error: { code: "TEST" } }, { status: 500 })
  ),
  requestId: vi.fn(() => "request-test"),
  serverContext: mocks.serverContext
}));

import { GET, POST } from "./summaries/route";

const summary = {
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

describe("summary routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.serverContext.mockReturnValue({
      pool: { getConnection: vi.fn() },
      accountId: "account_demo"
    });
    mocks.getSummary.mockResolvedValue(summary);
    mocks.readJsonMutation.mockResolvedValue({ workDate: "2026-07-15" });
    mocks.refresh.mockResolvedValue({ generated: true });
  });

  it("returns the complete summary for one valid work date", async () => {
    const response = await GET(new NextRequest(
      "http://172.18.209.21:3000/api/v1/summaries?date=2026-07-15"
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { summary } });
    expect(mocks.getSummary).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_demo",
      workDate: "2026-07-15"
    }));
  });

  it("runs an explicitly rate-limited LLM regeneration", async () => {
    const response = await POST(new NextRequest(
      "http://172.18.209.21:3000/api/v1/summaries",
      { method: "POST" }
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { summary, generated: true }
    });
    expect(mocks.consume).toHaveBeenCalledWith("account_demo");
    expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_demo",
      workDate: "2026-07-15",
      regenerationKey: expect.any(String)
    }));
  });
});
