import {
  MAX_SYNC_BATCH_BODY_BYTES,
  SyncBatchRequestSchema,
  type SyncBatchRequest,
  type SyncEvent
} from "@ai-worklog/contracts";
import { sha256Hex } from "@ai-worklog/core";
import type { Outbox } from "./outbox.js";
import type { PromptConnector } from "./prompt-connector.js";

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
  batchId: string | null;
  payloadSha256: string | null;
  eventCount: number;
  inserted: boolean;
  batchCount: number;
  insertedCount: number;
}

interface PreparedBatch {
  batchId: string;
  createdAt: string;
  payloadJson: string;
  payloadSha256: string;
  eventCount: number;
}

function buildBatch(
  connector: PromptConnector,
  events: readonly SyncEvent[]
): PreparedBatch {
  const createdAt = events
    .map((event) => event.occurredAt)
    .sort()[0] ?? new Date(0).toISOString();
  const source = {
    type: connector.sourceType,
    instanceId: connector.sourceInstanceId,
    parserVersion: connector.parserVersion
  };
  // Namespace the complete envelope separately from legacy batch-v1 IDs. A
  // parser upgrade can change payload metadata without reusing an old ID.
  const batchId = sha256Hex([
    "batch-v2",
    canonicalJson({
      protocolVersion: 1,
      createdAt,
      source,
      events
    })
  ].join("\u001f"));
  const payload: SyncBatchRequest = SyncBatchRequestSchema.parse({
    protocolVersion: 1,
    batchId,
    createdAt,
    source,
    events
  });
  const payloadJson = canonicalJson(payload);
  return {
    batchId,
    createdAt,
    payloadJson,
    payloadSha256: sha256Hex(payloadJson),
    eventCount: events.length
  };
}

export async function prepareFile(options: {
  connector: PromptConnector;
  outbox: Outbox;
  filePath: string;
}): Promise<PrepareResult> {
  const session = await options.connector.readFile(options.filePath);
  if (session.events.length === 0) {
    return {
      batchId: null,
      payloadSha256: null,
      eventCount: 0,
      inserted: false,
      batchCount: 0,
      insertedCount: 0
    };
  }

  const preparedBatches: Array<{
    batchId: string;
    payloadSha256: string;
    inserted: boolean;
  }> = [];
  let offset = 0;
  while (offset < session.events.length) {
    let low = offset + 1;
    let high = Math.min(offset + MAX_BATCH_EVENTS, session.events.length);
    let selected: PreparedBatch | null = null;

    // Payload size is monotonic as events are appended. Binary search keeps
    // preparation efficient while enforcing the API's exact UTF-8 body limit.
    while (low <= high) {
      const end = Math.floor((low + high) / 2);
      const candidate = buildBatch(
        options.connector,
        session.events.slice(offset, end)
      );
      if (Buffer.byteLength(candidate.payloadJson, "utf8") <= MAX_SYNC_BATCH_BODY_BYTES) {
        selected = candidate;
        low = end + 1;
      } else {
        high = end - 1;
      }
    }
    if (!selected) {
      throw new Error("A single event exceeds the sync request size limit");
    }

    const inserted = options.outbox.enqueue({
      batchId: selected.batchId,
      createdAt: selected.createdAt,
      payloadJson: selected.payloadJson,
      payloadSha256: selected.payloadSha256
    });
    preparedBatches.push({
      batchId: selected.batchId,
      payloadSha256: selected.payloadSha256,
      inserted
    });
    offset += selected.eventCount;
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
