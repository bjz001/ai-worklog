import { sha256Hex } from "@ai-worklog/core";
import { describe, expect, it } from "vitest";
import {
  UnsafeEventContentError,
  validateSanitizedEvents
} from "./input-security";

function event(
  content: string,
  contentHash = sha256Hex(content),
  metadata: Record<string, unknown> = {}
) {
  return {
    eventId: "a".repeat(64),
    kind: "USER_PROMPT" as const,
    sourceSessionId: "session-1",
    messageIndex: 0,
    occurredAt: "2026-07-14T08:00:00.000Z",
    sourceTimeZone: "Asia/Shanghai",
    sanitizedContent: content,
    contentHash,
    redactionVersion: "core-v1",
    metadata
  };
}

describe("validateSanitizedEvents", () => {
  it("accepts content that is already redacted and hash-consistent", () => {
    expect(() =>
      validateSanitizedEvents([event("password=[REDACTED]")])
    ).not.toThrow();
  });

  it("rejects a mismatched content digest", () => {
    expect(() =>
      validateSanitizedEvents([event("safe content", "b".repeat(64))])
    ).toThrow(UnsafeEventContentError);
  });

  it("rejects secrets missed by a collector before any database write", () => {
    expect(() =>
      validateSanitizedEvents([event("api_key=FAKE_TEST_SECRET_CANARY_1234567890")])
    ).toThrow("not fully redacted");
  });

  it("rejects secrets and unknown fields hidden in metadata", () => {
    expect(() =>
      validateSanitizedEvents([
        event("safe", undefined, { model: "password=hunter2-secret" })
      ])
    ).toThrow("metadata");
    expect(() =>
      validateSanitizedEvents([
        event("safe", undefined, { arbitrary: { token: "secret" } })
      ])
    ).toThrow("metadata");
  });

  it("rejects an invalid source time zone before it can break date views", () => {
    expect(() =>
      validateSanitizedEvents([
        { ...event("safe"), sourceTimeZone: "Not/A-Time-Zone" }
      ])
    ).toThrow("time zone");
  });
});
