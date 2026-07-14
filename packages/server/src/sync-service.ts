import type {
  SyncBatchRequest,
  SyncBatchResult,
  SyncEvent
} from "@ai-worklog/contracts";
import { SyncBatchResultSchema } from "@ai-worklog/contracts";
import {
  buildEventId,
  normalizeGitRemote,
  sha256Hex
} from "@ai-worklog/core";
import type { ValidatedIncomingBatch } from "@ai-worklog/sync";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket
} from "mysql2/promise";
import type { DeviceIdentity } from "./auth";
import { validateSanitizedEvents } from "./input-security";
import { projectDisplayName, workDateInTimeZone } from "./presentation";

export class BatchConflictError extends Error {
  readonly code = "BATCH_ID_REUSED";
  readonly status = 409;

  constructor() {
    super("同一 batchId 已经用于不同请求内容");
    this.name = "BatchConflictError";
  }
}

export class EventIdentityMismatchError extends Error {
  readonly code = "EVENT_IDENTITY_MISMATCH";
  readonly status = 422;

  constructor() {
    super("事件身份与已认证设备不匹配");
    this.name = "EventIdentityMismatchError";
  }
}

export function validateEventIdentities(
  events: readonly SyncEvent[],
  identity: Pick<DeviceIdentity, "accountId" | "deviceId">,
  source: SyncBatchRequest["source"]
): void {
  for (const event of events) {
    const expected = buildEventId({
      accountId: identity.accountId,
      deviceId: identity.deviceId,
      sourceType: source.type,
      sourceInstanceId: source.instanceId,
      sourceSessionId: event.sourceSessionId,
      sourceMessageId: event.sourceMessageId,
      messageIndex: event.messageIndex
    });
    if (expected !== event.eventId) throw new EventIdentityMismatchError();
  }
}

export type EventMutation = "insert" | "duplicate" | "change";

export function classifyEventMutation(
  currentHash: string | null,
  versionHashes: readonly string[],
  incomingHash: string
): EventMutation {
  if (currentHash === null) return "insert";
  if (versionHashes.includes(incomingHash)) return "duplicate";
  return "change";
}

function stableDatabaseId(prefix: string, ...parts: string[]): string {
  const digest = sha256Hex([prefix, ...parts].join("\u001f"));
  return `${prefix}_${digest.slice(0, 64 - prefix.length - 1)}`;
}

export interface ProjectIdentity {
  id: string;
  canonicalKey: string;
  name: string;
  normalizedGitRemote: string | null;
  classificationSource:
    | "GIT_REMOTE"
    | "WORKING_DIRECTORY"
    | "SOURCE_HINT"
    | "UNCLASSIFIED";
  confidenceBasisPoints: number;
}

export function projectIdentity(
  hint: SyncEvent["projectHint"],
  accountId: string
): ProjectIdentity {
  const normalizedGitRemote = hint?.gitRemoteKey
    ? normalizeGitRemote(hint.gitRemoteKey)
    : null;
  let canonicalKey: string;
  let classificationSource: ProjectIdentity["classificationSource"];
  let confidenceBasisPoints: number;

  if (normalizedGitRemote) {
    canonicalKey = normalizedGitRemote;
    classificationSource = "GIT_REMOTE";
    confidenceBasisPoints = 9500;
  } else if (hint?.localPathHmac) {
    canonicalKey = `local:${hint.localPathHmac}`;
    classificationSource = "WORKING_DIRECTORY";
    confidenceBasisPoints = 6500;
  } else if (hint?.repoRootName) {
    canonicalKey = `root:${hint.repoRootName.trim().toLowerCase()}`;
    classificationSource = "SOURCE_HINT";
    confidenceBasisPoints = 5000;
  } else {
    canonicalKey = "unclassified";
    classificationSource = "UNCLASSIFIED";
    confidenceBasisPoints = 0;
  }

  return {
    id: stableDatabaseId("project", accountId, canonicalKey),
    canonicalKey,
    name: projectDisplayName(normalizedGitRemote, hint?.repoRootName),
    normalizedGitRemote,
    classificationSource,
    confidenceBasisPoints
  };
}

interface BatchRow extends RowDataPacket {
  id: string;
  payload_hash: string;
  status: string;
  result: unknown;
}

interface EventRow extends RowDataPacket {
  id: string;
  content_hash: string;
  current_version: number;
  device_id: string;
  session_id: string;
  kind: "USER_PROMPT" | "VISIBLE_RESULT";
  source_message_id: string | null;
  message_index: number;
  occurred_at: Date;
}

interface AccountTimeZoneRow extends RowDataPacket {
  time_zone: string;
}

interface VersionRow extends RowDataPacket {
  content_hash: string;
}

interface IdentifierRow extends RowDataPacket {
  id: string;
}

function jsonValue(value: unknown): string {
  return JSON.stringify(value);
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function markSummaryDatesDirty(options: {
  connection: Pick<PoolConnection, "execute">;
  accountId: string;
  workDates: Iterable<string>;
}): Promise<void> {
  const workDates = [...new Set(options.workDates)].sort();
  for (const workDate of workDates) {
    await options.connection.execute(
      `INSERT INTO summary_jobs (account_id, work_date, dirty_version)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE
         dirty_version = dirty_version + 1,
         updated_at = UTC_TIMESTAMP(6)`,
      [options.accountId, workDate]
    );
  }
}

function modelFrom(event: SyncEvent): string | null {
  const model = event.metadata.model;
  return typeof model === "string" && model.trim()
    ? model.trim().slice(0, 128)
    : null;
}

async function ensureProject(
  connection: PoolConnection,
  accountId: string,
  event: SyncEvent
): Promise<ProjectIdentity> {
  const project = projectIdentity(event.projectHint, accountId);
  await connection.execute(
    `INSERT INTO projects
       (id, account_id, name, canonical_key, normalized_git_remote, classification_source,
        confidence_basis_points, is_manual_override)
     VALUES (?, ?, ?, ?, ?, ?, ?, FALSE)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      project.id,
      accountId,
      project.name,
      project.canonicalKey,
      project.normalizedGitRemote,
      project.classificationSource,
      project.confidenceBasisPoints
    ]
  );

  const [rows] = await connection.execute<IdentifierRow[]>(
    `SELECT id FROM projects
      WHERE account_id = ? AND canonical_key = ?
      LIMIT 1`,
    [accountId, project.canonicalKey]
  );
  if (!rows[0]) throw new Error("PROJECT_ACCOUNT_SCOPE_MISMATCH");
  project.id = rows[0].id;
  return project;
}

async function ensureSession(options: {
  connection: PoolConnection;
  accountId: string;
  deviceId: string;
  sourceType: "CODEX" | "CLAUDE_CODE";
  sourceInstanceId: string;
  parserVersion: string;
  event: SyncEvent;
  projectId: string;
}): Promise<string> {
  const sessionId = stableDatabaseId(
    "session",
    options.accountId,
    options.sourceType,
    options.sourceInstanceId,
    options.event.sourceSessionId
  );
  const occurredAt = new Date(options.event.occurredAt);
  await options.connection.execute(
    `INSERT INTO sessions
       (id, account_id, device_id, project_id, source_type, source_instance_id,
        source_session_id, parser_version, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       parser_version = VALUES(parser_version),
       project_id = COALESCE(project_id, VALUES(project_id)),
       started_at = LEAST(COALESCE(started_at, VALUES(started_at)), VALUES(started_at)),
       ended_at = GREATEST(COALESCE(ended_at, VALUES(ended_at)), VALUES(ended_at)),
       updated_at = UTC_TIMESTAMP(6)`,
    [
      sessionId,
      options.accountId,
      options.deviceId,
      options.projectId,
      options.sourceType,
      options.sourceInstanceId,
      options.event.sourceSessionId,
      options.parserVersion,
      occurredAt,
      occurredAt
    ]
  );
  return sessionId;
}

async function promptIdForReply(
  connection: PoolConnection,
  accountId: string,
  replyToEventId: string | null | undefined
): Promise<string | null> {
  if (!replyToEventId) return null;
  const [rows] = await connection.execute<IdentifierRow[]>(
    `SELECT pe.id
       FROM collected_events ce
       JOIN prompt_entries pe ON pe.collected_event_id = ce.id
      WHERE ce.account_id = ? AND ce.event_id = ?
      LIMIT 1`,
    [accountId, replyToEventId]
  );
  return rows[0]?.id ?? null;
}

async function insertNewEvent(options: {
  connection: PoolConnection;
  accountId: string;
  deviceId: string;
  batchDatabaseId: string;
  sessionId: string;
  projectId: string;
  sourceType: "CODEX" | "CLAUDE_CODE";
  parserVersion: string;
  event: SyncEvent;
}): Promise<void> {
  const eventDatabaseId = stableDatabaseId(
    "event",
    options.accountId,
    options.event.eventId
  );
  const eventVersionId = stableDatabaseId(
    "version",
    eventDatabaseId,
    options.event.contentHash
  );
  const occurredAt = new Date(options.event.occurredAt);

  await options.connection.execute(
    `INSERT INTO collected_events
       (id, account_id, device_id, sync_batch_id, session_id, project_id,
        event_id, kind, source_message_id, message_index, reply_to_event_id,
        occurred_at, source_time_zone, content_hash, current_version,
        redaction_version, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      eventDatabaseId,
      options.accountId,
      options.deviceId,
      options.batchDatabaseId,
      options.sessionId,
      options.projectId,
      options.event.eventId,
      options.event.kind,
      options.event.sourceMessageId ?? null,
      options.event.messageIndex,
      options.event.replyToEventId ?? null,
      occurredAt,
      options.event.sourceTimeZone,
      options.event.contentHash,
      options.event.redactionVersion,
      jsonValue(options.event.metadata)
    ]
  );
  await options.connection.execute(
    `INSERT INTO event_versions
       (id, account_id, collected_event_id, version, content_hash,
        sanitized_content, parser_version, redaction_version, metadata)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      eventVersionId,
      options.accountId,
      eventDatabaseId,
      options.event.contentHash,
      options.event.sanitizedContent,
      options.parserVersion,
      options.event.redactionVersion,
      jsonValue(options.event.metadata)
    ]
  );

  if (options.event.kind === "USER_PROMPT") {
    await options.connection.execute(
      `INSERT INTO prompt_entries
         (id, account_id, collected_event_id, device_id, session_id, project_id,
          occurred_at, source_time_zone, sanitized_content, content_hash, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stableDatabaseId("prompt", eventDatabaseId),
        options.accountId,
        eventDatabaseId,
        options.deviceId,
        options.sessionId,
        options.projectId,
        occurredAt,
        options.event.sourceTimeZone,
        options.event.sanitizedContent,
        options.event.contentHash,
        modelFrom(options.event)
      ]
    );
    return;
  }

  const promptEntryId = await promptIdForReply(
    options.connection,
    options.accountId,
    options.event.replyToEventId
  );
  await options.connection.execute(
    `INSERT INTO visible_results
       (id, account_id, collected_event_id, prompt_entry_id, device_id,
        session_id, project_id, occurred_at, sanitized_content, content_hash, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      stableDatabaseId("result", eventDatabaseId),
      options.accountId,
      eventDatabaseId,
      promptEntryId,
      options.deviceId,
      options.sessionId,
      options.projectId,
      occurredAt,
      options.event.sanitizedContent,
      options.event.contentHash,
      modelFrom(options.event)
    ]
  );
}

async function updateChangedEvent(options: {
  connection: PoolConnection;
  accountId: string;
  parserVersion: string;
  existing: EventRow;
  event: SyncEvent;
}): Promise<void> {
  const nextVersion = Number(options.existing.current_version) + 1;
  await options.connection.execute(
    `INSERT INTO event_versions
       (id, account_id, collected_event_id, version, content_hash,
        sanitized_content, parser_version, redaction_version, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      stableDatabaseId(
        "version",
        options.existing.id,
        options.event.contentHash
      ),
      options.accountId,
      options.existing.id,
      nextVersion,
      options.event.contentHash,
      options.event.sanitizedContent,
      options.parserVersion,
      options.event.redactionVersion,
      jsonValue(options.event.metadata)
    ]
  );
  await options.connection.execute(
    `UPDATE collected_events
        SET content_hash = ?, current_version = ?, redaction_version = ?, metadata = ?
      WHERE id = ? AND account_id = ?`,
    [
      options.event.contentHash,
      nextVersion,
      options.event.redactionVersion,
      jsonValue(options.event.metadata),
      options.existing.id,
      options.accountId
    ]
  );

  const detailTable =
    options.event.kind === "USER_PROMPT" ? "prompt_entries" : "visible_results";
  await options.connection.execute(
    `UPDATE ${detailTable}
        SET sanitized_content = ?, content_hash = ?, model = ?
      WHERE collected_event_id = ? AND account_id = ?`,
    [
      options.event.sanitizedContent,
      options.event.contentHash,
      modelFrom(options.event),
      options.existing.id,
      options.accountId
    ]
  );
}

export interface CommitSyncBatchOptions {
  pool: Pool;
  identity: DeviceIdentity;
  validated: ValidatedIncomingBatch;
  requestId: string;
}

export function isRetryableTransactionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { errno?: unknown; code?: unknown };
  return (
    value.errno === 1213 ||
    value.errno === 1205 ||
    value.code === "ER_LOCK_DEADLOCK" ||
    value.code === "ER_LOCK_WAIT_TIMEOUT"
  );
}

async function commitSyncBatchAttempt(
  options: CommitSyncBatchOptions
): Promise<SyncBatchResult> {
  validateSanitizedEvents(options.validated.payload.events);
  validateEventIdentities(
    options.validated.payload.events,
    options.identity,
    options.validated.payload.source
  );
  const { payload, payloadHash } = options.validated;
  const batchDatabaseId = stableDatabaseId(
    "batch",
    options.identity.accountId,
    options.identity.deviceId,
    payload.batchId
  );
  const connection = await options.pool.getConnection();
  let reusable = true;

  try {
    await connection.beginTransaction();
    await connection.execute<ResultSetHeader>(
      `INSERT INTO sync_batches
         (id, account_id, device_id, batch_id, protocol_version, source_type,
          source_instance_id, parser_version, payload_hash, status, received_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        batchDatabaseId,
        options.identity.accountId,
        options.identity.deviceId,
        payload.batchId,
        payload.protocolVersion,
        payload.source.type,
        payload.source.instanceId,
        payload.source.parserVersion,
        payloadHash,
        payload.events.length
      ]
    );
    const [batchRows] = await connection.execute<BatchRow[]>(
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
      batch.status === "COMMITTED" ||
      batch.status === "COMMITTED_WITH_WARNINGS"
    ) {
      const replay = SyncBatchResultSchema.parse(parsedJson(batch.result));
      await connection.commit();
      return replay;
    }

    const [accountRows] = await connection.execute<AccountTimeZoneRow[]>(
      "SELECT time_zone FROM accounts WHERE id = ? LIMIT 1",
      [options.identity.accountId]
    );
    const accountTimeZone = accountRows[0]?.time_zone;
    if (!accountTimeZone) throw new Error("ACCOUNT_NOT_FOUND");

    let insertedCount = 0;
    let duplicateCount = 0;
    let changedCount = 0;
    const dirtyWorkDates = new Set<string>();

    for (const event of [...payload.events].sort((left, right) =>
      left.eventId.localeCompare(right.eventId)
    )) {
      const project = await ensureProject(
        connection,
        options.identity.accountId,
        event
      );
      const sessionId = await ensureSession({
        connection,
        accountId: options.identity.accountId,
        deviceId: options.identity.deviceId,
        sourceType: payload.source.type,
        sourceInstanceId: payload.source.instanceId,
        parserVersion: payload.source.parserVersion,
        event,
        projectId: project.id
      });
      const [eventRows] = await connection.execute<EventRow[]>(
        `SELECT id, content_hash, current_version, device_id, session_id, kind,
                source_message_id, message_index, occurred_at
           FROM collected_events
          WHERE account_id = ? AND event_id = ?
          FOR UPDATE`,
        [options.identity.accountId, event.eventId]
      );
      const existing = eventRows[0] ?? null;
      if (
        existing &&
        (existing.device_id !== options.identity.deviceId ||
          existing.session_id !== sessionId ||
          existing.kind !== event.kind ||
          existing.source_message_id !== (event.sourceMessageId ?? null) ||
          Number(existing.message_index) !== event.messageIndex)
      ) {
        throw new EventIdentityMismatchError();
      }
      const [versionRows] = existing
        ? await connection.execute<VersionRow[]>(
            `SELECT content_hash FROM event_versions
              WHERE collected_event_id = ?`,
            [existing.id]
          )
        : [[] as VersionRow[], []];
      const mutation = classifyEventMutation(
        existing?.content_hash ?? null,
        versionRows.map((row) => row.content_hash),
        event.contentHash
      );

      if (mutation === "insert") {
        await insertNewEvent({
          connection,
          accountId: options.identity.accountId,
          deviceId: options.identity.deviceId,
          batchDatabaseId,
          sessionId,
          projectId: project.id,
          sourceType: payload.source.type,
          parserVersion: payload.source.parserVersion,
          event
        });
        insertedCount += 1;
        dirtyWorkDates.add(
          workDateInTimeZone(event.occurredAt, accountTimeZone)
        );
      } else if (mutation === "change" && existing) {
        await updateChangedEvent({
          connection,
          accountId: options.identity.accountId,
          parserVersion: payload.source.parserVersion,
          existing,
          event
        });
        changedCount += 1;
        dirtyWorkDates.add(
          workDateInTimeZone(existing.occurred_at, accountTimeZone)
        );
      } else {
        duplicateCount += 1;
      }
    }

    await connection.execute(
      `UPDATE visible_results vr
       JOIN collected_events result_event
         ON result_event.id = vr.collected_event_id
        AND result_event.account_id = vr.account_id
       JOIN collected_events prompt_event
         ON prompt_event.account_id = result_event.account_id
        AND prompt_event.device_id = result_event.device_id
        AND prompt_event.session_id = result_event.session_id
        AND prompt_event.event_id = result_event.reply_to_event_id
        AND prompt_event.kind = 'USER_PROMPT'
       JOIN prompt_entries pe
         ON pe.collected_event_id = prompt_event.id
        AND pe.account_id = prompt_event.account_id
          SET vr.prompt_entry_id = pe.id
        WHERE vr.account_id = ? AND vr.prompt_entry_id IS NULL`,
      [options.identity.accountId]
    );

    await markSummaryDatesDirty({
      connection,
      accountId: options.identity.accountId,
      workDates: dirtyWorkDates
    });

    const committedAt = new Date();
    const result: SyncBatchResult = {
      batchId: payload.batchId,
      status: "COMMITTED",
      receivedCount: payload.events.length,
      insertedCount,
      duplicateCount,
      changedCount,
      committedAt: committedAt.toISOString()
    };
    await connection.execute(
      `UPDATE sync_batches
          SET status = ?, inserted_count = ?, duplicate_count = ?, changed_count = ?,
              result = ?, committed_at = ?
        WHERE id = ?`,
      [
        result.status,
        insertedCount,
        duplicateCount,
        changedCount,
        jsonValue(result),
        committedAt,
        batchDatabaseId
      ]
    );
    await connection.execute(
      `UPDATE devices
          SET last_seen_at = ?, last_synced_at = ?, status = 'ACTIVE'
        WHERE id = ? AND account_id = ?`,
      [
        committedAt,
        committedAt,
        options.identity.deviceId,
        options.identity.accountId
      ]
    );
    await connection.execute(
      `INSERT INTO audit_logs
         (account_id, device_id, action, resource_type, resource_id,
          request_id, outcome, metadata)
       VALUES (?, ?, 'SYNC_BATCH_COMMITTED', 'SYNC_BATCH', ?, ?, 'SUCCEEDED', ?)`,
      [
        options.identity.accountId,
        options.identity.deviceId,
        payload.batchId,
        options.requestId,
        jsonValue({
          receivedCount: result.receivedCount,
          insertedCount,
          duplicateCount,
          changedCount
        })
      ]
    );
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {
      reusable = false;
    });
    throw error;
  } finally {
    if (reusable) connection.release();
    else connection.destroy();
  }
}

export async function commitSyncBatch(
  options: CommitSyncBatchOptions
): Promise<SyncBatchResult> {
  validateSanitizedEvents(options.validated.payload.events);
  validateEventIdentities(
    options.validated.payload.events,
    options.identity,
    options.validated.payload.source
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await commitSyncBatchAttempt(options);
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt === 2) throw error;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 15 * (attempt + 1) + Math.floor(Math.random() * 20))
      );
    }
  }
  throw new Error("SYNC_TRANSACTION_RETRY_EXHAUSTED");
}
