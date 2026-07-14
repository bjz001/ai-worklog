import { RateLimitError } from "@ai-worklog/server";
import { describe, expect, it } from "vitest";
import { apiError } from "./server-api";

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
});
