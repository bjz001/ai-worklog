import { RateLimitError } from "@ai-worklog/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError } from "./server-api";

afterEach(() => vi.restoreAllMocks());

describe("apiError", () => {
  it("returns Retry-After for bounded rate-limit recovery", async () => {
    const response = apiError(new RateLimitError(17), "request-1");
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(body.error).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      requestId: "request-1"
    });
  });

  it("logs only the controlled integrity reason and request ID", async () => {
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = apiError({
      status: 422,
      code: "AGENT_PAYLOAD_INTEGRITY_ERROR",
      message: "eventId 与来源事件身份不匹配"
    }, "request-integrity-1");

    expect(response.status).toBe(422);
    expect(errorOutput).toHaveBeenCalledWith(JSON.stringify({
      event: "ai-worklog-sync-integrity",
      code: "AGENT_PAYLOAD_INTEGRITY_ERROR",
      reason: "eventId 与来源事件身份不匹配",
      requestId: "request-integrity-1"
    }));
  });
});
