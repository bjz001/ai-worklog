import { createHash } from "node:crypto";
import type {
  AgentAttachmentView,
  AgentEventKind,
  AgentEventView,
  AgentRunDetailResponse,
  AgentRunEventsResponse,
  AgentRunsResponse,
  AgentRunView,
  AttachmentStatus,
  NormalizedCoverage,
  RawCaptureStatus
} from "@ai-worklog/contracts";
import {
  AgentRunDetailResponseSchema,
  AgentRunEventsResponseSchema,
  AgentRunsResponseSchema
} from "@ai-worklog/contracts";
import { sha256Hex } from "@ai-worklog/core";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type {
  AgentEventQuery,
  AgentRunQuery
} from "./query-input";
import {
  encodeAgentEventCursor,
  parseAgentEventQuery
} from "./query-input";
import { accountTimeZone } from "./query-service";
import { isoDateTime, utcRangeForWorkDate } from "./presentation";

type SqlValue = string | number | Date | null | boolean;

export class AgentQueryNotFoundError extends Error {
  readonly code = "AGENT_RUN_NOT_FOUND";
  readonly status = 404;

  constructor(message = "Agent 会话不存在") {
    super(message);
    this.name = "AgentQueryNotFoundError";
  }
}

function asNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseJsonStrings(value: unknown): string[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function rawCaptureStatus(value: unknown): RawCaptureStatus {
  return ["CAPTURED", "PARTIAL", "NOT_EXPOSED", "UNREADABLE", "CORRUPT"]
    .includes(String(value))
    ? value as RawCaptureStatus
    : "PARTIAL";
}

function normalizedCoverage(value: unknown): NormalizedCoverage {
  return ["FULL", "PARTIAL", "NONE", "UNKNOWN"].includes(String(value))
    ? value as NormalizedCoverage
    : "UNKNOWN";
}

function attachmentStatus(value: unknown): AttachmentStatus {
  return [
    "NOT_APPLICABLE",
    "PENDING",
    "CAPTURED",
    "MISSING",
    "READ_ERROR",
    "NOT_REGULAR",
    "STORAGE_FULL"
  ].includes(String(value))
    ? value as AttachmentStatus
    : "PENDING";
}

function normalizedEventKind(value: string): AgentEventKind {
  if (value === "USER_PROMPT") return "USER";
  if (value === "VISIBLE_RESULT") return "ASSISTANT";
  if ([
    "SYSTEM",
    "CONTEXT",
    "USER",
    "ASSISTANT",
    "REASONING",
    "TOOL_CALL",
    "TOOL_RESULT",
    "SUBAGENT",
    "STATE",
    "TURN_BOUNDARY",
    "ERROR",
    "SOURCE_EVENT"
  ].includes(value)) {
    return value as AgentEventKind;
  }
  return "SOURCE_EVENT";
}

function eventKindPredicate(kind: AgentRunQuery["eventKind"]): {
  sql: string;
  values: string[];
} | null {
  if (!kind) return null;
  if (kind === "USER") {
    return { sql: "(ce.kind = ? OR ce.kind = ?)", values: ["USER", "USER_PROMPT"] };
  }
  if (kind === "ASSISTANT") {
    return {
      sql: "(ce.kind = ? OR ce.kind = ?)",
      values: ["ASSISTANT", "VISIBLE_RESULT"]
    };
  }
  return { sql: "ce.kind = ?", values: [kind] };
}

function textMatchSql(): string {
  return `(
    (ts.is_searchable = TRUE AND (
      MATCH(ts.content) AGAINST (? IN NATURAL LANGUAGE MODE)
      OR ts.content LIKE ? ESCAPE '\\\\'
    ))
    OR br.filename LIKE ? ESCAPE '\\\\'
    OR br.requested_path LIKE ? ESCAPE '\\\\'
    OR br.real_path LIKE ? ESCAPE '\\\\'
    OR s.title LIKE ? ESCAPE '\\\\'
    OR s.cwd LIKE ? ESCAPE '\\\\'
  )`;
}

function matchSnippetSql(): string {
  return `CASE WHEN ts.is_searchable = TRUE
              AND (MATCH(ts.content) AGAINST (? IN NATURAL LANGUAGE MODE)
                   OR ts.content LIKE ? ESCAPE '\\\\')
            THEN LEFT(ts.content, 240)
          WHEN br.filename LIKE ? ESCAPE '\\\\' THEN LEFT(br.filename, 240)
          WHEN br.requested_path LIKE ? ESCAPE '\\\\' THEN LEFT(br.requested_path, 240)
          WHEN br.real_path LIKE ? ESCAPE '\\\\' THEN LEFT(br.real_path, 240)
          WHEN s.title LIKE ? ESCAPE '\\\\' THEN LEFT(s.title, 240)
          WHEN s.cwd LIKE ? ESCAPE '\\\\' THEN LEFT(s.cwd, 240)
          ELSE NULL END`;
}

function attachmentMatchSql(alias: string): string {
  return `(
    ${alias}.filename LIKE ? ESCAPE '\\\\'
    OR ${alias}.requested_path LIKE ? ESCAPE '\\\\'
    OR ${alias}.real_path LIKE ? ESCAPE '\\\\'
  )`;
}

function attachmentSnippetSql(alias: string): string {
  return `CASE
    WHEN ${alias}.filename LIKE ? ESCAPE '\\\\' THEN LEFT(${alias}.filename, 240)
    WHEN ${alias}.requested_path LIKE ? ESCAPE '\\\\' THEN LEFT(${alias}.requested_path, 240)
    WHEN ${alias}.real_path LIKE ? ESCAPE '\\\\' THEN LEFT(${alias}.real_path, 240)
    ELSE NULL END`;
}

function likeTerm(value: string): string {
  const escaped = value.replace(/[\\%_]/gu, (character) => `\\${character}`);
  return `%${escaped}%`;
}

function textMatchValues(query: string): SqlValue[] {
  const like = likeTerm(query);
  return [query, like, like, like, like, like, like];
}

function attachmentMatchValues(query: string): SqlValue[] {
  const like = likeTerm(query);
  return [like, like, like];
}

async function runWhere(options: {
  pool: Pool;
  accountId: string;
  query: AgentRunQuery;
}): Promise<{ sql: string; values: SqlValue[] }> {
  const clauses = ["s.account_id = ?"];
  const values: SqlValue[] = [options.accountId];
  if (options.query.source) {
    clauses.push("s.source_type = ?");
    values.push(options.query.source);
  }
  if (options.query.projectId) {
    clauses.push("s.project_id = ?");
    values.push(options.query.projectId);
  }
  if (options.query.completeness) {
    clauses.push("s.raw_capture_status = ?");
    values.push(options.query.completeness);
  }
  if (options.query.from || options.query.to) {
    const timeZone = await accountTimeZone(options.pool, options.accountId);
    if (options.query.from) {
      clauses.push("COALESCE(s.started_at, s.created_at) >= ?");
      values.push(utcRangeForWorkDate(options.query.from, timeZone).from);
    }
    if (options.query.to) {
      clauses.push("COALESCE(s.started_at, s.created_at) < ?");
      values.push(utcRangeForWorkDate(options.query.to, timeZone).until);
    }
  }
  const eventKind = eventKindPredicate(options.query.eventKind);
  if (eventKind) {
    clauses.push(`EXISTS (
      SELECT 1 FROM collected_events ce
       WHERE ce.session_id = s.id AND ${eventKind.sql}
    )`);
    values.push(...eventKind.values);
  }
  if (options.query.q) {
    clauses.push(`(
      EXISTS (
        SELECT 1
          FROM collected_events ce
          LEFT JOIN agent_text_segments ts
            ON ts.collected_event_id = ce.id
          LEFT JOIN event_blob_references br
            ON br.collected_event_id = ce.id
         WHERE ce.session_id = s.id AND ${textMatchSql()}
      ) OR EXISTS (
        SELECT 1
          FROM event_blob_references run_br
         WHERE run_br.account_id = s.account_id
           AND run_br.session_id = s.id
           AND run_br.collected_event_id IS NULL
           AND ${attachmentMatchSql("run_br")}
      )
    )`);
    values.push(
      ...textMatchValues(options.query.q),
      ...attachmentMatchValues(options.query.q)
    );
  }
  return { sql: clauses.join(" AND "), values };
}

interface AgentRunRow extends RowDataPacket {
  id: string;
  run_id: string | null;
  source_type: AgentRunView["sourceType"];
  source_session_id: string;
  title: string | null;
  cwd: string | null;
  project_id: string | null;
  project_name: string | null;
  device_id: string;
  device_name: string;
  started_at: Date;
  ended_at: Date | null;
  event_count: number | string;
  turn_count: number | string;
  matched_event_count: number | string;
  match_snippet: string | null;
  raw_capture_status: string;
  normalized_coverage: string;
  attachment_status: string;
}

function runView(row: AgentRunRow): AgentRunView {
  return {
    id: row.id,
    runId: row.run_id,
    sourceType: row.source_type,
    sourceSessionId: row.source_session_id,
    title: row.title,
    cwd: row.cwd,
    projectId: row.project_id,
    projectName: row.project_name ?? "未分类项目",
    deviceId: row.device_id,
    deviceName: row.device_name,
    startedAt: isoDateTime(row.started_at) ?? new Date(0).toISOString(),
    endedAt: isoDateTime(row.ended_at),
    eventCount: asNumber(row.event_count),
    turnCount: asNumber(row.turn_count),
    matchedEventCount: asNumber(row.matched_event_count),
    matchSnippet: row.match_snippet,
    rawCaptureStatus: rawCaptureStatus(row.raw_capture_status),
    normalizedCoverage: normalizedCoverage(row.normalized_coverage),
    attachmentStatus: attachmentStatus(row.attachment_status)
  };
}

const RUN_SELECT = `s.id, s.run_id, s.source_type, s.source_session_id,
  s.title, s.cwd, s.project_id, COALESCE(p.name, '未分类项目') AS project_name,
  s.device_id, d.name AS device_name,
  COALESCE(s.started_at, s.created_at) AS started_at, s.ended_at,
  (SELECT COUNT(*) FROM collected_events all_events
    WHERE all_events.session_id = s.id) AS event_count,
  (SELECT COUNT(DISTINCT all_events.turn_index) FROM collected_events all_events
    WHERE all_events.session_id = s.id AND all_events.turn_index IS NOT NULL) AS turn_count`;

export async function listAgentRuns(options: {
  pool: Pool;
  accountId: string;
  query: AgentRunQuery;
}): Promise<AgentRunsResponse> {
  const where = await runWhere(options);
  const [countRows] = await options.pool.execute<
    Array<RowDataPacket & { total: number | string }>
  >(
    `SELECT COUNT(DISTINCT s.id) AS total
       FROM sessions s
       LEFT JOIN projects p ON p.id = s.project_id AND p.account_id = s.account_id
       JOIN devices d ON d.id = s.device_id AND d.account_id = s.account_id
      WHERE ${where.sql}`,
    where.values
  );
  const totalItems = asNumber(countRows[0]?.total);
  const offset = (options.query.page - 1) * options.query.pageSize;
  let matchSelect = "0 AS matched_event_count, NULL AS match_snippet";
  let selectValues: SqlValue[] = [];
  if (options.query.q) {
    matchSelect = `(SELECT COUNT(DISTINCT ce.id)
       FROM collected_events ce
       LEFT JOIN agent_text_segments ts ON ts.collected_event_id = ce.id
       LEFT JOIN event_blob_references br ON br.collected_event_id = ce.id
      WHERE ce.session_id = s.id AND ${textMatchSql()}) AS matched_event_count,
      COALESCE(
        (SELECT ${matchSnippetSql()}
           FROM collected_events ce
           LEFT JOIN agent_text_segments ts ON ts.collected_event_id = ce.id
           LEFT JOIN event_blob_references br ON br.collected_event_id = ce.id
          WHERE ce.session_id = s.id AND ${textMatchSql()}
          ORDER BY ce.occurred_at ASC, ce.event_id ASC LIMIT 1),
        (SELECT ${attachmentSnippetSql("run_br")}
           FROM event_blob_references run_br
          WHERE run_br.account_id = s.account_id
            AND run_br.session_id = s.id
            AND run_br.collected_event_id IS NULL
            AND ${attachmentMatchSql("run_br")}
          ORDER BY run_br.created_at ASC, run_br.id ASC LIMIT 1)
      ) AS match_snippet`;
    selectValues = [
      ...textMatchValues(options.query.q),
      ...textMatchValues(options.query.q),
      ...textMatchValues(options.query.q),
      ...attachmentMatchValues(options.query.q),
      ...attachmentMatchValues(options.query.q)
    ];
  }
  const [rows] = await options.pool.execute<AgentRunRow[]>(
    `SELECT ${RUN_SELECT}, ${matchSelect},
            s.raw_capture_status, s.normalized_coverage, s.attachment_status
       FROM sessions s
       LEFT JOIN projects p ON p.id = s.project_id AND p.account_id = s.account_id
       JOIN devices d ON d.id = s.device_id AND d.account_id = s.account_id
      WHERE ${where.sql}
      ORDER BY s.started_at DESC, s.id DESC
      LIMIT ${options.query.pageSize} OFFSET ${offset}`,
    [...selectValues, ...where.values]
  );
  return AgentRunsResponseSchema.parse({
    data: rows.map(runView),
    pagination: {
      page: options.query.page,
      pageSize: options.query.pageSize,
      totalItems,
      totalPages: totalItems === 0
        ? 0
        : Math.ceil(totalItems / options.query.pageSize)
    }
  });
}

interface AgentRunDetailRow extends AgentRunRow {
  agent_metadata: unknown;
  missing_reasons: unknown;
  text_segment_count: number | string;
  pending_blob_count: number | string;
}

export async function getAgentRunDetail(options: {
  pool: Pool;
  accountId: string;
  runId: string;
}): Promise<AgentRunDetailResponse> {
  const [rows] = await options.pool.execute<AgentRunDetailRow[]>(
    `SELECT ${RUN_SELECT}, 0 AS matched_event_count, NULL AS match_snippet,
            s.raw_capture_status, s.normalized_coverage, s.attachment_status,
            s.agent_metadata,
            COALESCE(c.missing_reasons, JSON_ARRAY()) AS missing_reasons,
            COALESCE(c.text_segment_count, 0) AS text_segment_count,
            COALESCE(c.pending_blob_count, 0) AS pending_blob_count
       FROM sessions s
       LEFT JOIN projects p ON p.id = s.project_id AND p.account_id = s.account_id
       JOIN devices d ON d.id = s.device_id AND d.account_id = s.account_id
       LEFT JOIN agent_capture_completeness c
         ON c.session_id = s.id AND c.account_id = s.account_id
      WHERE s.id = ? AND s.account_id = ?
      LIMIT 1`,
    [options.runId, options.accountId]
  );
  const row = rows[0];
  if (!row) throw new AgentQueryNotFoundError();
  const [attachmentRows] = await options.pool.execute<AgentAttachmentRow[]>(
    `SELECT br.id, br.collected_event_id, br.reference_id, br.purpose,
            br.filename, br.requested_path, br.real_path, br.byte_length,
            br.blob_sha256, br.media_type, br.status, br.failure_reason
       FROM event_blob_references br
      WHERE br.account_id = ? AND br.session_id = ?
        AND br.collected_event_id IS NULL
      ORDER BY br.created_at ASC, br.id ASC`,
    [options.accountId, options.runId]
  );
  return AgentRunDetailResponseSchema.parse({
    data: {
      run: runView(row),
      metadata: parseJsonRecord(row.agent_metadata),
      completeness: {
        missingReasons: parseJsonStrings(row.missing_reasons),
        textSegmentCount: asNumber(row.text_segment_count),
        pendingBlobCount: asNumber(row.pending_blob_count)
      },
      attachments: attachmentRows.map(attachmentView)
    }
  });
}

interface AgentEventRow extends RowDataPacket {
  id: string;
  event_id: string;
  source_event_id: string | null;
  sequence: number | string | null;
  message_index: number | string | null;
  turn_index: number | null;
  step_index: number | null;
  kind: string;
  occurred_at: Date;
  reply_to_event_id: string | null;
  mirror_of_event_id: string | null;
  content_preview: string | null;
  content_purposes: string | null;
  segment_count: number | string;
  raw_segment_count: number | string;
  raw_payload_sha256: string | null;
  raw_capture_status: string;
  normalized_coverage: string;
  attachment_status: string;
  missing_reason: string | null;
  metadata: unknown;
}

interface AgentAttachmentRow extends RowDataPacket {
  id: string;
  collected_event_id: string | null;
  reference_id: string;
  purpose: AgentAttachmentView["purpose"];
  filename: string | null;
  requested_path: string | null;
  real_path: string | null;
  byte_length: number | string | null;
  blob_sha256: string | null;
  media_type: string | null;
  status: string;
  failure_reason: string | null;
}

function attachmentView(row: AgentAttachmentRow): AgentAttachmentView {
  return {
    id: row.id,
    referenceId: row.reference_id,
    purpose: row.purpose,
    filename: row.filename,
    requestedPath: row.requested_path,
    realPath: row.real_path,
    byteLength: row.byte_length === null ? null : asNumber(row.byte_length),
    sha256: row.blob_sha256,
    mediaType: row.media_type,
    status: attachmentStatus(row.status),
    failureReason: row.failure_reason,
    downloadUrl:
      row.status === "CAPTURED" && row.blob_sha256
        ? `/api/v1/blobs/${row.blob_sha256}`
        : null
  };
}

export function decodeAgentEventCursor(value: string) {
  return parseAgentEventQuery(new URLSearchParams({ cursor: value })).cursor;
}

function eventSequence(row: AgentEventRow): number {
  return asNumber(row.sequence ?? row.message_index ?? 0);
}

export async function listAgentEvents(options: {
  pool: Pool;
  accountId: string;
  runId: string;
  query: AgentEventQuery;
}): Promise<AgentRunEventsResponse> {
  const cursorSql = options.query.cursor
    ? `AND (
         COALESCE(ce.sequence, ce.message_index, 0) > ? OR
         (COALESCE(ce.sequence, ce.message_index, 0) = ? AND ce.event_id > ?)
       )`
    : "";
  const values: SqlValue[] = [options.runId, options.accountId];
  if (options.query.cursor) {
    values.push(
      options.query.cursor.sequence,
      options.query.cursor.sequence,
      options.query.cursor.eventId
    );
  }
  const [allRows] = await options.pool.execute<AgentEventRow[]>(
    `SELECT ce.id, ce.event_id, ce.source_event_id, ce.sequence,
            ce.message_index, ce.turn_index, ce.step_index, ce.kind,
            ce.occurred_at, ce.reply_to_event_id, ce.mirror_of_event_id,
            (SELECT LEFT(ts.content, 600)
               FROM agent_text_segments ts
              WHERE ts.collected_event_id = ce.id
                AND ts.ordinal = 0
              ORDER BY FIELD(ts.purpose, 'RENDERED_CONTENT', 'TOOL_ARGUMENTS',
                             'TOOL_RESULT', 'SEARCH_TEXT', 'RAW_PAYLOAD'),
                       ts.created_at DESC LIMIT 1) AS content_preview,
            (SELECT GROUP_CONCAT(DISTINCT ts.purpose ORDER BY ts.purpose SEPARATOR ',')
               FROM agent_text_segments ts
              WHERE ts.collected_event_id = ce.id) AS content_purposes,
            (SELECT COUNT(*) FROM agent_text_segments ts
              WHERE ts.collected_event_id = ce.id) AS segment_count,
            (SELECT COUNT(*) FROM agent_text_segments ts
              WHERE ts.collected_event_id = ce.id AND ts.purpose = 'RAW_PAYLOAD')
              AS raw_segment_count,
            ce.raw_payload_sha256, ce.raw_capture_status,
            ce.normalized_coverage, ce.attachment_status,
            ce.missing_reason, ce.metadata
       FROM sessions s
       JOIN collected_events ce ON ce.session_id = s.id AND ce.account_id = s.account_id
      WHERE s.id = ? AND s.account_id = ? ${cursorSql}
      ORDER BY COALESCE(ce.sequence, ce.message_index, 0) ASC, ce.event_id ASC
      LIMIT ${options.query.pageSize + 1}`,
    values
  );
  const hasMore = allRows.length > options.query.pageSize;
  const rows = hasMore ? allRows.slice(0, options.query.pageSize) : allRows;
  const eventDatabaseIds = rows.map((row) => row.id);
  let attachmentRows: AgentAttachmentRow[] = [];
  if (eventDatabaseIds.length > 0) {
    const placeholders = eventDatabaseIds.map(() => "?").join(", ");
    const [result] = await options.pool.execute<AgentAttachmentRow[]>(
      `SELECT br.id, br.collected_event_id, br.reference_id, br.purpose,
              br.filename, br.requested_path, br.real_path, br.byte_length,
              br.blob_sha256, br.media_type, br.status, br.failure_reason
         FROM event_blob_references br
        WHERE br.account_id = ? AND br.collected_event_id IN (${placeholders})
        ORDER BY br.created_at ASC, br.id ASC`,
      [options.accountId, ...eventDatabaseIds]
    );
    attachmentRows = result;
  }
  const attachmentsByEvent = new Map<string, AgentAttachmentView[]>();
  for (const row of attachmentRows) {
    if (!row.collected_event_id) continue;
    const list = attachmentsByEvent.get(row.collected_event_id) ?? [];
    list.push(attachmentView(row));
    attachmentsByEvent.set(row.collected_event_id, list);
  }
  const data: AgentEventView[] = rows.map((row) => {
    const purposes = (row.content_purposes ?? "")
      .split(",")
      .filter((purpose): purpose is AgentEventView["contentPurposes"][number] =>
        [
          "RENDERED_CONTENT",
          "RAW_PAYLOAD",
          "TOOL_ARGUMENTS",
          "TOOL_RESULT",
          "SEARCH_TEXT"
        ].includes(purpose)
      );
    return {
      id: row.id,
      eventId: row.event_id,
      sourceEventId: row.source_event_id,
      sequence: eventSequence(row),
      turnIndex: row.turn_index === null ? null : asNumber(row.turn_index),
      stepIndex: row.step_index === null ? null : asNumber(row.step_index),
      kind: normalizedEventKind(row.kind),
      occurredAt: isoDateTime(row.occurred_at) ?? new Date(0).toISOString(),
      replyToEventId: row.reply_to_event_id,
      mirrorOfEventId: row.mirror_of_event_id,
      contentPreview: row.content_preview,
      contentPurposes: purposes,
      contentUrl: asNumber(row.segment_count) > 0
        ? `/api/v1/agent-events/${row.id}/content`
        : null,
      rawPayloadUrl: asNumber(row.raw_segment_count) > 0
        ? `/api/v1/agent-events/${row.id}/content?purpose=RAW_PAYLOAD`
        : null,
      rawCaptureStatus: rawCaptureStatus(row.raw_capture_status),
      normalizedCoverage: normalizedCoverage(row.normalized_coverage),
      attachmentStatus: attachmentStatus(row.attachment_status),
      missingReason: row.missing_reason,
      metadata: parseJsonRecord(row.metadata),
      attachments: attachmentsByEvent.get(row.id) ?? []
    };
  });
  const last = data.at(-1);
  return AgentRunEventsResponseSchema.parse({
    data,
    pagination: {
      nextCursor: hasMore && last
        ? encodeAgentEventCursor({ sequence: last.sequence, eventId: last.eventId })
        : null,
      hasMore
    }
  });
}

export type AgentTextPurpose = AgentEventView["contentPurposes"][number];

interface ContentDescriptorRow extends RowDataPacket {
  format: "TEXT" | "MARKDOWN" | "JSON";
  purpose: AgentTextPurpose;
  group_sha256: string;
  group_byte_length: number | string;
  group_segment_count: number | string;
}

interface ContentSegmentRow extends RowDataPacket {
  format: "TEXT" | "MARKDOWN" | "JSON";
  content: string;
  content_sha256: string;
  byte_length: number | string;
  ordinal: number | string;
}

export interface AgentEventContent {
  format: "TEXT" | "MARKDOWN" | "JSON";
  purpose: AgentTextPurpose;
  text: string;
  contentSha256: string;
  byteLength: number;
}

export interface AgentEventContentStream {
  format: AgentEventContent["format"];
  purpose: AgentTextPurpose;
  body: ReadableStream<Uint8Array>;
  contentSha256: string;
  byteLength: number;
}

function storedInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid stored Agent content ${label}`);
  }
  return parsed;
}

async function* streamTextGroup(options: {
  pool: Pool;
  accountId: string;
  eventId: string;
  descriptor: Omit<AgentEventContentStream, "body"> & { segmentCount: number };
}): AsyncGenerator<Uint8Array> {
  const hash = createHash("sha256");
  let nextOrdinal = 0;
  let byteLength = 0;
  while (nextOrdinal < options.descriptor.segmentCount) {
    const [rows] = await options.pool.execute<ContentSegmentRow[]>(
      `SELECT ts.format, ts.content, ts.content_sha256, ts.byte_length, ts.ordinal
         FROM agent_text_segments ts
         JOIN collected_events ce
           ON ce.id = ts.collected_event_id AND ce.account_id = ts.account_id
        WHERE ce.account_id = ? AND ce.id = ? AND ts.purpose = ?
          AND ts.group_sha256 = ? AND ts.ordinal >= ?
        ORDER BY ts.ordinal ASC
        LIMIT 16`,
      [
        options.accountId,
        options.eventId,
        options.descriptor.purpose,
        options.descriptor.contentSha256,
        nextOrdinal
      ]
    );
    if (rows.length === 0) throw new Error("Incomplete Agent content group");
    for (const row of rows) {
      const ordinal = storedInteger(row.ordinal, "ordinal");
      if (
        ordinal !== nextOrdinal ||
        row.format !== options.descriptor.format ||
        nextOrdinal >= options.descriptor.segmentCount
      ) {
        throw new Error("Invalid Agent content group order");
      }
      const bytes = Buffer.from(row.content, "utf8");
      if (
        bytes.byteLength !== storedInteger(row.byte_length, "segment length") ||
        sha256Hex(bytes) !== row.content_sha256
      ) {
        throw new Error("Agent content segment integrity check failed");
      }
      hash.update(bytes);
      byteLength += bytes.byteLength;
      nextOrdinal += 1;
      yield new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
  }
  if (
    byteLength !== options.descriptor.byteLength ||
    hash.digest("hex") !== options.descriptor.contentSha256
  ) {
    throw new Error("Agent content group integrity check failed");
  }
}

export async function openAgentEventContentStream(options: {
  pool: Pool;
  accountId: string;
  eventId: string;
  purpose: AgentTextPurpose;
}): Promise<AgentEventContentStream | null> {
  const [rows] = await options.pool.execute<ContentDescriptorRow[]>(
    `SELECT ts.format, ts.purpose, ts.group_sha256,
            ts.group_byte_length, ts.group_segment_count
       FROM agent_text_segments ts
       JOIN collected_events ce
         ON ce.id = ts.collected_event_id AND ce.account_id = ts.account_id
      WHERE ce.account_id = ? AND ce.id = ? AND ts.purpose = ?
        AND ts.ordinal = 0
        AND (SELECT COUNT(*)
               FROM agent_text_segments complete_segments
              WHERE complete_segments.account_id = ts.account_id
                AND complete_segments.collected_event_id = ts.collected_event_id
                AND complete_segments.purpose = ts.purpose
                AND complete_segments.group_sha256 = ts.group_sha256
            ) = ts.group_segment_count
        AND (SELECT COALESCE(SUM(complete_segments.byte_length), 0)
               FROM agent_text_segments complete_segments
              WHERE complete_segments.account_id = ts.account_id
                AND complete_segments.collected_event_id = ts.collected_event_id
                AND complete_segments.purpose = ts.purpose
                AND complete_segments.group_sha256 = ts.group_sha256
            ) = ts.group_byte_length
      ORDER BY ts.created_at DESC
      LIMIT 1`,
    [options.accountId, options.eventId, options.purpose]
  );
  const row = rows[0];
  if (!row) return null;
  const descriptor = {
    format: row.format,
    purpose: options.purpose,
    contentSha256: row.group_sha256,
    byteLength: storedInteger(row.group_byte_length, "group length"),
    segmentCount: storedInteger(row.group_segment_count, "segment count")
  };
  if (descriptor.segmentCount < 1) {
    throw new Error("Invalid stored Agent content segment count");
  }
  const iterator = streamTextGroup({
    pool: options.pool,
    accountId: options.accountId,
    eventId: options.eventId,
    descriptor
  })[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    }
  });
  return {
    format: descriptor.format,
    purpose: descriptor.purpose,
    body,
    contentSha256: descriptor.contentSha256,
    byteLength: descriptor.byteLength
  };
}

export async function getAgentEventContent(options: {
  pool: Pool;
  accountId: string;
  eventId: string;
  purpose: AgentTextPurpose;
}): Promise<AgentEventContent | null> {
  const opened = await openAgentEventContentStream(options);
  if (!opened) return null;
  const reader = opened.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  text += decoder.decode();
  return {
    format: opened.format,
    purpose: options.purpose,
    text,
    contentSha256: opened.contentSha256,
    byteLength: opened.byteLength
  };
}
