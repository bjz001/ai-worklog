export class RateLimitError extends Error {
  readonly code = "RATE_LIMITED";
  readonly status = 429;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("请求过于频繁，请稍后重试");
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface WindowState {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter {
  private readonly states = new Map<string, WindowState>();

  constructor(
    private readonly options: {
      limit: number;
      windowMs: number;
      maxKeys?: number;
    }
  ) {}

  consume(key: string, now = Date.now()): void {
    const current = this.states.get(key);
    if (!current || current.resetAt <= now) {
      if (this.states.size >= (this.options.maxKeys ?? 10_000)) {
        for (const [candidate, state] of this.states) {
          if (state.resetAt <= now) this.states.delete(candidate);
        }
      }
      this.states.set(key, { count: 1, resetAt: now + this.options.windowMs });
      return;
    }
    if (current.count >= this.options.limit) {
      throw new RateLimitError(Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
    }
    current.count += 1;
  }
}

export const syncRateLimiter = new InMemoryRateLimiter({
  limit: 60,
  windowMs: 60_000,
  maxKeys: 10_000
});

// A per-process circuit breaker before token lookup. Source-IP limits belong at
// the trusted reverse proxy because forwarding headers are spoofable in-app.
export const syncPreAuthRateLimiter = new InMemoryRateLimiter({
  limit: 300,
  windowMs: 60_000,
  maxKeys: 1
});

// Connection tests make a billable upstream request. Keep accidental double
// clicks or scripted abuse bounded independently for each dashboard account.
export const llmConnectionTestRateLimiter = new InMemoryRateLimiter({
  limit: 5,
  windowMs: 60_000,
  maxKeys: 1_000
});
