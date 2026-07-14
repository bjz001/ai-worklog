import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter, RateLimitError } from "./rate-limit";

describe("InMemoryRateLimiter", () => {
  it("limits one device independently inside a fixed window", () => {
    const limiter = new InMemoryRateLimiter({ limit: 2, windowMs: 1_000 });
    limiter.consume("device-a", 100);
    limiter.consume("device-a", 200);
    expect(() => limiter.consume("device-a", 300)).toThrow(RateLimitError);
    expect(() => limiter.consume("device-b", 300)).not.toThrow();
    expect(() => limiter.consume("device-a", 1_101)).not.toThrow();
  });
});
