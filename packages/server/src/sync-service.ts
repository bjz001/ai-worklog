import type {
  AgentSourceType,
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
import type { ValidatedIncomingV1Batch } from "@ai-worklog/sync";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket
} from "mysql2/promise";
import { InvalidAuthorizationError, type DeviceIdentity } from "./auth";
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

export interface EventRow extends RowDataPacket {
  id: string;
  account_id: string;
  event_id: string;
  content_hash: string;
  current_version: number;
  device_id: string;
  session_id: string;
  project_id: string | null;
  kind: "USER" | "USER_PROMPT" | "VISIBLE_RESULT";
  source_message_id: string | null;
  message_index: number;
  reply_to_event_id: string | null;
  occurred_at: Date;
  current_sanitized_content: string;
  legacy_source_session_id: string;
  legacy_source_type: AgentSourceType;
  legacy_source_instance_id: string;
}

interface LegacyEventAlias {
  eventId: string;
  sourceSessionId: string;
}

export function compatibleStoredEventIdentity(
  existing: Pick<
    EventRow,
    | "device_id"
    | "session_id"
    | "kind"
    | "source_message_id"
    | "message_index"
  >,
  incoming: {
    deviceId: string;
    sessionId: string;
    event: Pick<SyncEvent, "kind" | "sourceMessageId" | "messageIndex">;
  }
): boolean {
  const sourceMessageId = incoming.event.sourceMessageId ?? null;
  return (
    existing.device_id === incoming.deviceId &&
    existing.session_id === incoming.sessionId &&
    (
      existing.kind === incoming.event.kind ||
      (existing.kind === "USER" && incoming.event.kind === "USER_PROMPT")
    ) &&
    existing.source_message_id === sourceMessageId &&
    (sourceMessageId !== null ||
      Number(existing.message_index) === incoming.event.messageIndex)
  );
}

interface LegacyAliasIdentityOptions {
  accountId: string;
  deviceId: string;
  sessionId: string;
  source: SyncBatchRequest["source"];
  event: SyncEvent;
  legacyAlias: LegacyEventAlias;
  legacyVersionContentHashes?: readonly string[];
}

function legacyEventAliasesFromMetadata(
  source: SyncBatchRequest["source"],
  event: SyncEvent
): LegacyEventAlias[] {
  if (source.type !== "CODEX" || source.parserVersion !== "codex-jsonl-v4") {
    return [];
  }
  const candidates: LegacyEventAlias[] = [];
  if (
    typeof event.metadata.legacyEventId === "string" &&
    /^[a-f0-9]{64}$/u.test(event.metadata.legacyEventId)
  ) {
    candidates.push({
      eventId: event.metadata.legacyEventId,
      sourceSessionId: event.sourceSessionId
    });
  }
  if (Array.isArray(event.metadata.legacyEventAliases)) {
    for (const value of event.metadata.legacyEventAliases.slice(0, 4)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const alias = value as Record<string, unknown>;
      if (
        typeof alias.eventId === "string" &&
        /^[a-f0-9]{64}$/u.test(alias.eventId) &&
        typeof alias.sourceSessionId === "string" &&
        alias.sourceSessionId.length > 0 &&
        alias.sourceSessionId.length <= 255
      ) {
        candidates.push({
          eventId: alias.eventId,
          sourceSessionId: alias.sourceSessionId
        });
      }
    }
  }
  return candidates.filter((alias, index, aliases) =>
    alias.eventId !== event.eventId &&
    aliases.findIndex((candidate) => candidate.eventId === alias.eventId) === index
  ).slice(0, 4);
}

type LegacyStoredEventCompatibility =
  | "compatible"
  | "content-mismatch"
  | "identity-mismatch";

function legacyStoredEventCompatibility(
  existing: Pick<
    EventRow,
    | "account_id"
    | "event_id"
    | "device_id"
    | "session_id"
    | "kind"
    | "source_message_id"
    | "message_index"
    | "content_hash"
    | "occurred_at"
    | "current_sanitized_content"
    | "legacy_source_session_id"
    | "legacy_source_type"
    | "legacy_source_instance_id"
  >,
  incoming: LegacyAliasIdentityOptions
): LegacyStoredEventCompatibility {
  if (
    incoming.source.type !== "CODEX" ||
    incoming.source.parserVersion !== "codex-jsonl-v4" ||
    existing.account_id !== incoming.accountId ||
    existing.event_id !== incoming.legacyAlias.eventId ||
    existing.device_id !== incoming.deviceId ||
    existing.kind !== incoming.event.kind ||
    existing.legacy_source_type !== incoming.source.type ||
    existing.legacy_source_instance_id !== incoming.source.instanceId ||
    existing.legacy_source_session_id !== incoming.legacyAlias.sourceSessionId ||
    (incoming.legacyAlias.sourceSessionId === incoming.event.sourceSessionId &&
      existing.session_id !== incoming.sessionId) ||
    Math.abs(
      new Date(existing.occurred_at).getTime() -
        new Date(incoming.event.occurredAt).getTime()
    ) > 2_000
  ) {
    return "identity-mismatch";
  }

  if (buildEventId({
    accountId: incoming.accountId,
    deviceId: incoming.deviceId,
    sourceType: incoming.source.type,
    sourceInstanceId: incoming.source.instanceId,
    sourceSessionId: incoming.legacyAlias.sourceSessionId,
    sourceMessageId: existing.source_message_id,
    messageIndex: Number(existing.message_index)
  }) !== incoming.legacyAlias.eventId) {
    return "identity-mismatch";
  }

  const storedContent = existing.current_sanitized_content
    .replace(/\s+/gu, " ")
    .trim();
  const incomingContent = incoming.event.sanitizedContent
    .replace(/\s+/gu, " ")
    .trim();
  const contentMatches =
    existing.content_hash === incoming.event.contentHash ||
    incoming.legacyVersionContentHashes?.includes(
      incoming.event.contentHash
    ) === true ||
    storedContent === incomingContent ||
    (incomingContent.length >= 1 &&
      storedContent.endsWith(` ${incomingContent}`)) ||
    (Math.min(storedContent.length, incomingContent.length) >= 8 &&
      (storedContent.includes(incomingContent) ||
        incomingContent.includes(storedContent)));
  return contentMatches ? "compatible" : "content-mismatch";
}

export function compatibleLegacyStoredEventIdentity(
  existing: Parameters<typeof legacyStoredEventCompatibility>[0],
  incoming: LegacyAliasIdentityOptions
): boolean {
  return legacyStoredEventCompatibility(existing, incoming) === "compatible";
}

const EVENT_ROW_SELECT = `ce.id, ce.account_id, ce.event_id, ce.content_hash,
  ce.current_version, ce.device_id, ce.session_id, ce.project_id, ce.kind,
  ce.source_message_id, ce.message_index, ce.reply_to_event_id,
  ce.occurred_at, COALESCE(ev.sanitized_content, '') AS current_sanitized_content,
  source_session.source_session_id AS legacy_source_session_id,
  source_session.source_type AS legacy_source_type,
  source_session.source_instance_id AS legacy_source_instance_id`;

async function lockedEventById(
  connection: Pick<PoolConnection, "execute">,
  accountId: string,
  eventId: string
): Promise<EventRow | null> {
  const [rows] = await connection.execute<EventRow[]>(
    `SELECT ${EVENT_ROW_SELECT}
       FROM collected_events ce
       LEFT JOIN event_versions ev
         ON ev.collected_event_id = ce.id
        AND ev.version = ce.current_version
       JOIN sessions source_session
         ON source_session.id = ce.session_id
        AND source_session.account_id = ce.account_id
      WHERE ce.account_id = ? AND ce.event_id = ?
      FOR UPDATE`,
    [accountId, eventId]
  );
  return rows[0] ?? null;
}

interface EventVersionContentHashRow extends RowDataPacket {
  content_hash: string;
}

async function lockedEventVersionContentHashes(
  connection: Pick<PoolConnection, "execute">,
  accountId: string,
  collectedEventId: string
): Promise<string[]> {
  const [rows] = await connection.execute<EventVersionContentHashRow[]>(
    `SELECT content_hash
       FROM event_versions
      WHERE account_id = ? AND collected_event_id = ?
      ORDER BY version
      FOR UPDATE`,
    [accountId, collectedEventId]
  );
  return rows.map((row) => row.content_hash);
}

async function migrateLegacyEventInPlace(options: {
  connection: Pick<PoolConnection, "execute">;
  accountId: string;
  deviceId: string;
  sessionId: string;
  projectId: string;
  event: SyncEvent;
  legacy: EventRow;
  alias: LegacyEventAlias;
}): Promise<EventRow> {
  const [migration] = await options.connection.execute<ResultSetHeader>(
    `UPDATE collected_events
        SET event_id = ?, source_message_id = ?, message_index = ?,
            reply_to_event_id = ?, session_id = ?, project_id = ?
      WHERE id = ? AND account_id = ? AND device_id = ? AND session_id = ?
        AND kind = ? AND event_id = ?`,
    [
      options.event.eventId,
      options.event.sourceMessageId ?? null,
      options.event.messageIndex,
      options.event.replyToEventId ?? null,
      options.sessionId,
      options.projectId,
      options.legacy.id,
      options.accountId,
      options.deviceId,
      options.legacy.session_id,
      options.event.kind,
      options.alias.eventId
    ]
  );
  if (migration.affectedRows !== 1) throw new EventIdentityMismatchError();

  if (options.event.kind === "USER_PROMPT") {
    await options.connection.execute<ResultSetHeader>(
      `UPDATE prompt_entries
          SET session_id = ?,
              project_id = IF(is_manual_project_override, project_id, ?)
        WHERE collected_event_id = ? AND account_id = ? AND device_id = ?
          AND session_id = ?`,
      [
        options.sessionId,
        options.projectId,
        options.legacy.id,
        options.accountId,
        options.deviceId,
        options.legacy.session_id
      ]
    );
  } else {
    const promptEntryId = await promptIdForReply(
      options.connection,
      options.accountId,
      options.event.replyToEventId
    );
    await options.connection.execute<ResultSetHeader>(
      `UPDATE visible_results
          SET session_id = ?, project_id = ?, prompt_entry_id = ?
        WHERE collected_event_id = ? AND account_id = ? AND device_id = ?
          AND session_id = ?`,
      [
        options.sessionId,
        options.projectId,
        promptEntryId,
        options.legacy.id,
        options.accountId,
        options.deviceId,
        options.legacy.session_id
      ]
    );
  }

  const replySessionIds = [...new Set([
    options.legacy.session_id,
    options.sessionId
  ])].sort();
  await options.connection.execute<ResultSetHeader>(
    `UPDATE collected_events
        SET reply_to_event_id = ?
      WHERE account_id = ? AND device_id = ?
        AND session_id IN (${replySessionIds.map(() => "?").join(", ")})
        AND reply_to_event_id = ?`,
    [
      options.event.eventId,
      options.accountId,
      options.deviceId,
      ...replySessionIds,
      options.alias.eventId
    ]
  );

  return {
    ...options.legacy,
    event_id: options.event.eventId,
    source_message_id: options.event.sourceMessageId ?? null,
    message_index: options.event.messageIndex,
    reply_to_event_id: options.event.replyToEventId ?? null,
    session_id: options.sessionId,
    project_id: options.projectId
  };
}

interface StoredVersionRow extends RowDataPacket {
  collected_event_id: string;
  version: number;
  content_hash: string;
  sanitized_content: string;
  parser_version: string;
  redaction_version: string;
  metadata: unknown;
  created_at: Date;
}

interface DetailIdentityRow extends RowDataPacket {
  id: string;
  collected_event_id: string;
  prompt_entry_id?: string | null;
}

interface JsonDocumentRow extends RowDataPacket {
  id: string;
  document: unknown;
}

function replaceJsonStringReference(
  value: unknown,
  from: string,
  to: string,
  depth = 0
): unknown {
  if (depth > 32) return value;
  if (typeof value === "string") return value === from ? to : value;
  if (Array.isArray(value)) {
    return value.map((item) =>
      replaceJsonStringReference(item, from, to, depth + 1)
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      replaceJsonStringReference(item, from, to, depth + 1)
    ]));
  }
  return value;
}

async function rewriteJsonEvidenceReferences(options: {
  connection: Pick<PoolConnection, "execute">;
  accountId: string;
  fromEventDatabaseId: string;
  toEventDatabaseId: string;
}): Promise<void> {
  const documents = [
    { table: "daily_summaries", column: "content" },
    { table: "skill_candidates", column: "proposal" }
  ] as const;
  for (const document of documents) {
    const [rows] = await options.connection.execute<JsonDocumentRow[]>(
      `SELECT id, ${document.column} AS document
         FROM ${document.table}
        WHERE account_id = ?
          AND JSON_SEARCH(${document.column}, 'one', ?) IS NOT NULL
        FOR UPDATE`,
      [options.accountId, options.fromEventDatabaseId]
    );
    for (const row of rows) {
      const parsed = parsedJson(row.document);
      const replaced = replaceJsonStringReference(
        parsed,
        options.fromEventDatabaseId,
        options.toEventDatabaseId
      );
      await options.connection.execute(
        `UPDATE ${document.table}
            SET ${document.column} = ?
          WHERE id = ? AND account_id = ?`,
        [jsonValue(replaced), row.id, options.accountId]
      );
    }
  }
}

async function mergeCanonicalDuplicateIntoLegacy(options: {
  connection: Pick<PoolConnection, "execute">;
  accountId: string;
  deviceId: string;
  sessionId: string;
  projectId: string;
  parserVersion: string;
  event: SyncEvent;
  canonical: EventRow;
  legacy: EventRow;
  alias: LegacyEventAlias;
}): Promise<EventRow> {
  const [versions] = await options.connection.execute<StoredVersionRow[]>(
    `SELECT collected_event_id, version, content_hash, sanitized_content,
            parser_version, redaction_version, metadata, created_at
       FROM event_versions
      WHERE account_id = ? AND collected_event_id IN (?, ?)
      ORDER BY collected_event_id, version
      FOR UPDATE`,
    [options.accountId, options.canonical.id, options.legacy.id]
  );
  const legacyVersions = versions.filter((row) =>
    row.collected_event_id === options.legacy.id
  );
  const legacyVersionByHash = new Map(
    legacyVersions.map((row) => [row.content_hash, Number(row.version)])
  );
  let nextVersion = legacyVersions.reduce(
    (maximum, row) => Math.max(maximum, Number(row.version)),
    0
  );
  for (const version of versions.filter((row) =>
    row.collected_event_id === options.canonical.id
  )) {
    if (legacyVersionByHash.has(version.content_hash)) continue;
    nextVersion += 1;
    await options.connection.execute(
      `INSERT INTO event_versions
         (id, account_id, collected_event_id, version, content_hash,
          sanitized_content, parser_version, redaction_version, metadata,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stableDatabaseId(
          "version",
          options.legacy.id,
          version.content_hash
        ),
        options.accountId,
        options.legacy.id,
        nextVersion,
        version.content_hash,
        version.sanitized_content,
        version.parser_version,
        version.redaction_version,
        jsonValue(parsedJson(version.metadata) ?? {}),
        version.created_at
      ]
    );
    legacyVersionByHash.set(version.content_hash, nextVersion);
  }
  if (!legacyVersionByHash.has(options.event.contentHash)) {
    nextVersion += 1;
    await options.connection.execute(
      `INSERT INTO event_versions
         (id, account_id, collected_event_id, version, content_hash,
          sanitized_content, parser_version, redaction_version, metadata,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stableDatabaseId(
          "version",
          options.legacy.id,
          options.event.contentHash
        ),
        options.accountId,
        options.legacy.id,
        nextVersion,
        options.event.contentHash,
        options.event.sanitizedContent,
        options.parserVersion,
        options.event.redactionVersion,
        jsonValue(options.event.metadata),
        new Date(options.event.occurredAt)
      ]
    );
    legacyVersionByHash.set(options.event.contentHash, nextVersion);
  }
  const activeVersion = legacyVersionByHash.get(options.event.contentHash);
  if (activeVersion === undefined) throw new EventIdentityMismatchError();

  await rewriteJsonEvidenceReferences({
    connection: options.connection,
    accountId: options.accountId,
    fromEventDatabaseId: options.canonical.id,
    toEventDatabaseId: options.legacy.id
  });

  await options.connection.execute(
    `DELETE canonical_evidence
       FROM summary_evidence canonical_evidence
       JOIN summary_evidence legacy_evidence
         ON legacy_evidence.account_id = canonical_evidence.account_id
        AND legacy_evidence.summary_id = canonical_evidence.summary_id
        AND legacy_evidence.claim_key = canonical_evidence.claim_key
        AND legacy_evidence.collected_event_id = ?
      WHERE canonical_evidence.account_id = ?
        AND canonical_evidence.collected_event_id = ?`,
    [options.legacy.id, options.accountId, options.canonical.id]
  );
  await options.connection.execute(
    `UPDATE summary_evidence
        SET collected_event_id = ?
      WHERE account_id = ? AND collected_event_id = ?`,
    [options.legacy.id, options.accountId, options.canonical.id]
  );

  const detailTable = options.event.kind === "USER_PROMPT"
    ? "prompt_entries"
    : "visible_results";
  const [detailRows] = await options.connection.execute<DetailIdentityRow[]>(
    `SELECT id, collected_event_id${
      options.event.kind === "VISIBLE_RESULT" ? ", prompt_entry_id" : ""
    }
       FROM ${detailTable}
      WHERE account_id = ? AND collected_event_id IN (?, ?)
      FOR UPDATE`,
    [options.accountId, options.canonical.id, options.legacy.id]
  );
  const canonicalDetail = detailRows.find((row) =>
    row.collected_event_id === options.canonical.id
  );
  const legacyDetail = detailRows.find((row) =>
    row.collected_event_id === options.legacy.id
  );

  if (canonicalDetail && legacyDetail && options.event.kind === "USER_PROMPT") {
    await options.connection.execute(
      `UPDATE visible_results
          SET prompt_entry_id = ?
        WHERE account_id = ? AND prompt_entry_id = ?`,
      [legacyDetail.id, options.accountId, canonicalDetail.id]
    );
    await options.connection.execute(
      `UPDATE prompt_entries legacy_prompt
       JOIN prompt_entries canonical_prompt ON canonical_prompt.id = ?
          SET legacy_prompt.is_favorite =
                legacy_prompt.is_favorite OR canonical_prompt.is_favorite,
              legacy_prompt.project_id = CASE
                WHEN legacy_prompt.is_manual_project_override
                  THEN legacy_prompt.project_id
                WHEN canonical_prompt.is_manual_project_override
                  THEN canonical_prompt.project_id
                ELSE ?
              END,
              legacy_prompt.is_manual_project_override =
                legacy_prompt.is_manual_project_override OR
                canonical_prompt.is_manual_project_override,
              legacy_prompt.session_id = ?,
              legacy_prompt.sanitized_content = ?,
              legacy_prompt.content_hash = ?,
              legacy_prompt.model = ?
        WHERE legacy_prompt.id = ? AND legacy_prompt.account_id = ?`,
      [
        canonicalDetail.id,
        options.projectId,
        options.sessionId,
        options.event.sanitizedContent,
        options.event.contentHash,
        modelFrom(options.event),
        legacyDetail.id,
        options.accountId
      ]
    );
    await options.connection.execute(
      "DELETE FROM prompt_entries WHERE id = ? AND account_id = ?",
      [canonicalDetail.id, options.accountId]
    );
  } else if (
    canonicalDetail &&
    legacyDetail &&
    options.event.kind === "VISIBLE_RESULT"
  ) {
    await options.connection.execute(
      `UPDATE visible_results legacy_result
       JOIN visible_results canonical_result ON canonical_result.id = ?
          SET legacy_result.session_id = ?,
              legacy_result.project_id = ?,
              legacy_result.sanitized_content = ?,
              legacy_result.content_hash = ?,
              legacy_result.model = ?
        WHERE legacy_result.id = ? AND legacy_result.account_id = ?`,
      [
        canonicalDetail.id,
        options.sessionId,
        options.projectId,
        options.event.sanitizedContent,
        options.event.contentHash,
        modelFrom(options.event),
        legacyDetail.id,
        options.accountId
      ]
    );
    await options.connection.execute(
      "DELETE FROM visible_results WHERE id = ? AND account_id = ?",
      [canonicalDetail.id, options.accountId]
    );
  } else if (!legacyDetail && canonicalDetail) {
    const projectAssignment = options.event.kind === "USER_PROMPT"
      ? "IF(is_manual_project_override, project_id, ?)"
      : "?";
    await options.connection.execute(
      `UPDATE ${detailTable}
          SET collected_event_id = ?, session_id = ?,
              project_id = ${projectAssignment}
        WHERE id = ? AND account_id = ?`,
      [
        options.legacy.id,
        options.sessionId,
        options.projectId,
        canonicalDetail.id,
        options.accountId
      ]
    );
  }

  if (options.event.kind === "USER_PROMPT") {
    await options.connection.execute(
      `UPDATE prompt_entries
          SET session_id = ?,
              project_id = IF(is_manual_project_override, project_id, ?),
              sanitized_content = ?, content_hash = ?, model = ?
        WHERE account_id = ? AND collected_event_id = ?`,
      [
        options.sessionId,
        options.projectId,
        options.event.sanitizedContent,
        options.event.contentHash,
        modelFrom(options.event),
        options.accountId,
        options.legacy.id
      ]
    );
  }

  if (options.event.kind === "VISIBLE_RESULT") {
    const promptEntryId = await promptIdForReply(
      options.connection,
      options.accountId,
      options.event.replyToEventId
    );
    await options.connection.execute(
      `UPDATE visible_results
          SET prompt_entry_id = ?, session_id = ?, project_id = ?,
              sanitized_content = ?, content_hash = ?, model = ?
        WHERE account_id = ? AND collected_event_id = ?`,
      [
        promptEntryId,
        options.sessionId,
        options.projectId,
        options.event.sanitizedContent,
        options.event.contentHash,
        modelFrom(options.event),
        options.accountId,
        options.legacy.id
      ]
    );
  }

  const replySessionIds = [...new Set([
    options.legacy.session_id,
    options.sessionId
  ])].sort();
  await options.connection.execute(
    `UPDATE collected_events
        SET reply_to_event_id = ?
      WHERE account_id = ? AND device_id = ?
        AND session_id IN (${replySessionIds.map(() => "?").join(", ")})
        AND reply_to_event_id = ?`,
    [
      options.event.eventId,
      options.accountId,
      options.deviceId,
      ...replySessionIds,
      options.alias.eventId
    ]
  );
  const [deleted] = await options.connection.execute<ResultSetHeader>(
    `DELETE FROM collected_events
      WHERE id = ? AND account_id = ? AND device_id = ? AND kind = ?
        AND event_id = ?`,
    [
      options.canonical.id,
      options.accountId,
      options.deviceId,
      options.event.kind,
      options.event.eventId
    ]
  );
  if (deleted.affectedRows !== 1) throw new EventIdentityMismatchError();

  const [migrated] = await options.connection.execute<ResultSetHeader>(
    `UPDATE collected_events
        SET event_id = ?, source_message_id = ?, message_index = ?,
            reply_to_event_id = ?, session_id = ?, project_id = ?,
            content_hash = ?, current_version = ?, redaction_version = ?,
            metadata = ?
      WHERE id = ? AND account_id = ? AND device_id = ? AND session_id = ?
        AND kind = ? AND event_id = ?`,
    [
      options.event.eventId,
      options.event.sourceMessageId ?? null,
      options.event.messageIndex,
      options.event.replyToEventId ?? null,
      options.sessionId,
      options.projectId,
      options.event.contentHash,
      activeVersion,
      options.event.redactionVersion,
      jsonValue(options.event.metadata),
      options.legacy.id,
      options.accountId,
      options.deviceId,
      options.legacy.session_id,
      options.event.kind,
      options.alias.eventId
    ]
  );
  if (migrated.affectedRows !== 1) throw new EventIdentityMismatchError();

  return {
    ...options.legacy,
    event_id: options.event.eventId,
    content_hash: options.event.contentHash,
    current_version: activeVersion,
    source_message_id: options.event.sourceMessageId ?? null,
    message_index: options.event.messageIndex,
    reply_to_event_id: options.event.replyToEventId ?? null,
    session_id: options.sessionId,
    project_id: options.projectId
  };
}

export async function resolveStoredEventIdentity(options: {
  connection: Pick<PoolConnection, "execute">;
  accountId: string;
  deviceId: string;
  sessionId: string;
  projectId: string;
  source: SyncBatchRequest["source"];
  event: SyncEvent;
}): Promise<{ existing: EventRow | null; migrated: boolean }> {
  let survivor = await lockedEventById(
    options.connection,
    options.accountId,
    options.event.eventId
  );
  if (survivor && !compatibleStoredEventIdentity(survivor, {
    deviceId: options.deviceId,
    sessionId: options.sessionId,
    event: options.event
  })) {
    throw new EventIdentityMismatchError();
  }

  const aliases = legacyEventAliasesFromMetadata(options.source, options.event);
  let migrated = false;
  for (const alias of aliases) {
    const legacy = await lockedEventById(
      options.connection,
      options.accountId,
      alias.eventId
    );
    if (!legacy) continue;
    const compatibilityOptions = {
      accountId: options.accountId,
      deviceId: options.deviceId,
      sessionId: options.sessionId,
      source: options.source,
      event: options.event,
      legacyAlias: alias
    };
    let compatibility = legacyStoredEventCompatibility(
      legacy,
      compatibilityOptions
    );
    if (compatibility === "content-mismatch") {
      const legacyVersionContentHashes =
        await lockedEventVersionContentHashes(
          options.connection,
          options.accountId,
          legacy.id
        );
      compatibility = legacyStoredEventCompatibility(legacy, {
        ...compatibilityOptions,
        legacyVersionContentHashes
      });
    }
    if (compatibility !== "compatible") continue;
    if (survivor) {
      if (survivor.id === legacy.id) continue;
      survivor = await mergeCanonicalDuplicateIntoLegacy({
        connection: options.connection,
        accountId: options.accountId,
        deviceId: options.deviceId,
        sessionId: options.sessionId,
        projectId: options.projectId,
        parserVersion: options.source.parserVersion,
        event: options.event,
        canonical: survivor,
        legacy,
        alias
      });
    } else {
      survivor = await migrateLegacyEventInPlace({
        connection: options.connection,
        accountId: options.accountId,
        deviceId: options.deviceId,
        sessionId: options.sessionId,
        projectId: options.projectId,
        event: options.event,
        legacy,
        alias
      });
    }
    migrated = true;
  }
  return { existing: survivor, migrated };
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
  sourceType: AgentSourceType;
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

  // Prompt-only agent connectors still know the project from their RUN
  // record. If an earlier import created this session as unclassified, allow
  // a later parser run with a real hint to promote the whole session. Manual
  // project assignments remain authoritative.
  if (options.event.projectHint) {
    const [existingRows] = await options.connection.execute<Array<RowDataPacket & {
      project_id: string | null;
      classification_source: string | null;
      is_manual_override: number | boolean | null;
    }>>(
      `SELECT s.project_id, p.classification_source, p.is_manual_override
         FROM sessions s
         LEFT JOIN projects p
           ON p.id = s.project_id AND p.account_id = s.account_id
        WHERE s.id = ? AND s.account_id = ?
        FOR UPDATE`,
      [sessionId, options.accountId]
    );
    const existing = existingRows[0];
    if (
      existing?.project_id &&
      existing.project_id !== options.projectId &&
      existing.classification_source === "UNCLASSIFIED" &&
      !existing.is_manual_override
    ) {
      await options.connection.execute(
        `UPDATE sessions
            SET project_id = ?, updated_at = UTC_TIMESTAMP(6)
          WHERE id = ? AND account_id = ?`,
        [options.projectId, sessionId, options.accountId]
      );
      await options.connection.execute(
        `UPDATE collected_events
            SET project_id = ?
          WHERE account_id = ? AND session_id = ?`,
        [options.projectId, options.accountId, sessionId]
      );
      await options.connection.execute(
        `UPDATE prompt_entries
            SET project_id = ?
          WHERE account_id = ? AND session_id = ?
            AND is_manual_project_override = FALSE`,
        [options.projectId, options.accountId, sessionId]
      );
      await options.connection.execute(
        `UPDATE visible_results
            SET project_id = ?
          WHERE account_id = ? AND session_id = ?`,
        [options.projectId, options.accountId, sessionId]
      );
    }
  }

  await options.connection.execute(
    `INSERT INTO sessions
       (id, account_id, device_id, project_id, source_type, source_instance_id,
        source_session_id, source_session_key, parser_version, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      sha256Hex(options.event.sourceSessionId),
      options.parserVersion,
      occurredAt,
      occurredAt
    ]
  );
  return sessionId;
}

async function promptIdForReply(
  connection: Pick<PoolConnection, "execute">,
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
  sourceType: AgentSourceType;
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

async function promoteLegacyAgentUserEvent(options: {
  connection: PoolConnection;
  accountId: string;
  deviceId: string;
  batchDatabaseId: string;
  sessionId: string;
  projectId: string;
  event: SyncEvent;
  existing: EventRow;
}): Promise<void> {
  const [existingVersions] = await options.connection.execute<VersionRow[]>(
    `SELECT id, version
       FROM event_versions
      WHERE account_id = ? AND collected_event_id = ? AND content_hash = ?
      LIMIT 1`,
    [options.accountId, options.existing.id, options.event.contentHash]
  );
  let version = existingVersions[0]?.version;
  if (version === undefined) {
    const [maxRows] = await options.connection.execute<
      Array<RowDataPacket & { max_version: number }>
    >(
      `SELECT COALESCE(MAX(version), 0) AS max_version
         FROM event_versions
        WHERE account_id = ? AND collected_event_id = ?`,
      [options.accountId, options.existing.id]
    );
    version = Number(maxRows[0]?.max_version ?? 0) + 1;
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
        version,
        options.event.contentHash,
        options.event.sanitizedContent,
        "prompt-v1",
        options.event.redactionVersion,
        jsonValue(options.event.metadata)
      ]
    );
  }

  await options.connection.execute(
    `UPDATE collected_events
        SET sync_batch_id = ?, session_id = ?, project_id = ?, kind = 'USER_PROMPT',
            source_message_id = ?, message_index = ?, reply_to_event_id = ?,
            occurred_at = ?, source_time_zone = ?, content_hash = ?,
            current_version = ?, redaction_version = ?, metadata = ?
      WHERE id = ? AND account_id = ? AND device_id = ? AND kind = 'USER'`,
    [
      options.batchDatabaseId,
      options.sessionId,
      options.projectId,
      options.event.sourceMessageId ?? null,
      options.event.messageIndex,
      options.event.replyToEventId ?? null,
      new Date(options.event.occurredAt),
      options.event.sourceTimeZone,
      options.event.contentHash,
      version,
      options.event.redactionVersion,
      jsonValue(options.event.metadata),
      options.existing.id,
      options.accountId,
      options.deviceId
    ]
  );
  await options.connection.execute(
    `INSERT INTO prompt_entries
       (id, account_id, collected_event_id, device_id, session_id, project_id,
        occurred_at, source_time_zone, sanitized_content, content_hash, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       session_id = VALUES(session_id),
       project_id = VALUES(project_id),
       occurred_at = VALUES(occurred_at),
       source_time_zone = VALUES(source_time_zone),
       sanitized_content = VALUES(sanitized_content),
       content_hash = VALUES(content_hash),
       model = VALUES(model)`,
    [
      stableDatabaseId("prompt", options.existing.id),
      options.accountId,
      options.existing.id,
      options.deviceId,
      options.sessionId,
      options.projectId,
      new Date(options.event.occurredAt),
      options.event.sourceTimeZone,
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
  const [versionRows] = await options.connection.execute<
    Array<RowDataPacket & { max_version: number }>
  >(
    `SELECT COALESCE(MAX(version), 0) AS max_version
       FROM event_versions
      WHERE collected_event_id = ? AND account_id = ?`,
    [options.existing.id, options.accountId]
  );
  const nextVersion = Number(versionRows[0]?.max_version ?? 0) + 1;
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

export async function backfillVisibleResultPromptLinks(options: {
  connection: Pick<PoolConnection, "execute">;
  accountId: string;
  deviceId: string;
  sessionIds: Iterable<string>;
}): Promise<void> {
  const sessionIds = [...new Set(options.sessionIds)].sort();
  if (sessionIds.length === 0) return;
  const sessionPlaceholders = sessionIds.map(() => "?").join(", ");
  await options.connection.execute(
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
      WHERE vr.account_id = ?
        AND result_event.device_id = ?
        AND result_event.session_id IN (${sessionPlaceholders})
        AND vr.prompt_entry_id IS NULL`,
    [options.accountId, options.deviceId, ...sessionIds]
  );
}

export interface CommitSyncBatchOptions {
  pool: Pool;
  identity: DeviceIdentity;
  validated: ValidatedIncomingV1Batch;
  requestId: string;
}

interface CredentialLockRow extends RowDataPacket {
  id: string;
}

export async function lockActiveDeviceCredential(options: {
  connection: Pick<PoolConnection, "execute">;
  identity: DeviceIdentity;
}): Promise<void> {
  const [deviceRows] = await options.connection.execute<CredentialLockRow[]>(
    `SELECT id
       FROM devices
      WHERE id = ? AND account_id = ? AND status = 'ACTIVE'
      FOR UPDATE`,
    [options.identity.deviceId, options.identity.accountId]
  );
  if (!deviceRows[0]) throw new InvalidAuthorizationError();

  const [tokenRows] = await options.connection.execute<CredentialLockRow[]>(
    `SELECT id
       FROM device_tokens
      WHERE id = ? AND account_id = ? AND device_id = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(6))
      FOR UPDATE`,
    [
      options.identity.deviceTokenId,
      options.identity.accountId,
      options.identity.deviceId
    ]
  );
  if (!tokenRows[0]) throw new InvalidAuthorizationError();
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
    await lockActiveDeviceCredential({
      connection,
      identity: options.identity
    });
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
    const touchedSessionIds = new Set<string>();

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
      touchedSessionIds.add(sessionId);
      const resolvedIdentity = await resolveStoredEventIdentity({
        connection,
        accountId: options.identity.accountId,
        deviceId: options.identity.deviceId,
        sessionId,
        projectId: project.id,
        source: payload.source,
        event
      });
      const existing = resolvedIdentity.existing;
      if (existing && !compatibleStoredEventIdentity(existing, {
        deviceId: options.identity.deviceId,
        sessionId,
        event
      })) {
        throw new EventIdentityMismatchError();
      }
      if (existing?.kind === "USER" && event.kind === "USER_PROMPT") {
        await promoteLegacyAgentUserEvent({
          connection,
          accountId: options.identity.accountId,
          deviceId: options.identity.deviceId,
          batchDatabaseId,
          sessionId,
          projectId: project.id,
          event,
          existing
        });
        changedCount += 1;
        dirtyWorkDates.add(
          workDateInTimeZone(event.occurredAt, accountTimeZone)
        );
        continue;
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
      if (resolvedIdentity.migrated) {
        dirtyWorkDates.add(
          workDateInTimeZone(existing?.occurred_at ?? event.occurredAt, accountTimeZone)
        );
      }
    }

    await backfillVisibleResultPromptLinks({
      connection,
      accountId: options.identity.accountId,
      deviceId: options.identity.deviceId,
      sessionIds: touchedSessionIds
    });

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
