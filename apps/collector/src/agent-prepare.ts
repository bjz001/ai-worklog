import {
  AgentSyncBatchRequestSchema,
  MAX_AGENT_SYNC_RECORDS,
  MAX_SYNC_BATCH_BODY_BYTES,
  type AgentSyncBatchRequest,
  type AgentSyncRecord
} from "@ai-worklog/contracts";
import { sha256Hex } from "@ai-worklog/core";
import type { AgentCapture } from "./agent-connector.js";
import type { Outbox } from "./outbox.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

interface PreparedAgentBatch {
  batchId: string;
  createdAt: string;
  payloadJson: string;
  payloadSha256: string;
  recordCount: number;
}

function captureCreatedAt(capture: AgentCapture): string {
  const run = capture.records.find((record) => record.recordType === "RUN");
  if (run?.recordType === "RUN") return run.startedAt;
  const event = capture.records.find((record) => record.recordType === "EVENT");
  if (event?.recordType === "EVENT") return event.occurredAt;
  throw new Error("Agent capture has no run or event timestamp");
}

function buildBatch(
  capture: AgentCapture,
  records: readonly AgentSyncRecord[],
  createdAt: string
): PreparedAgentBatch {
  const source = {
    type: capture.sourceType,
    instanceId: capture.sourceInstanceId,
    parserVersion: capture.parserVersion
  };
  const batchId = sha256Hex([
    "agent-batch-v2",
    canonicalJson({ protocolVersion: 2, createdAt, source, records })
  ].join("\u001f"));
  const payload: AgentSyncBatchRequest = AgentSyncBatchRequestSchema.parse({
    protocolVersion: 2,
    batchId,
    createdAt,
    source,
    records
  });
  const payloadJson = canonicalJson(payload);
  return {
    batchId,
    createdAt,
    payloadJson,
    payloadSha256: sha256Hex(payloadJson),
    recordCount: records.length
  };
}

function orderedCaptureRecords(records: readonly AgentSyncRecord[]): AgentSyncRecord[] {
  const metadata = records.filter((record) => record.recordType !== "TEXT_SEGMENT");
  const text = records.filter((record) => record.recordType === "TEXT_SEGMENT");
  return [...metadata, ...text];
}

function prepareBatches(capture: AgentCapture): PreparedAgentBatch[] {
  const records = orderedCaptureRecords(capture.records);
  if (records.length === 0) return [];
  const createdAt = captureCreatedAt(capture);
  const batches: PreparedAgentBatch[] = [];
  let offset = 0;
  while (offset < records.length) {
    const recordType = records[offset]?.recordType;
    const isTextPhase = recordType === "TEXT_SEGMENT";
    let phaseEnd = offset;
    while (
      phaseEnd < records.length &&
      (records[phaseEnd]?.recordType === "TEXT_SEGMENT") === isTextPhase
    ) {
      phaseEnd += 1;
    }
    while (offset < phaseEnd) {
      let low = offset + 1;
      let high = Math.min(
        phaseEnd,
        offset + MAX_AGENT_SYNC_RECORDS
      );
      let selected: PreparedAgentBatch | null = null;
      while (low <= high) {
        const end = Math.floor((low + high) / 2);
        const candidate = buildBatch(capture, records.slice(offset, end), createdAt);
        if (
          Buffer.byteLength(candidate.payloadJson, "utf8") <=
          MAX_SYNC_BATCH_BODY_BYTES
        ) {
          selected = candidate;
          low = end + 1;
        } else {
          high = end - 1;
        }
      }
      if (!selected) {
        throw new Error("A single Agent record exceeds the sync request size limit");
      }
      batches.push(selected);
      offset += selected.recordCount;
    }
  }
  return batches;
}

export interface PrepareAgentCaptureResult {
  batchCount: number;
  insertedCount: number;
  eventCount: number;
  recordCount: number;
}

export function prepareAgentCapture(options: {
  capture: AgentCapture;
  outbox: Outbox;
}): PrepareAgentCaptureResult {
  const batches = prepareBatches(options.capture);
  let insertedCount = 0;
  for (const batch of batches) {
    if (options.outbox.enqueue({
      batchId: batch.batchId,
      createdAt: batch.createdAt,
      payloadJson: batch.payloadJson,
      payloadSha256: batch.payloadSha256
    })) {
      insertedCount += 1;
    }
  }
  return {
    batchCount: batches.length,
    insertedCount,
    eventCount: options.capture.records.filter(
      (record) => record.recordType === "EVENT"
    ).length,
    recordCount: options.capture.records.length
  };
}
