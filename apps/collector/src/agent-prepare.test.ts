import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SYNC_BATCH_BODY_BYTES } from "@ai-worklog/contracts";
import { AgentCaptureBuilder } from "./agent-connector.js";
import { prepareAgentCapture } from "./agent-prepare.js";
import { Outbox } from "./outbox.js";

const open: Outbox[] = [];
afterEach(() => {
  for (const outbox of open.splice(0)) outbox.close();
});

describe("prepareAgentCapture", () => {
  it("queues event identity before lossless text continuation batches", () => {
    const outbox = new Outbox(join(
      mkdtempSync(join(tmpdir(), "agent-prepare-")),
      "collector.sqlite"
    ));
    open.push(outbox);
    const builder = new AgentCaptureBuilder({
      accountId: "account-1",
      deviceId: "device-1",
      sourceType: "CLAUDE_CODE",
      sourceInstanceId: "claude-device-1",
      parserVersion: "claude-agent-jsonl-v1",
      sourceSessionId: "session-large",
      startedAt: "2026-08-21T10:00:00.000Z",
      sourceTimeZone: "UTC"
    });
    const raw = `sk-live-FAKE-NOT-REDACTED\n${"完整轨迹".repeat(400_000)}`;
    builder.addEvent({
      sourceEventId: "message-1",
      sequence: 1,
      kind: "ASSISTANT",
      occurredAt: "2026-08-21T10:00:01.000Z",
      renderedText: raw,
      rawPayload: JSON.stringify({ raw })
    });

    const first = prepareAgentCapture({ capture: builder.finish(), outbox });
    const second = prepareAgentCapture({ capture: builder.finish(), outbox });
    const batches = outbox.listPending(100);
    const payloads = batches.map((batch) => JSON.parse(batch.payloadJson) as {
      protocolVersion: number;
      records: Array<{ recordType: string; text?: string }>;
    });

    expect(first.insertedCount).toBeGreaterThan(1);
    expect(second.insertedCount).toBe(0);
    expect(payloads[0]?.records.some((record) =>
      record.recordType === "RUN"
    )).toBe(true);
    expect(payloads[0]?.records.some((record) =>
      record.recordType === "EVENT"
    )).toBe(true);
    const firstTextBatch = payloads.findIndex((payload) =>
      payload.records.some((record) => record.recordType === "TEXT_SEGMENT")
    );
    expect(firstTextBatch).toBeGreaterThanOrEqual(1);
    expect(payloads.slice(0, firstTextBatch).every((payload) =>
      payload.records.every((record) => record.recordType !== "TEXT_SEGMENT")
    )).toBe(true);
    expect(batches.every((batch) =>
      Buffer.byteLength(batch.payloadJson, "utf8") <= MAX_SYNC_BATCH_BODY_BYTES
    )).toBe(true);
    expect(batches.map((batch) => batch.payloadJson).join(""))
      .toContain("sk-live-FAKE-NOT-REDACTED");
  });
});
