import { SyncBatchRequestSchema, type SyncBatchRequest } from "@ai-worklog/contracts";
import { sha256Hex } from "@ai-worklog/core";
import type { CodexConnector } from "./codex-connector.js";
import type { Outbox } from "./outbox.js";

const MAX_BATCH_EVENTS = 200;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

export interface PrepareResult {
  batchId: string;
  payloadSha256: string;
  eventCount: number;
  inserted: boolean;
  batchCount: number;
  insertedCount: number;
}

export async function prepareFile(options: {
  connector: CodexConnector;
  outbox: Outbox;
  filePath: string;
}): Promise<PrepareResult> {
  const session = await options.connector.readFile(options.filePath);
  if (session.events.length === 0) throw new Error("Codex source contains no supported messages");

  const preparedBatches: Array<{
    batchId: string;
    payloadSha256: string;
    inserted: boolean;
  }> = [];
  for (let offset = 0; offset < session.events.length; offset += MAX_BATCH_EVENTS) {
    const events = session.events.slice(offset, offset + MAX_BATCH_EVENTS);
    const eventIdentity = events
      .map((event) => `${event.eventId}:${event.contentHash}`)
      .join("\u001f");
    const batchId = sha256Hex([
      "batch-v1",
      options.connector.sourceType,
      options.connector.sourceInstanceId,
      eventIdentity
    ].join("\u001f"));
    const createdAt = events
      .map((event) => event.occurredAt)
      .sort()[0] ?? new Date(0).toISOString();
    const payload: SyncBatchRequest = SyncBatchRequestSchema.parse({
      protocolVersion: 1,
      batchId,
      createdAt,
      source: {
        type: options.connector.sourceType,
        instanceId: options.connector.sourceInstanceId,
        parserVersion: options.connector.parserVersion
      },
      events
    });
    const payloadJson = canonicalJson(payload);
    const payloadSha256 = sha256Hex(payloadJson);
    const inserted = options.outbox.enqueue({
      batchId,
      createdAt,
      payloadJson,
      payloadSha256
    });
    preparedBatches.push({ batchId, payloadSha256, inserted });
  }

  const firstBatch = preparedBatches[0];
  if (!firstBatch) throw new Error("No batch was prepared");
  const insertedCount = preparedBatches.filter((batch) => batch.inserted).length;

  return {
    batchId: firstBatch.batchId,
    payloadSha256: firstBatch.payloadSha256,
    eventCount: session.events.length,
    inserted: insertedCount > 0,
    batchCount: preparedBatches.length,
    insertedCount
  };
}
