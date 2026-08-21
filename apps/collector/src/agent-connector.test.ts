import { describe, expect, it } from "vitest";
import { sha256Hex } from "@ai-worklog/core";
import { AgentCaptureBuilder, splitUtf8Text } from "./agent-connector.js";

describe("AgentCaptureBuilder", () => {
  it("preserves complete unredacted raw and searchable text across UTF-8 chunks", () => {
    const text = `FAKE_SECRET_CANARY=sk-live-preserve\n${"界\u0000".repeat(180_000)}`;
    const builder = new AgentCaptureBuilder({
      accountId: "account-1",
      deviceId: "device-1",
      sourceType: "CODEX",
      sourceInstanceId: "codex-device-1",
      parserVersion: "codex-agent-jsonl-v1",
      sourceSessionId: "session-1",
      startedAt: "2026-08-21T10:00:00.000Z",
      sourceTimeZone: "UTC"
    });

    const event = builder.addEvent({
      sourceEventId: "message-1",
      sequence: 1,
      kind: "USER",
      occurredAt: "2026-08-21T10:00:01.000Z",
      renderedText: text,
      rawPayload: JSON.stringify({ text })
    });
    const capture = builder.finish();
    const rendered = capture.records.filter(
      (record) => record.recordType === "TEXT_SEGMENT" &&
        record.eventId === event.eventId && record.purpose === "RENDERED_CONTENT"
    );

    expect(rendered.length).toBeGreaterThan(1);
    expect(rendered.map((segment) => segment.recordType === "TEXT_SEGMENT"
      ? segment.text
      : "").join("")).toBe(text);
    expect(rendered.every((segment) => segment.recordType === "TEXT_SEGMENT" &&
      segment.groupSha256 === sha256Hex(text))).toBe(true);
    expect(JSON.stringify(capture)).toContain("sk-live-preserve");
    expect(JSON.stringify(capture)).not.toContain("[REDACTED]");
  });

  it("never splits a Unicode code point or drops empty content", () => {
    expect(splitUtf8Text("", 4)).toEqual([""]);
    expect(splitUtf8Text("A🚀界", 4)).toEqual(["A", "🚀", "界"]);
  });

  it("marks source-unexposed content explicitly instead of inventing text", () => {
    const builder = new AgentCaptureBuilder({
      accountId: "account-1",
      deviceId: "device-1",
      sourceType: "CODEX",
      sourceInstanceId: "codex-device-1",
      parserVersion: "codex-agent-jsonl-v1",
      sourceSessionId: "session-2",
      startedAt: "2026-08-21T10:00:00.000Z",
      sourceTimeZone: "UTC",
      rawCaptureStatus: "PARTIAL",
      normalizedCoverage: "PARTIAL",
      missingReason: "Source omitted hidden reasoning"
    });

    builder.addEvent({
      sourceEventId: "hidden-reasoning",
      sequence: 1,
      kind: "REASONING",
      occurredAt: "2026-08-21T10:00:01.000Z",
      rawCaptureStatus: "NOT_EXPOSED",
      normalizedCoverage: "NONE",
      missingReason: "Source did not expose reasoning content"
    });
    const capture = builder.finish();

    expect(capture.records.some((record) =>
      record.recordType === "TEXT_SEGMENT"
    )).toBe(false);
    expect(capture.records.find((record) =>
      record.recordType === "EVENT"
    )).toMatchObject({
      rawCaptureStatus: "NOT_EXPOSED",
      missingReason: "Source did not expose reasoning content"
    });
  });
});
