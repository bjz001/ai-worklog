import type {
  AgentSyncBatchRequest,
  AgentSyncRecord,
  SyncBatchResult
} from "@ai-worklog/contracts";
import { SyncBatchResultSchema } from "@ai-worklog/contracts";
import { createHash } from "node:crypto";
import {
  buildAgentBlobReferenceId,
  buildAgentEventId,
  buildAgentRunId,
  buildAgentTextSegmentId,
  normalizeGitRemote,
  sha256Hex
} from "@ai-worklog/core";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket
} from "mysql2/promise";
import type { ValidatedIncomingV2Batch } from "@ai-worklog/sync";
import type { DeviceIdentity } from "./auth";
import {
  BatchConflictError,
  isRetryableTransactionError,
  lockActiveDeviceCredential,
  markSummaryDatesDirty
} from "./sync-service";
import { workDateInTimeZone } from "./presentation";

export class AgentPayloadIntegrityError extends Error {
  readonly code = "AGENT_PAYLOAD_INTEGRITY_ERROR";
  readonly status = 422;

  constructor(message = "Agent 轨迹身份或内容摘要不匹配") {
    super(message);
    this.name = "AgentPayloadIntegrityError";
  }
}

const RECORD_ORDER: Record<AgentSyncRecord["recordType"], number> = {
  RUN: 0,
  EVENT: 1,
  TEXT_SEGMENT: 2,
  BLOB_REFERENCE: 3
};

export function orderedAgentRecords(
  records: readonly AgentSyncRecord[]
): AgentSyncRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) =>
      RECORD_ORDER[left.record.recordType] - RECORD_ORDER[right.record.recordType] ||
      left.index - right.index
    )
    .map(({ record }) => record);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new AgentPayloadIntegrityError(`${label} 在批次内重复`);
  }
}

export function validateAgentBatchIntegrity(
  payload: AgentSyncBatchRequest,
  identity: Pick<DeviceIdentity, "accountId" | "deviceId">
): void {
  const runs = payload.records.filter((record) => record.recordType === "RUN");
  const events = payload.records.filter(
    (record) => record.recordType === "EVENT"
  );
  const segments = payload.records.filter(
    (record) => record.recordType === "TEXT_SEGMENT"
  );
  const references = payload.records.filter(
    (record) => record.recordType === "BLOB_REFERENCE"
  );

  assertUnique(runs.map((run) => run.runId), "runId");
  assertUnique(events.map((event) => event.eventId), "eventId");
  assertUnique(segments.map((segment) => segment.segmentId), "segmentId");
  assertUnique(references.map((reference) => reference.referenceId), "referenceId");

  const runById = new Map(runs.map((run) => [run.runId, run]));
  for (const run of runs) {
    const expectedRunId = buildAgentRunId({
      accountId: identity.accountId,
      deviceId: identity.deviceId,
      sourceType: payload.source.type,
      sourceInstanceId: payload.source.instanceId,
      sourceSessionId: run.sourceSessionId
    });
    if (run.runId !== expectedRunId) {
      throw new AgentPayloadIntegrityError("runId 与来源身份不匹配");
    }
  }

  const eventById = new Map(events.map((event) => [event.eventId, event]));
  for (const event of events) {
    const run = runById.get(event.runId);
    if (!run) continue;
    const expectedEventId = buildAgentEventId({
      accountId: identity.accountId,
      deviceId: identity.deviceId,
      sourceType: payload.source.type,
      sourceInstanceId: payload.source.instanceId,
      sourceSessionId: run.sourceSessionId,
      sourceEventId: event.sourceEventId,
      sequence: event.sequence
    });
    if (event.eventId !== expectedEventId) {
      throw new AgentPayloadIntegrityError("eventId 与来源事件身份不匹配");
    }
  }

  for (const segment of segments) {
    const byteLength = Buffer.byteLength(segment.text, "utf8");
    const contentSha256 = sha256Hex(segment.text);
    if (
      segment.byteLength !== byteLength ||
      segment.contentSha256 !== contentSha256
    ) {
      throw new AgentPayloadIntegrityError("正文长度或 SHA-256 不匹配");
    }
    const expectedSegmentId = buildAgentTextSegmentId({
      eventId: segment.eventId,
      ordinal: segment.ordinal,
      purpose: segment.purpose,
      contentSha256: segment.contentSha256,
      ...(segment.groupSha256 ? { groupSha256: segment.groupSha256 } : {})
    });
    if (segment.segmentId !== expectedSegmentId) {
      throw new AgentPayloadIntegrityError("segmentId 与正文身份不匹配");
    }
  }

  for (const reference of references) {
    const event = reference.eventId
      ? eventById.get(reference.eventId)
      : undefined;
    if (event && event.runId !== reference.runId) {
      throw new AgentPayloadIntegrityError("附件引用跨越了不同 run");
    }
    const expectedReferenceId = buildAgentBlobReferenceId({
      runId: reference.runId,
      eventId: reference.eventId,
      purpose: reference.purpose,
      requestedPath: reference.requestedPath
    });
    if (reference.referenceId !== expectedReferenceId) {
      throw new AgentPayloadIntegrityError("referenceId 与附件身份不匹配");
    }
  }
}

function stableDatabaseId(prefix: string, ...parts: string[]): string {
  const digest = sha256Hex([prefix, ...parts].join("\u001f"));
  return `${prefix}_${digest.slice(0, 64 - prefix.length - 1)}`;
}

function jsonValue(value: unknown): string {
  return JSON.stringify(value);
}

interface AgentSessionRow extends RowDataPacket {
  id: string;
  account_id: string;
  device_id: string;
  project_id: string | null;
  run_id: string;
  source_type: string;
  source_instance_id: string;
  source_session_id: string;
}

interface AgentEventRow extends RowDataPacket {
  id: string;
  session_id: string;
  project_id: string | null;
  event_id: string;
  source_event_id: string | null;
  sequence: number | null;
  kind: string;
  reply_to_event_id: string | null;
  mirror_of_event_id: string | null;
  occurred_at: Date;
  source_time_zone: string;
  content_hash: string | null;
  raw_payload_sha256: string | null;
  current_version: number;
  session_device_id: string;
  session_source_type: string;
  session_source_instance_id: string;
}

interface IdentifierRow extends RowDataPacket {
  id: string;
}

interface BlobIdentifierRow extends IdentifierRow {
  status: string;
  failure_reason: string | null;
}

interface AccountTimeZoneRow extends RowDataPacket {
  time_zone: string;
}

export interface AgentRecordMutationCounts {
  insertedCount: number;
  duplicateCount: number;
  changedCount: number;
}

function addMutation(
  counts: AgentRecordMutationCounts,
  result: ResultSetHeader
): void {
  if (result.affectedRows === 1) {
    counts.insertedCount += 1;
  } else if (result.affectedRows >= 2) {
    counts.changedCount += 1;
  } else {
    counts.duplicateCount += 1;
  }
}

function compatibleAgentKind(stored: string, incoming: string): boolean {
  return stored === incoming ||
    (stored === "USER_PROMPT" && incoming === "USER") ||
    (stored === "VISIBLE_RESULT" && incoming === "ASSISTANT");
}

async function loadSessionByRun(
  connection: Pick<PoolConnection, "execute">,
  identity: Pick<DeviceIdentity, "accountId" | "deviceId">,
  payload: AgentSyncBatchRequest,
  runId: string
): Promise<AgentSessionRow> {
  const [rows] = await connection.execute<AgentSessionRow[]>(
    `SELECT id, account_id, device_id, project_id, run_id, source_type,
            source_instance_id, source_session_id
       FROM sessions
      WHERE account_id = ? AND run_id = ?
      LIMIT 1`,
    [identity.accountId, runId]
  );
  const row = rows[0];
  if (
    !row ||
    row.device_id !== identity.deviceId ||
    row.source_type !== payload.source.type ||
    row.source_instance_id !== payload.source.instanceId
  ) {
    throw new AgentPayloadIntegrityError("run 不存在或不属于当前设备");
  }
  return row;
}

async function loadEventByIdentity(
  connection: Pick<PoolConnection, "execute">,
  identity: Pick<DeviceIdentity, "accountId" | "deviceId">,
  payload: Pick<AgentSyncBatchRequest, "source">,
  eventId: string,
  forUpdate = false
): Promise<AgentEventRow> {
  const [rows] = await connection.execute<AgentEventRow[]>(
    `SELECT ce.id, ce.session_id, ce.project_id, ce.event_id,
            ce.source_event_id, ce.sequence, ce.kind, ce.reply_to_event_id,
            ce.mirror_of_event_id, ce.occurred_at, ce.source_time_zone,
            ce.content_hash, ce.raw_payload_sha256, ce.current_version,
            s.device_id AS session_device_id,
            s.source_type AS session_source_type,
            s.source_instance_id AS session_source_instance_id
       FROM collected_events ce
       JOIN sessions s ON s.id = ce.session_id AND s.account_id = ce.account_id
      WHERE ce.account_id = ? AND ce.event_id = ?
      LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [identity.accountId, eventId]
  );
  const row = rows[0];
  if (
    !row ||
    row.session_device_id !== identity.deviceId ||
    row.session_source_type !== payload.source.type ||
    row.session_source_instance_id !== payload.source.instanceId
  ) {
    throw new AgentPayloadIntegrityError("正文引用的事件尚未入库或不属于当前设备");
  }
  return row;
}

async function ensureAgentProject(options: {
  connection: Pick<PoolConnection, "execute">;
  accountId: string;
  hint: { gitRemoteKey?: string; repoRootName?: string; localPathHmac?: string };
}): Promise<string> {
  const normalizedRemote = options.hint.gitRemoteKey
    ? normalizeGitRemote(options.hint.gitRemoteKey)
    : null;
  const canonicalKey = normalizedRemote
    ? normalizedRemote
    : options.hint.localPathHmac
      ? `local:${options.hint.localPathHmac}`
      : `root:${options.hint.repoRootName?.trim().toLowerCase() ?? "unclassified"}`;
  const name = options.hint.repoRootName?.trim() ||
    normalizedRemote?.split("/").at(-1) ||
    "未分类";
  const id = stableDatabaseId("project", options.accountId, canonicalKey);
  await options.connection.execute<ResultSetHeader>(
    `INSERT INTO projects
       (id, account_id, name, canonical_key, normalized_git_remote,
        classification_source, confidence_basis_points, is_manual_override)
     VALUES (?, ?, ?, ?, ?, 'SOURCE_HINT', 5000, FALSE)
     ON DUPLICATE KEY UPDATE id = id`,
    [id, options.accountId, name, canonicalKey, normalizedRemote]
  );
  const [rows] = await options.connection.execute<IdentifierRow[]>(
    `SELECT id FROM projects
      WHERE account_id = ? AND canonical_key = ?
      LIMIT 1`,
    [options.accountId, canonicalKey]
  );
  if (!rows[0]) throw new Error("PROJECT_ACCOUNT_SCOPE_MISMATCH");
  return rows[0].id;
}

async function upsertRun(options: {
  connection: Pick<PoolConnection, "execute">;
  identity: Pick<DeviceIdentity, "accountId" | "deviceId">;
  payload: AgentSyncBatchRequest;
  run: Extract<AgentSyncRecord, { recordType: "RUN" }>;
}): Promise<{ row: AgentSessionRow; mutation: ResultSetHeader }> {
  const { run } = options;
  const projectId = run.projectHint
    ? await ensureAgentProject({
        connection: options.connection,
        accountId: options.identity.accountId,
        hint: run.projectHint
      })
    : null;
  const sessionId = stableDatabaseId(
    "session",
    options.identity.accountId,
    options.payload.source.type,
    options.payload.source.instanceId,
    run.sourceSessionId
  );
  const [mutation] = await options.connection.execute<ResultSetHeader>(
    `INSERT INTO sessions
       (id, account_id, device_id, project_id, source_type, source_instance_id,
        source_session_id, source_session_key, run_id, parser_version,
        started_at, ended_at, title, cwd, parent_run_id, raw_capture_status,
        normalized_coverage, attachment_status, missing_reason, agent_metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       run_id = COALESCE(run_id, VALUES(run_id)),
       parser_version = VALUES(parser_version),
       project_id = COALESCE(project_id, VALUES(project_id)),
       started_at = LEAST(COALESCE(started_at, VALUES(started_at)), VALUES(started_at)),
       ended_at = GREATEST(COALESCE(ended_at, VALUES(ended_at)), VALUES(ended_at)),
       title = COALESCE(VALUES(title), title),
       cwd = COALESCE(VALUES(cwd), cwd),
       parent_run_id = COALESCE(VALUES(parent_run_id), parent_run_id),
       raw_capture_status = VALUES(raw_capture_status),
       normalized_coverage = VALUES(normalized_coverage),
       attachment_status = VALUES(attachment_status),
       missing_reason = VALUES(missing_reason),
       agent_metadata = VALUES(agent_metadata),
       updated_at = UTC_TIMESTAMP(6)`,
    [
      sessionId,
      options.identity.accountId,
      options.identity.deviceId,
      projectId,
      options.payload.source.type,
      options.payload.source.instanceId,
      run.sourceSessionId,
      sha256Hex(run.sourceSessionId),
      run.runId,
      options.payload.source.parserVersion,
      new Date(run.startedAt),
      run.endedAt ? new Date(run.endedAt) : null,
      run.title ?? null,
      run.cwd ?? null,
      run.parentRunId ?? null,
      run.rawCaptureStatus,
      run.normalizedCoverage,
      run.attachmentStatus,
      run.missingReason ?? null,
      jsonValue(run.metadata)
    ]
  );
  const row = await loadSessionByRun(
    options.connection,
    options.identity,
    options.payload,
    run.runId
  );
  if (row.id !== sessionId || row.source_session_id !== run.sourceSessionId) {
    throw new AgentPayloadIntegrityError("run 身份与已存会话冲突");
  }
  await options.connection.execute<ResultSetHeader>(
    `INSERT INTO agent_capture_completeness
       (session_id, account_id, raw_capture_status, normalized_coverage,
        attachment_status, missing_reasons)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       raw_capture_status = VALUES(raw_capture_status),
       normalized_coverage = VALUES(normalized_coverage),
       attachment_status = VALUES(attachment_status),
       missing_reasons = VALUES(missing_reasons),
       assessed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)`,
    [
      row.id,
      options.identity.accountId,
      run.rawCaptureStatus,
      run.normalizedCoverage,
      run.attachmentStatus,
      jsonValue(run.missingReason ? [run.missingReason] : [])
    ]
  );
  return { row, mutation };
}

async function upsertEvent(options: {
  connection: Pick<PoolConnection, "execute">;
  identity: Pick<DeviceIdentity, "accountId" | "deviceId">;
  payload: AgentSyncBatchRequest;
  batchDatabaseId: string;
  session: AgentSessionRow;
  event: Extract<AgentSyncRecord, { recordType: "EVENT" }>;
}): Promise<ResultSetHeader> {
  const expectedEventId = buildAgentEventId({
    accountId: options.identity.accountId,
    deviceId: options.identity.deviceId,
    sourceType: options.payload.source.type,
    sourceInstanceId: options.payload.source.instanceId,
    sourceSessionId: options.session.source_session_id,
    sourceEventId: options.event.sourceEventId,
    sequence: options.event.sequence
  });
  if (options.event.eventId !== expectedEventId) {
    throw new AgentPayloadIntegrityError("eventId 与已存会话的来源事件身份不匹配");
  }
  const eventDatabaseId = stableDatabaseId(
    "event",
    options.identity.accountId,
    options.event.eventId
  );
  const [mutation] = await options.connection.execute<ResultSetHeader>(
    `INSERT INTO collected_events
       (id, account_id, device_id, sync_batch_id, session_id, project_id,
        event_id, source_event_id, kind, source_message_id, sequence,
        turn_index, step_index, message_index, reply_to_event_id,
        mirror_of_event_id, occurred_at, source_time_zone, content_hash,
        raw_payload_sha256, current_version, redaction_version,
        raw_capture_status, normalized_coverage, attachment_status,
        missing_reason, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
             NULL, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       source_event_id = COALESCE(source_event_id, VALUES(source_event_id)),
       sequence = COALESCE(sequence, VALUES(sequence)),
       turn_index = COALESCE(turn_index, VALUES(turn_index)),
       step_index = COALESCE(step_index, VALUES(step_index)),
       mirror_of_event_id = COALESCE(mirror_of_event_id, VALUES(mirror_of_event_id)),
       raw_payload_sha256 = COALESCE(VALUES(raw_payload_sha256), raw_payload_sha256),
       content_hash = COALESCE(VALUES(content_hash), content_hash),
       raw_capture_status = VALUES(raw_capture_status),
       normalized_coverage = VALUES(normalized_coverage),
       attachment_status = VALUES(attachment_status),
       missing_reason = VALUES(missing_reason),
       metadata = VALUES(metadata)`,
    [
      eventDatabaseId,
      options.identity.accountId,
      options.identity.deviceId,
      options.batchDatabaseId,
      options.session.id,
      options.session.project_id,
      options.event.eventId,
      options.event.sourceEventId,
      options.event.kind,
      options.event.sourceEventId,
      options.event.sequence,
      options.event.turnIndex ?? null,
      options.event.stepIndex ?? null,
      options.event.sequence,
      options.event.replyToEventId ?? null,
      options.event.mirrorOfEventId ?? null,
      new Date(options.event.occurredAt),
      options.event.sourceTimeZone,
      options.event.contentSha256 ?? null,
      options.event.rawPayloadSha256 ?? null,
      options.event.rawCaptureStatus,
      options.event.normalizedCoverage,
      options.event.attachmentStatus,
      options.event.missingReason ?? null,
      jsonValue(options.event.metadata)
    ]
  );
  const stored = await loadEventByIdentity(
    options.connection,
    options.identity,
    options.payload,
    options.event.eventId
  );
  if (
    stored.id !== eventDatabaseId ||
    stored.session_id !== options.session.id ||
    (stored.source_event_id !== null &&
      stored.source_event_id !== options.event.sourceEventId) ||
    (stored.sequence !== null && Number(stored.sequence) !== options.event.sequence) ||
    !compatibleAgentKind(stored.kind, options.event.kind)
  ) {
    throw new AgentPayloadIntegrityError("事件身份与已存记录冲突");
  }
  return mutation;
}

function assertTextSegmentMatchesEvent(
  event: AgentEventRow,
  segment: Extract<AgentSyncRecord, { recordType: "TEXT_SEGMENT" }>
): void {
  const groupSha256 = segment.groupSha256 ?? segment.contentSha256;
  if (segment.purpose === "SEARCH_TEXT") return;
  if (segment.purpose === "RAW_PAYLOAD") {
    if (event.raw_payload_sha256 !== groupSha256) {
      throw new AgentPayloadIntegrityError("原始载荷摘要与事件声明不匹配");
    }
    return;
  }
  if (event.content_hash !== groupSha256) {
    throw new AgentPayloadIntegrityError("正文摘要与事件声明不匹配");
  }
}

interface TextGroupSummaryRow extends RowDataPacket {
  segment_count: number | string;
  total_byte_length: number | string;
  min_ordinal: number | string | null;
  max_ordinal: number | string | null;
  min_group_byte_length: number | string | null;
  max_group_byte_length: number | string | null;
  min_group_segment_count: number | string | null;
  max_group_segment_count: number | string | null;
}

interface TextGroupSegmentRow extends RowDataPacket {
  content: string;
  content_sha256: string;
  byte_length: number | string;
  ordinal: number | string;
  group_byte_length: number | string;
  group_segment_count: number | string;
}

interface EventVersionIdentifierRow extends RowDataPacket {
  id: string;
  version: number | string;
}

async function upsertPrimaryContent(options: {
  connection: Pick<PoolConnection, "execute">;
  accountId: string;
  parserVersion: string;
  event: AgentEventRow;
  segment: Extract<AgentSyncRecord, { recordType: "TEXT_SEGMENT" }>;
}): Promise<Date | null> {
  if (["RAW_PAYLOAD", "SEARCH_TEXT"].includes(options.segment.purpose)) return null;

  const groupSha256 = options.segment.groupSha256 ?? options.segment.contentSha256;
  const groupByteLength = options.segment.groupByteLength ?? options.segment.byteLength;
  const groupSegmentCount = options.segment.groupSegmentCount ?? 1;
  if (options.event.content_hash !== groupSha256) return null;

  const [summaryRows] = await options.connection.execute<TextGroupSummaryRow[]>(
    `SELECT COUNT(*) AS segment_count,
            COALESCE(SUM(byte_length), 0) AS total_byte_length,
            MIN(ordinal) AS min_ordinal, MAX(ordinal) AS max_ordinal,
            MIN(group_byte_length) AS min_group_byte_length,
            MAX(group_byte_length) AS max_group_byte_length,
            MIN(group_segment_count) AS min_group_segment_count,
            MAX(group_segment_count) AS max_group_segment_count
       FROM agent_text_segments
      WHERE account_id = ? AND collected_event_id = ? AND purpose = ?
        AND group_sha256 = ?`,
    [
      options.accountId,
      options.event.id,
      options.segment.purpose,
      groupSha256
    ]
  );
  const summary = summaryRows[0];
  const storedSegmentCount = Number(summary?.segment_count ?? 0);
  const storedByteLength = Number(summary?.total_byte_length ?? 0);
  if (
    storedSegmentCount < groupSegmentCount ||
    storedByteLength < groupByteLength
  ) return null;
  if (
    storedSegmentCount !== groupSegmentCount ||
    storedByteLength !== groupByteLength ||
    Number(summary?.min_ordinal) !== 0 ||
    Number(summary?.max_ordinal) !== groupSegmentCount - 1 ||
    Number(summary?.min_group_byte_length) !== groupByteLength ||
    Number(summary?.max_group_byte_length) !== groupByteLength ||
    Number(summary?.min_group_segment_count) !== groupSegmentCount ||
    Number(summary?.max_group_segment_count) !== groupSegmentCount
  ) {
    throw new AgentPayloadIntegrityError("正文分段的组边界不一致");
  }

  const [existingVersions] = await options.connection.execute<
    EventVersionIdentifierRow[]
  >(
    `SELECT id, version FROM event_versions
      WHERE account_id = ? AND collected_event_id = ? AND content_hash = ?
      LIMIT 1`,
    [options.accountId, options.event.id, groupSha256]
  );
  let version = existingVersions[0]
    ? Number(existingVersions[0].version)
    : undefined;
  let versionId = existingVersions[0]?.id;
  const isNewVersion = version === undefined;
  if (isNewVersion) {
    const [maxRows] = await options.connection.execute<
      Array<RowDataPacket & { max_version: number }>
    >(
      `SELECT COALESCE(MAX(version), 0) AS max_version
         FROM event_versions
        WHERE account_id = ? AND collected_event_id = ?`,
      [options.accountId, options.event.id]
    );
    version = Number(maxRows[0]?.max_version ?? 0) + 1;
    versionId = stableDatabaseId(
      "version",
      options.event.id,
      groupSha256,
      String(version)
    );
    await options.connection.execute<ResultSetHeader>(
      `INSERT INTO event_versions
         (id, account_id, collected_event_id, version, content_hash,
          sanitized_content, parser_version, redaction_version, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'RAW_V2', ?)`,
      [
        versionId,
        options.accountId,
        options.event.id,
        version,
        groupSha256,
        "",
        options.parserVersion,
        jsonValue({ purpose: options.segment.purpose, protocolVersion: 2 })
      ]
    );
  }
  if (version === undefined || !versionId) {
    throw new AgentPayloadIntegrityError("正文版本身份不完整");
  }

  const digest = createHash("sha256");
  let validatedByteLength = 0;
  let nextOrdinal = 0;
  while (nextOrdinal < groupSegmentCount) {
    const [segmentRows] = await options.connection.execute<TextGroupSegmentRow[]>(
      `SELECT content, content_sha256, byte_length, ordinal,
              group_byte_length, group_segment_count
         FROM agent_text_segments
        WHERE account_id = ? AND collected_event_id = ? AND purpose = ?
          AND group_sha256 = ? AND ordinal >= ?
        ORDER BY ordinal ASC
        LIMIT 16`,
      [
        options.accountId,
        options.event.id,
        options.segment.purpose,
        groupSha256,
        nextOrdinal
      ]
    );
    if (segmentRows.length === 0) {
      throw new AgentPayloadIntegrityError("正文分段不连续");
    }
    for (const row of segmentRows) {
      const ordinal = Number(row.ordinal);
      const byteLength = Number(row.byte_length);
      if (
        ordinal !== nextOrdinal ||
        Number(row.group_byte_length) !== groupByteLength ||
        Number(row.group_segment_count) !== groupSegmentCount ||
        Buffer.byteLength(row.content, "utf8") !== byteLength ||
        sha256Hex(row.content) !== row.content_sha256
      ) {
        throw new AgentPayloadIntegrityError("正文分段内容或顺序不匹配");
      }
      digest.update(row.content, "utf8");
      validatedByteLength += byteLength;
      if (isNewVersion) {
        await options.connection.execute<ResultSetHeader>(
          `UPDATE event_versions
              SET sanitized_content = CONCAT(sanitized_content, ?)
            WHERE id = ? AND account_id = ? AND collected_event_id = ?`,
          [row.content, versionId, options.accountId, options.event.id]
        );
      }
      nextOrdinal += 1;
    }
  }
  if (
    validatedByteLength !== groupByteLength ||
    digest.digest("hex") !== groupSha256
  ) {
    throw new AgentPayloadIntegrityError("完整正文的长度或 SHA-256 不匹配");
  }

  await options.connection.execute<ResultSetHeader>(
    `UPDATE collected_events
        SET content_hash = ?, current_version = ?, redaction_version = 'RAW_V2'
      WHERE id = ? AND account_id = ?`,
    [groupSha256, version, options.event.id, options.accountId]
  );

  if (options.event.mirror_of_event_id) return null;

  let projectionMutation: ResultSetHeader | null = null;
  if (["USER", "USER_PROMPT"].includes(options.event.kind)) {
    [projectionMutation] = await options.connection.execute<ResultSetHeader>(
      `INSERT INTO prompt_entries
         (id, account_id, collected_event_id, device_id, session_id, project_id,
          occurred_at, source_time_zone, sanitized_content, content_hash, model)
       SELECT ?, ?, ce.id, ce.device_id, ce.session_id, ce.project_id,
              ce.occurred_at, ce.source_time_zone,
              ev.sanitized_content, ev.content_hash, NULL
         FROM collected_events ce
         JOIN event_versions ev
           ON ev.id = ? AND ev.account_id = ce.account_id
          AND ev.collected_event_id = ce.id
        WHERE ce.id = ? AND ce.account_id = ?
       ON DUPLICATE KEY UPDATE
         sanitized_content = VALUES(sanitized_content),
         content_hash = VALUES(content_hash)`,
      [
        stableDatabaseId("prompt", options.event.id),
        options.accountId,
        versionId,
        options.event.id,
        options.accountId
      ]
    );
  } else if (["ASSISTANT", "VISIBLE_RESULT"].includes(options.event.kind)) {
    [projectionMutation] = await options.connection.execute<ResultSetHeader>(
      `INSERT INTO visible_results
         (id, account_id, collected_event_id, prompt_entry_id, device_id,
          session_id, project_id, occurred_at, sanitized_content, content_hash, model)
       SELECT ?, ?, ce.id, pe.id, ce.device_id, ce.session_id, ce.project_id,
              ce.occurred_at, ev.sanitized_content, ev.content_hash, NULL
         FROM collected_events ce
         JOIN event_versions ev
           ON ev.id = ? AND ev.account_id = ce.account_id
          AND ev.collected_event_id = ce.id
         LEFT JOIN collected_events prompt_event
           ON prompt_event.account_id = ce.account_id
          AND prompt_event.event_id = ce.reply_to_event_id
         LEFT JOIN prompt_entries pe
           ON pe.account_id = prompt_event.account_id
          AND pe.collected_event_id = prompt_event.id
        WHERE ce.id = ? AND ce.account_id = ?
       ON DUPLICATE KEY UPDATE
         prompt_entry_id = COALESCE(prompt_entry_id, VALUES(prompt_entry_id)),
         sanitized_content = VALUES(sanitized_content),
         content_hash = VALUES(content_hash)`,
      [
        stableDatabaseId("result", options.event.id),
        options.accountId,
        versionId,
        options.event.id,
        options.accountId
      ]
    );
  }
  return projectionMutation && projectionMutation.affectedRows > 0
    ? options.event.occurred_at
    : null;
}

export async function persistAgentSyncRecords(options: {
  connection: Pick<PoolConnection, "execute">;
  identity: Pick<DeviceIdentity, "accountId" | "deviceId">;
  payload: AgentSyncBatchRequest;
  batchDatabaseId: string;
}): Promise<AgentRecordMutationCounts> {
  const counts: AgentRecordMutationCounts = {
    insertedCount: 0,
    duplicateCount: 0,
    changedCount: 0
  };
  const sessions = new Map<string, AgentSessionRow>();
  const dirtySummaryTimestamps: Date[] = [];

  for (const record of orderedAgentRecords(options.payload.records)) {
    if (record.recordType === "RUN") {
      const { row, mutation } = await upsertRun({
        connection: options.connection,
        identity: options.identity,
        payload: options.payload,
        run: record
      });
      sessions.set(record.runId, row);
      addMutation(counts, mutation);
      continue;
    }

    if (record.recordType === "EVENT") {
      const session = sessions.get(record.runId) ?? await loadSessionByRun(
        options.connection,
        options.identity,
        options.payload,
        record.runId
      );
      sessions.set(record.runId, session);
      const mutation = await upsertEvent({
        connection: options.connection,
        identity: options.identity,
        payload: options.payload,
        batchDatabaseId: options.batchDatabaseId,
        session,
        event: record
      });
      addMutation(counts, mutation);
      continue;
    }

    if (record.recordType === "TEXT_SEGMENT") {
      const event = await loadEventByIdentity(
        options.connection,
        options.identity,
        options.payload,
        record.eventId,
        true
      );
      assertTextSegmentMatchesEvent(event, record);
      const [mutation] = await options.connection.execute<ResultSetHeader>(
        `INSERT INTO agent_text_segments
           (id, account_id, collected_event_id, segment_id, ordinal, format,
            purpose, content_sha256, byte_length, group_sha256,
            group_byte_length, group_segment_count, content, is_searchable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [
          stableDatabaseId("segment", options.identity.accountId, record.segmentId),
          options.identity.accountId,
          event.id,
          record.segmentId,
          record.ordinal,
          record.format,
          record.purpose,
          record.contentSha256,
          record.byteLength,
          record.groupSha256 ?? record.contentSha256,
          record.groupByteLength ?? record.byteLength,
          record.groupSegmentCount ?? 1,
          record.text,
          record.isSearchable
        ]
      );
      addMutation(counts, mutation);
      const dirtySummaryTimestamp = await upsertPrimaryContent({
        connection: options.connection,
        accountId: options.identity.accountId,
        parserVersion: options.payload.source.parserVersion,
        event,
        segment: record
      });
      if (dirtySummaryTimestamp) dirtySummaryTimestamps.push(dirtySummaryTimestamp);
      continue;
    }

    const session = sessions.get(record.runId) ?? await loadSessionByRun(
      options.connection,
      options.identity,
      options.payload,
      record.runId
    );
    sessions.set(record.runId, session);
    const event = record.eventId
      ? await loadEventByIdentity(
          options.connection,
          options.identity,
          options.payload,
          record.eventId
        )
      : null;
    if (event && event.session_id !== session.id) {
      throw new AgentPayloadIntegrityError("附件引用的事件不属于目标 run");
    }
    let blobObjectId: string | null = null;
    let linkedBlobStatus: "CAPTURED" | "STORAGE_FULL" | null = null;
    let linkedBlobFailure: string | null = null;
    if (record.blobSha256) {
      const [blobRows] = await options.connection.execute<BlobIdentifierRow[]>(
        `SELECT id, status, failure_reason FROM blob_objects
          WHERE account_id = ? AND sha256 = ?
          LIMIT 1`,
        [options.identity.accountId, record.blobSha256]
      );
      blobObjectId = blobRows[0]?.id ?? null;
      if (blobRows[0]?.status === "COMPLETE") linkedBlobStatus = "CAPTURED";
      if (blobRows[0]?.status === "STORAGE_FULL") {
        linkedBlobStatus = "STORAGE_FULL";
        linkedBlobFailure = blobRows[0].failure_reason ?? "Blob storage full";
      }
    }
    const [mutation] = await options.connection.execute<ResultSetHeader>(
      `INSERT INTO event_blob_references
         (id, account_id, session_id, collected_event_id, blob_object_id,
          reference_id, blob_sha256, purpose, requested_path, real_path,
          filename, media_type, byte_length, captured_at, status,
          failure_reason, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         blob_object_id = COALESCE(VALUES(blob_object_id), blob_object_id),
         blob_sha256 = COALESCE(VALUES(blob_sha256), blob_sha256),
         real_path = COALESCE(VALUES(real_path), real_path),
         filename = COALESCE(VALUES(filename), filename),
         media_type = COALESCE(VALUES(media_type), media_type),
         byte_length = COALESCE(VALUES(byte_length), byte_length),
         captured_at = COALESCE(VALUES(captured_at), captured_at),
         status = VALUES(status), failure_reason = VALUES(failure_reason),
         metadata = VALUES(metadata), updated_at = UTC_TIMESTAMP(6)`,
      [
        stableDatabaseId("blobref", options.identity.accountId, record.referenceId),
        options.identity.accountId,
        session.id,
        event?.id ?? null,
        blobObjectId,
        record.referenceId,
        record.blobSha256,
        record.purpose,
        record.requestedPath ?? null,
        record.realPath ?? null,
        record.filename ?? null,
        record.mediaType ?? null,
        record.byteLength,
        record.capturedAt ? new Date(record.capturedAt) : null,
        linkedBlobStatus ?? record.status,
        linkedBlobFailure ?? record.failureReason ?? null,
        jsonValue(record.metadata)
      ]
    );
    addMutation(counts, mutation);
  }

  for (const session of sessions.values()) {
    await options.connection.execute<ResultSetHeader>(
      `UPDATE collected_events ce
          SET attachment_status = (
            SELECT CASE
              WHEN SUM(br.status = 'PENDING') > 0 THEN 'PENDING'
              WHEN SUM(br.status = 'STORAGE_FULL') > 0 THEN 'STORAGE_FULL'
              WHEN SUM(br.status = 'READ_ERROR') > 0 THEN 'READ_ERROR'
              WHEN SUM(br.status = 'MISSING') > 0 THEN 'MISSING'
              WHEN SUM(br.status = 'NOT_REGULAR') > 0 THEN 'NOT_REGULAR'
              WHEN COUNT(*) > 0 AND SUM(br.status = 'CAPTURED') = COUNT(*)
                THEN 'CAPTURED'
              ELSE 'NOT_APPLICABLE' END
              FROM event_blob_references br
             WHERE br.account_id = ce.account_id
               AND br.collected_event_id = ce.id
          )
        WHERE ce.account_id = ? AND ce.session_id = ?
          AND EXISTS (
            SELECT 1 FROM event_blob_references refs
             WHERE refs.account_id = ce.account_id
               AND refs.collected_event_id = ce.id
          )`,
      [options.identity.accountId, session.id]
    );
    await options.connection.execute<ResultSetHeader>(
      `UPDATE sessions s
          SET attachment_status = (
            SELECT CASE
              WHEN SUM(br.status = 'PENDING') > 0 THEN 'PENDING'
              WHEN SUM(br.status = 'STORAGE_FULL') > 0 THEN 'STORAGE_FULL'
              WHEN SUM(br.status = 'READ_ERROR') > 0 THEN 'READ_ERROR'
              WHEN SUM(br.status = 'MISSING') > 0 THEN 'MISSING'
              WHEN SUM(br.status = 'NOT_REGULAR') > 0 THEN 'NOT_REGULAR'
              WHEN COUNT(*) > 0 AND SUM(br.status = 'CAPTURED') = COUNT(*)
                THEN 'CAPTURED'
              ELSE 'NOT_APPLICABLE' END
              FROM event_blob_references br
             WHERE br.account_id = s.account_id AND br.session_id = s.id
          ), updated_at = UTC_TIMESTAMP(6)
        WHERE s.account_id = ? AND s.id = ?`,
      [options.identity.accountId, session.id]
    );
    await options.connection.execute<ResultSetHeader>(
      `UPDATE agent_capture_completeness c
          SET event_count = (
                SELECT COUNT(*) FROM collected_events ce
                 WHERE ce.session_id = c.session_id
              ),
              text_segment_count = (
                SELECT COUNT(*) FROM agent_text_segments ts
                JOIN collected_events ce ON ce.id = ts.collected_event_id
                 WHERE ce.session_id = c.session_id
              ),
              pending_blob_count = (
                SELECT COUNT(*) FROM event_blob_references br
                 WHERE br.session_id = c.session_id AND br.status = 'PENDING'
              ), attachment_status = (
                SELECT s.attachment_status FROM sessions s
                 WHERE s.id = c.session_id AND s.account_id = c.account_id
              ),
              updated_at = UTC_TIMESTAMP(6)
        WHERE c.session_id = ? AND c.account_id = ?`,
      [session.id, options.identity.accountId]
    );
  }

  if (dirtySummaryTimestamps.length > 0) {
    const [timeZoneRows] = await options.connection.execute<AccountTimeZoneRow[]>(
      `SELECT time_zone FROM accounts WHERE id = ? LIMIT 1`,
      [options.identity.accountId]
    );
    const timeZone = timeZoneRows[0]?.time_zone ?? "UTC";
    await markSummaryDatesDirty({
      connection: options.connection,
      accountId: options.identity.accountId,
      workDates: dirtySummaryTimestamps.map((timestamp) =>
        workDateInTimeZone(timestamp, timeZone)
      )
    });
  }

  return counts;
}

interface AgentBatchRow extends RowDataPacket {
  id: string;
  payload_hash: string;
  status: string;
  result: unknown;
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function batchHasWarnings(payload: AgentSyncBatchRequest): boolean {
  return payload.records.some((record) => {
    if (record.recordType === "RUN" || record.recordType === "EVENT") {
      return record.rawCaptureStatus !== "CAPTURED" ||
        ["NONE", "UNKNOWN"].includes(record.normalizedCoverage);
    }
    if (record.recordType === "BLOB_REFERENCE") {
      return ["MISSING", "READ_ERROR", "NOT_REGULAR", "STORAGE_FULL"].includes(
        record.status
      );
    }
    return false;
  });
}

export interface CommitAgentSyncBatchOptions {
  pool: Pool;
  identity: DeviceIdentity;
  validated: ValidatedIncomingV2Batch;
  requestId: string;
}

async function commitAgentSyncBatchAttempt(
  options: CommitAgentSyncBatchOptions
): Promise<SyncBatchResult> {
  const { payload, payloadHash } = options.validated;
  validateAgentBatchIntegrity(payload, options.identity);
  const batchDatabaseId = stableDatabaseId(
    "batch",
    options.identity.accountId,
    options.identity.deviceId,
    payload.batchId
  );
  const connection = await options.pool.getConnection();
  try {
    await connection.beginTransaction();
    await lockActiveDeviceCredential({
      connection,
      identity: options.identity
    });
    await connection.execute<ResultSetHeader>(
      `INSERT INTO sync_batches
         (id, account_id, device_id, batch_id, protocol_version, source_type,
          source_instance_id, parser_version, payload_hash, status,
          received_count)
       VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?, 'RECEIVED', ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        batchDatabaseId,
        options.identity.accountId,
        options.identity.deviceId,
        payload.batchId,
        payload.source.type,
        payload.source.instanceId,
        payload.source.parserVersion,
        payloadHash,
        payload.records.length
      ]
    );
    const [batchRows] = await connection.execute<AgentBatchRow[]>(
      `SELECT id, payload_hash, status, result
         FROM sync_batches
        WHERE account_id = ? AND device_id = ? AND batch_id = ?
        FOR UPDATE`,
      [options.identity.accountId, options.identity.deviceId, payload.batchId]
    );
    const batch = batchRows[0];
    if (!batch) throw new Error("SYNC_BATCH_NOT_FOUND");
    if (batch.payload_hash !== payloadHash) throw new BatchConflictError();
    if (
      ["COMMITTED", "COMMITTED_WITH_WARNINGS"].includes(batch.status) &&
      batch.result
    ) {
      const existing = SyncBatchResultSchema.parse(parsedJson(batch.result));
      await connection.commit();
      return existing;
    }

    const counts = await persistAgentSyncRecords({
      connection,
      identity: options.identity,
      payload,
      batchDatabaseId: batch.id
    });
    const committedAt = new Date().toISOString();
    const result = SyncBatchResultSchema.parse({
      batchId: payload.batchId,
      status: batchHasWarnings(payload)
        ? "COMMITTED_WITH_WARNINGS"
        : "COMMITTED",
      receivedCount: payload.records.length,
      ...counts,
      committedAt
    });
    await connection.execute<ResultSetHeader>(
      `UPDATE sync_batches
          SET status = ?, inserted_count = ?, duplicate_count = ?,
              changed_count = ?, result = ?, committed_at = ?
        WHERE id = ? AND account_id = ? AND device_id = ?`,
      [
        result.status,
        result.insertedCount,
        result.duplicateCount,
        result.changedCount,
        jsonValue(result),
        new Date(committedAt),
        batch.id,
        options.identity.accountId,
        options.identity.deviceId
      ]
    );
    await connection.execute<ResultSetHeader>(
      `UPDATE devices
          SET last_seen_at = UTC_TIMESTAMP(6),
              last_synced_at = UTC_TIMESTAMP(6),
              updated_at = UTC_TIMESTAMP(6)
        WHERE id = ? AND account_id = ?`,
      [options.identity.deviceId, options.identity.accountId]
    );
    await connection.execute<ResultSetHeader>(
      `INSERT INTO audit_logs
         (account_id, device_id, action, resource_type, resource_id,
          request_id, outcome, metadata)
       VALUES (?, ?, 'AGENT_SYNC_BATCH_COMMITTED', 'sync_batch', ?, ?,
               'SUCCEEDED', ?)`,
      [
        options.identity.accountId,
        options.identity.deviceId,
        batch.id,
        options.requestId,
        jsonValue({
          protocolVersion: 2,
          sourceType: payload.source.type,
          recordCount: payload.records.length,
          status: result.status
        })
      ]
    );
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function commitAgentSyncBatch(
  options: CommitAgentSyncBatchOptions
): Promise<SyncBatchResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await commitAgentSyncBatchAttempt(options);
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === 2) throw error;
    }
  }
  throw lastError;
}
