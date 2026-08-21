import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  date,
  datetime,
  index,
  int,
  json,
  longtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar
} from "drizzle-orm/mysql-core";

const createdAt = () =>
  datetime("created_at", { fsp: 6, mode: "date" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(6)`);

const updatedAt = () =>
  datetime("updated_at", { fsp: 6, mode: "date" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(6)`)
    // Drizzle 0.44's datetime runtime lacks onUpdateNow(); this preserves
    // application updates while the handwritten DDL enforces database updates.
    .$onUpdate(() => new Date());

export const accounts = mysqlTable("accounts", {
  id: varchar("id", { length: 64 }).primaryKey(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  timeZone: varchar("time_zone", { length: 64 }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const llmSettings = mysqlTable("llm_settings", {
  accountId: varchar("account_id", { length: 64 })
    .primaryKey()
    .references(() => accounts.id, {
      onDelete: "cascade",
      onUpdate: "cascade"
    }),
  provider: mysqlEnum("provider", [
    "DEEPSEEK",
    "OPENAI_COMPATIBLE"
  ]).notNull(),
  baseUrl: varchar("base_url", { length: 512 }).notNull(),
  model: varchar("model", { length: 128 }).notNull(),
  encryptedApiKey: longtext("encrypted_api_key").notNull(),
  dailySummaryPrompt: text("daily_summary_prompt"),
  weeklySummaryPrompt: text("weekly_summary_prompt"),
  monthlySummaryPrompt: text("monthly_summary_prompt"),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const devices = mysqlTable(
  "devices",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    deviceRegistrationId: varchar("device_registration_id", {
      length: 128
    }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    platform: mysqlEnum("platform", ["MACOS", "WINDOWS", "LINUX"]).notNull(),
    status: mysqlEnum("status", ["ACTIVE", "OFFLINE", "REVOKED"])
      .notNull()
      .default("ACTIVE"),
    lastSeenAt: datetime("last_seen_at", { fsp: 6, mode: "date" }),
    lastSyncedAt: datetime("last_synced_at", { fsp: 6, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("uq_devices_account_registration").on(
      table.accountId,
      table.deviceRegistrationId
    ),
    index("ix_devices_account_status").on(table.accountId, table.status)
  ]
);

export const deviceTokens = mysqlTable(
  "device_tokens",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    tokenHmac: char("token_hmac", { length: 64 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    expiresAt: datetime("expires_at", { fsp: 6, mode: "date" }),
    revokedAt: datetime("revoked_at", { fsp: 6, mode: "date" }),
    lastUsedAt: datetime("last_used_at", { fsp: 6, mode: "date" }),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("uq_device_tokens_hmac").on(table.tokenHmac),
    index("ix_device_tokens_account_device").on(table.accountId, table.deviceId)
  ]
);

export const syncBatches = mysqlTable(
  "sync_batches",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    batchId: varchar("batch_id", { length: 128 }).notNull(),
    protocolVersion: int("protocol_version", { unsigned: true }).notNull(),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    sourceInstanceId: varchar("source_instance_id", { length: 128 }).notNull(),
    parserVersion: varchar("parser_version", { length: 64 }).notNull(),
    payloadHash: char("payload_hash", { length: 64 }).notNull(),
    status: mysqlEnum("status", [
      "RECEIVED",
      "COMMITTED",
      "COMMITTED_WITH_WARNINGS",
      "FAILED"
    ])
      .notNull()
      .default("RECEIVED"),
    receivedCount: int("received_count", { unsigned: true }).notNull().default(0),
    insertedCount: int("inserted_count", { unsigned: true }).notNull().default(0),
    duplicateCount: int("duplicate_count", { unsigned: true }).notNull().default(0),
    changedCount: int("changed_count", { unsigned: true }).notNull().default(0),
    result: json("result").$type<Record<string, unknown> | null>(),
    receivedAt: datetime("received_at", { fsp: 6, mode: "date" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(6)`),
    committedAt: datetime("committed_at", { fsp: 6, mode: "date" }),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("uq_sync_batches_account_device_batch").on(
      table.accountId,
      table.deviceId,
      table.batchId
    ),
    index("ix_sync_batches_device_received").on(
      table.deviceId,
      table.receivedAt
    )
  ]
);

export const projects = mysqlTable(
  "projects",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    name: varchar("name", { length: 255 }).notNull(),
    canonicalKey: varchar("canonical_key", { length: 512 }).notNull(),
    normalizedGitRemote: varchar("normalized_git_remote", {
      length: 512
    }),
    classificationSource: mysqlEnum("classification_source", [
      "MANUAL",
      "MAPPING_RULE",
      "GIT_REMOTE",
      "GIT_ROOT",
      "WORKING_DIRECTORY",
      "SOURCE_HINT",
      "UNCLASSIFIED"
    ])
      .notNull()
      .default("UNCLASSIFIED"),
    confidenceBasisPoints: int("confidence_basis_points", { unsigned: true })
      .notNull()
      .default(0),
    isManualOverride: boolean("is_manual_override").notNull().default(false),
    archivedAt: datetime("archived_at", { fsp: 6, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("uq_projects_account_canonical_key").on(
      table.accountId,
      table.canonicalKey
    ),
    uniqueIndex("uq_projects_account_git_remote").on(
      table.accountId,
      table.normalizedGitRemote
    ),
    index("ix_projects_account_name").on(table.accountId, table.name),
    check(
      "chk_projects_confidence",
      sql`${table.confidenceBasisPoints} <= 10000`
    )
  ]
);

export const sessions = mysqlTable(
  "sessions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    projectId: varchar("project_id", { length: 64 }).references(
      () => projects.id,
      { onDelete: "set null", onUpdate: "cascade" }
    ),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    sourceInstanceId: varchar("source_instance_id", { length: 128 }).notNull(),
    sourceSessionId: text("source_session_id").notNull(),
    sourceSessionKey: char("source_session_key", { length: 64 }).notNull(),
    runId: char("run_id", { length: 64 }),
    parserVersion: varchar("parser_version", { length: 64 }).notNull(),
    startedAt: datetime("started_at", { fsp: 6, mode: "date" }),
    endedAt: datetime("ended_at", { fsp: 6, mode: "date" }),
    title: text("title"),
    cwd: text("cwd"),
    parentRunId: char("parent_run_id", { length: 64 }),
    rawCaptureStatus: varchar("raw_capture_status", { length: 32 })
      .notNull()
      .default("CAPTURED"),
    normalizedCoverage: varchar("normalized_coverage", { length: 32 })
      .notNull()
      .default("FULL"),
    attachmentStatus: varchar("attachment_status", { length: 32 })
      .notNull()
      .default("NOT_APPLICABLE"),
    missingReason: text("missing_reason"),
    agentMetadata: json("agent_metadata")
      .$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("uq_sessions_source_identity_v2").on(
      table.accountId,
      table.sourceType,
      table.sourceInstanceId,
      table.sourceSessionKey
    ),
    uniqueIndex("uq_sessions_account_run_id").on(table.accountId, table.runId),
    index("ix_sessions_account_project_started").on(
      table.accountId,
      table.projectId,
      table.startedAt
    ),
    index("ix_sessions_account_source_started").on(
      table.accountId,
      table.sourceType,
      table.startedAt
    ),
    index("ix_sessions_device").on(table.deviceId)
  ]
);

export const collectedEvents = mysqlTable(
  "collected_events",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    syncBatchId: varchar("sync_batch_id", { length: 64 })
      .notNull()
      .references(() => syncBatches.id, {
        onDelete: "restrict",
        onUpdate: "cascade"
      }),
    sessionId: varchar("session_id", { length: 64 })
      .notNull()
      .references(() => sessions.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    projectId: varchar("project_id", { length: 64 }).references(
      () => projects.id,
      { onDelete: "set null", onUpdate: "cascade" }
    ),
    eventId: char("event_id", { length: 64 }).notNull(),
    kind: varchar("kind", { length: 64 }).notNull(),
    sourceEventId: varchar("source_event_id", { length: 1_024 }),
    sourceMessageId: varchar("source_message_id", { length: 1_024 }),
    sequence: bigint("sequence", { mode: "number", unsigned: true }),
    turnIndex: int("turn_index", { unsigned: true }),
    stepIndex: int("step_index", { unsigned: true }),
    messageIndex: bigint("message_index", { mode: "number", unsigned: true }),
    replyToEventId: char("reply_to_event_id", { length: 64 }),
    mirrorOfEventId: char("mirror_of_event_id", { length: 64 }),
    occurredAt: datetime("occurred_at", { fsp: 6, mode: "date" }).notNull(),
    sourceTimeZone: varchar("source_time_zone", { length: 64 }).notNull(),
    contentHash: char("content_hash", { length: 64 }),
    rawPayloadSha256: char("raw_payload_sha256", { length: 64 }),
    rawCaptureStatus: varchar("raw_capture_status", { length: 32 })
      .notNull()
      .default("CAPTURED"),
    normalizedCoverage: varchar("normalized_coverage", { length: 32 })
      .notNull()
      .default("FULL"),
    attachmentStatus: varchar("attachment_status", { length: 32 })
      .notNull()
      .default("NOT_APPLICABLE"),
    missingReason: text("missing_reason"),
    currentVersion: int("current_version", { unsigned: true }).notNull().default(1),
    redactionVersion: varchar("redaction_version", { length: 32 }),
    metadata: json("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("uq_collected_events_account_event").on(
      table.accountId,
      table.eventId
    ),
    index("ix_collected_events_session_order").on(
      table.sessionId,
      table.messageIndex
    ),
    index("ix_collected_events_account_occurred").on(
      table.accountId,
      table.occurredAt
    ),
    index("ix_collected_events_device").on(table.deviceId),
    index("ix_collected_events_sync_batch").on(table.syncBatchId),
    index("ix_collected_events_project").on(table.projectId),
    index("ix_collected_events_session_sequence").on(
      table.sessionId,
      table.sequence
    ),
    index("ix_collected_events_account_kind_occurred").on(
      table.accountId,
      table.kind,
      table.occurredAt
    )
  ]
);

export const eventVersions = mysqlTable(
  "event_versions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    collectedEventId: varchar("collected_event_id", { length: 64 })
      .notNull()
      .references(() => collectedEvents.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    version: int("version", { unsigned: true }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    sanitizedContent: longtext("sanitized_content").notNull(),
    parserVersion: varchar("parser_version", { length: 64 }).notNull(),
    redactionVersion: varchar("redaction_version", { length: 32 }).notNull(),
    metadata: json("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("uq_event_versions_event_version").on(
      table.collectedEventId,
      table.version
    ),
    uniqueIndex("uq_event_versions_event_hash").on(
      table.collectedEventId,
      table.contentHash
    ),
    index("ix_event_versions_account").on(table.accountId)
  ]
);

export const agentTextSegments = mysqlTable(
  "agent_text_segments",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    collectedEventId: varchar("collected_event_id", { length: 64 })
      .notNull()
      .references(() => collectedEvents.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    segmentId: char("segment_id", { length: 64 }).notNull(),
    ordinal: bigint("ordinal", { mode: "number", unsigned: true }).notNull(),
    format: varchar("format", { length: 32 }).notNull(),
    purpose: varchar("purpose", { length: 64 }).notNull(),
    contentSha256: char("content_sha256", { length: 64 }).notNull(),
    byteLength: bigint("byte_length", {
      mode: "number",
      unsigned: true
    }).notNull(),
    groupSha256: char("group_sha256", { length: 64 }).notNull(),
    groupByteLength: bigint("group_byte_length", {
      mode: "number",
      unsigned: true
    }).notNull(),
    groupSegmentCount: bigint("group_segment_count", {
      mode: "number",
      unsigned: true
    }).notNull(),
    content: longtext("content").notNull(),
    isSearchable: boolean("is_searchable").notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("uq_agent_text_segments_account_segment").on(
      table.accountId,
      table.segmentId
    ),
    index("ix_agent_text_segments_account_event").on(
      table.accountId,
      table.collectedEventId
    ),
    uniqueIndex("uq_agent_text_segments_event_group_ordinal").on(
      table.collectedEventId,
      table.purpose,
      table.groupSha256,
      table.ordinal
    )
  ]
);

export const blobObjects = mysqlTable(
  "blob_objects",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    sha256: char("sha256", { length: 64 }).notNull(),
    byteLength: bigint("byte_length", {
      mode: "number",
      unsigned: true
    }).notNull(),
    chunkSize: int("chunk_size", { unsigned: true }).notNull(),
    chunkCount: bigint("chunk_count", {
      mode: "number",
      unsigned: true
    }).notNull(),
    mediaType: varchar("media_type", { length: 255 }).notNull(),
    filename: text("filename"),
    storagePath: text("storage_path").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("PENDING"),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: datetime("completed_at", { fsp: 6, mode: "date" })
  },
  (table) => [
    uniqueIndex("uq_blob_objects_account_sha256").on(
      table.accountId,
      table.sha256
    ),
    index("ix_blob_objects_account_status").on(table.accountId, table.status)
  ]
);

export const blobChunks = mysqlTable(
  "blob_chunks",
  {
    blobObjectId: varchar("blob_object_id", { length: 64 })
      .notNull()
      .references(() => blobObjects.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    chunkIndex: bigint("chunk_index", {
      mode: "number",
      unsigned: true
    }).notNull(),
    byteLength: int("byte_length", { unsigned: true }).notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    storagePath: text("storage_path").notNull(),
    receivedAt: datetime("received_at", { fsp: 6, mode: "date" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(6)`)
  },
  (table) => [
    primaryKey({
      name: "pk_blob_chunks",
      columns: [table.blobObjectId, table.chunkIndex]
    })
  ]
);

export const eventBlobReferences = mysqlTable(
  "event_blob_references",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    sessionId: varchar("session_id", { length: 64 })
      .notNull()
      .references(() => sessions.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    collectedEventId: varchar("collected_event_id", { length: 64 }).references(
      () => collectedEvents.id,
      { onDelete: "cascade", onUpdate: "cascade" }
    ),
    blobObjectId: varchar("blob_object_id", { length: 64 }).references(
      () => blobObjects.id,
      { onDelete: "set null", onUpdate: "cascade" }
    ),
    referenceId: char("reference_id", { length: 64 }).notNull(),
    blobSha256: char("blob_sha256", { length: 64 }),
    purpose: varchar("purpose", { length: 64 }).notNull(),
    requestedPath: text("requested_path"),
    realPath: text("real_path"),
    filename: text("filename"),
    mediaType: varchar("media_type", { length: 255 }),
    byteLength: bigint("byte_length", { mode: "number", unsigned: true }),
    capturedAt: datetime("captured_at", { fsp: 6, mode: "date" }),
    status: varchar("status", { length: 32 }).notNull(),
    failureReason: text("failure_reason"),
    metadata: json("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("uq_event_blob_references_account_reference").on(
      table.accountId,
      table.referenceId
    ),
    index("ix_event_blob_references_event").on(table.collectedEventId),
    index("ix_event_blob_references_session_status").on(
      table.sessionId,
      table.status
    ),
    index("ix_event_blob_references_blob_sha").on(
      table.accountId,
      table.blobSha256
    )
  ]
);

export const agentCaptureCompleteness = mysqlTable(
  "agent_capture_completeness",
  {
    sessionId: varchar("session_id", { length: 64 })
      .primaryKey()
      .references(() => sessions.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    rawCaptureStatus: varchar("raw_capture_status", { length: 32 }).notNull(),
    normalizedCoverage: varchar("normalized_coverage", {
      length: 32
    }).notNull(),
    attachmentStatus: varchar("attachment_status", { length: 32 }).notNull(),
    eventCount: bigint("event_count", { mode: "number", unsigned: true })
      .notNull()
      .default(0),
    textSegmentCount: bigint("text_segment_count", {
      mode: "number",
      unsigned: true
    })
      .notNull()
      .default(0),
    pendingBlobCount: bigint("pending_blob_count", {
      mode: "number",
      unsigned: true
    })
      .notNull()
      .default(0),
    missingReasons: json("missing_reasons")
      .$type<string[]>()
      .notNull(),
    assessedAt: datetime("assessed_at", { fsp: 6, mode: "date" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: updatedAt()
  },
  (table) => [
    index("ix_agent_capture_completeness_account_status").on(
      table.accountId,
      table.rawCaptureStatus,
      table.attachmentStatus
    )
  ]
);

export const collectorBackfillCursors = mysqlTable(
  "collector_backfill_cursors",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    sourceInstanceId: varchar("source_instance_id", { length: 128 }).notNull(),
    cursor: json("cursor").$type<Record<string, unknown>>().notNull(),
    status: varchar("status", { length: 32 }).notNull().default("ACTIVE"),
    newestSeenAt: datetime("newest_seen_at", { fsp: 6, mode: "date" }),
    oldestSeenAt: datetime("oldest_seen_at", { fsp: 6, mode: "date" }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("uq_collector_backfill_source").on(
      table.accountId,
      table.deviceId,
      table.sourceType,
      table.sourceInstanceId
    )
  ]
);

export const promptEntries = mysqlTable(
  "prompt_entries",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    collectedEventId: varchar("collected_event_id", { length: 64 })
      .notNull()
      .references(() => collectedEvents.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    sessionId: varchar("session_id", { length: 64 })
      .notNull()
      .references(() => sessions.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    projectId: varchar("project_id", { length: 64 }).references(
      () => projects.id,
      { onDelete: "set null", onUpdate: "cascade" }
    ),
    occurredAt: datetime("occurred_at", { fsp: 6, mode: "date" }).notNull(),
    sourceTimeZone: varchar("source_time_zone", { length: 64 }).notNull(),
    sanitizedContent: longtext("sanitized_content").notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    model: varchar("model", { length: 128 }),
    isFavorite: boolean("is_favorite").notNull().default(false),
    isManualProjectOverride: boolean("is_manual_project_override")
      .notNull()
      .default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    // FULLTEXT ... WITH PARSER ngram is kept in the handwritten MySQL migration;
    // drizzle-orm 0.44 does not expose a FULLTEXT index builder for mysql-core.
    uniqueIndex("uq_prompt_entries_account_event").on(
      table.accountId,
      table.collectedEventId
    ),
    index("ix_prompt_entries_account_occurred").on(
      table.accountId,
      table.occurredAt
    ),
    index("ix_prompt_entries_project_occurred").on(
      table.projectId,
      table.occurredAt
    ),
    index("ix_prompt_entries_device_occurred").on(
      table.deviceId,
      table.occurredAt
    ),
    index("ix_prompt_entries_session").on(table.sessionId)
  ]
);

export const visibleResults = mysqlTable(
  "visible_results",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    collectedEventId: varchar("collected_event_id", { length: 64 })
      .notNull()
      .references(() => collectedEvents.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    promptEntryId: varchar("prompt_entry_id", { length: 64 }).references(
      () => promptEntries.id,
      { onDelete: "set null", onUpdate: "cascade" }
    ),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    sessionId: varchar("session_id", { length: 64 })
      .notNull()
      .references(() => sessions.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    projectId: varchar("project_id", { length: 64 }).references(
      () => projects.id,
      { onDelete: "set null", onUpdate: "cascade" }
    ),
    occurredAt: datetime("occurred_at", { fsp: 6, mode: "date" }).notNull(),
    sanitizedContent: longtext("sanitized_content").notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    model: varchar("model", { length: 128 }),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("uq_visible_results_account_event").on(
      table.accountId,
      table.collectedEventId
    ),
    index("ix_visible_results_prompt").on(table.promptEntryId),
    index("ix_visible_results_account_occurred").on(
      table.accountId,
      table.occurredAt
    ),
    index("ix_visible_results_device").on(table.deviceId),
    index("ix_visible_results_session").on(table.sessionId),
    index("ix_visible_results_project").on(table.projectId)
  ]
);

export const dailySummaries = mysqlTable(
  "daily_summaries",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    workDate: date("work_date", { mode: "string" }).notNull(),
    timeZone: varchar("time_zone", { length: 64 }).notNull(),
    revision: int("revision", { unsigned: true }).notNull(),
    status: mysqlEnum("status", [
      "WAITING",
      "COMPLETE",
      "PARTIAL",
      "STALE",
      "REGENERATING",
      "FAILED"
    ]).notNull(),
    inputFingerprint: char("input_fingerprint", { length: 64 }).notNull(),
    content: longtext("content").notNull(),
    coverage: json("coverage").$type<Record<string, unknown>>().notNull(),
    modelProvider: varchar("model_provider", { length: 64 }),
    modelName: varchar("model_name", { length: 128 }),
    templateVersion: varchar("template_version", { length: 64 }).notNull(),
    isManuallyEdited: boolean("is_manually_edited").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("uq_daily_summaries_account_date_revision").on(
      table.accountId,
      table.workDate,
      table.revision
    ),
    uniqueIndex("uq_daily_summaries_account_date_fingerprint").on(
      table.accountId,
      table.workDate,
      table.inputFingerprint
    )
  ]
);

export const periodSummaries = mysqlTable(
  "period_summaries",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    periodType: mysqlEnum("period_type", ["WEEK", "MONTH"]).notNull(),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    timeZone: varchar("time_zone", { length: 64 }).notNull(),
    revision: int("revision", { unsigned: true }).notNull(),
    status: mysqlEnum("status", [
      "WAITING",
      "COMPLETE",
      "PARTIAL",
      "STALE",
      "REGENERATING",
      "FAILED"
    ]).notNull(),
    inputFingerprint: char("input_fingerprint", { length: 64 }).notNull(),
    content: longtext("content").notNull(),
    coverage: json("coverage").$type<Record<string, unknown>>().notNull(),
    modelProvider: varchar("model_provider", { length: 64 }),
    modelName: varchar("model_name", { length: 128 }),
    templateVersion: varchar("template_version", { length: 64 }).notNull(),
    isManuallyEdited: boolean("is_manually_edited").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("uq_period_summaries_account_period_revision").on(
      table.accountId,
      table.periodType,
      table.periodStart,
      table.revision
    ),
    uniqueIndex("uq_period_summaries_account_period_fingerprint").on(
      table.accountId,
      table.periodType,
      table.periodStart,
      table.inputFingerprint
    ),
    index("ix_period_summaries_account_end").on(
      table.accountId,
      table.periodEnd
    ),
    check("chk_period_summaries_range", sql`${table.periodEnd} >= ${table.periodStart}`)
  ]
);

export const summaryJobs = mysqlTable(
  "summary_jobs",
  {
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    workDate: date("work_date", { mode: "string" }).notNull(),
    dirtyVersion: bigint("dirty_version", { mode: "bigint", unsigned: true })
      .notNull()
      .default(1n),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    primaryKey({
      name: "pk_summary_jobs",
      columns: [table.accountId, table.workDate]
    }),
    index("ix_summary_jobs_account_updated").on(
      table.accountId,
      table.updatedAt
    )
  ]
);

export const summaryEvidence = mysqlTable(
  "summary_evidence",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    summaryId: varchar("summary_id", { length: 64 })
      .notNull()
      .references(() => dailySummaries.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    collectedEventId: varchar("collected_event_id", { length: 64 })
      .notNull()
      .references(() => collectedEvents.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    claimKey: varchar("claim_key", { length: 128 }).notNull(),
    claimType: mysqlEnum("claim_type", [
      "FACT",
      "INFERENCE",
      "SUGGESTION",
      "INFORMATION_MISSING"
    ]).notNull(),
    excerpt: text("excerpt"),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("uq_summary_evidence_claim_event").on(
      table.summaryId,
      table.claimKey,
      table.collectedEventId
    ),
    index("ix_summary_evidence_account_event").on(
      table.accountId,
      table.collectedEventId
    )
  ]
);

export const periodSummaryEvidence = mysqlTable(
  "period_summary_evidence",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    summaryId: varchar("summary_id", { length: 64 })
      .notNull()
      .references(() => periodSummaries.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    collectedEventId: varchar("collected_event_id", { length: 64 })
      .notNull()
      .references(() => collectedEvents.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    claimKey: varchar("claim_key", { length: 128 }).notNull(),
    claimType: mysqlEnum("claim_type", [
      "FACT",
      "INFERENCE",
      "SUGGESTION",
      "INFORMATION_MISSING"
    ]).notNull(),
    excerpt: text("excerpt"),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("uq_period_summary_evidence_claim_event").on(
      table.summaryId,
      table.claimKey,
      table.collectedEventId
    ),
    index("ix_period_summary_evidence_account_event").on(
      table.accountId,
      table.collectedEventId
    )
  ]
);

export const skillCandidates = mysqlTable(
  "skill_candidates",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 64 })
      .notNull()
      .references(() => accounts.id, {
        onDelete: "cascade",
        onUpdate: "cascade"
      }),
    projectId: varchar("project_id", { length: 64 }).references(
      () => projects.id,
      { onDelete: "set null", onUpdate: "cascade" }
    ),
    name: varchar("name", { length: 160 }).notNull(),
    slug: varchar("slug", { length: 160 }).notNull(),
    description: text("description").notNull(),
    status: mysqlEnum("status", [
      "CANDIDATE",
      "IN_REVIEW",
      "ACCEPTED",
      "IGNORED"
    ])
      .notNull()
      .default("CANDIDATE"),
    evidenceCount: int("evidence_count", { unsigned: true }).notNull().default(0),
    proposal: json("proposal").$type<Record<string, unknown>>().notNull(),
    baselineHash: char("baseline_hash", { length: 64 }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("uq_skill_candidates_account_slug").on(
      table.accountId,
      table.slug
    ),
    index("ix_skill_candidates_account_status").on(
      table.accountId,
      table.status
    ),
    index("ix_skill_candidates_project").on(table.projectId)
  ]
);

export const auditLogs = mysqlTable(
  "audit_logs",
  {
    id: bigint("id", { mode: "bigint", unsigned: true })
      .autoincrement()
      .primaryKey(),
    accountId: varchar("account_id", { length: 64 }).references(
      () => accounts.id,
      { onDelete: "set null", onUpdate: "cascade" }
    ),
    deviceId: varchar("device_id", { length: 64 }).references(
      () => devices.id,
      { onDelete: "set null", onUpdate: "cascade" }
    ),
    action: varchar("action", { length: 128 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }).notNull(),
    resourceId: varchar("resource_id", { length: 128 }),
    requestId: varchar("request_id", { length: 128 }),
    outcome: mysqlEnum("outcome", ["SUCCEEDED", "FAILED", "DENIED"])
      .notNull(),
    metadata: json("metadata").$type<Record<string, unknown>>().notNull(),
    occurredAt: datetime("occurred_at", { fsp: 6, mode: "date" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(6)`)
  },
  (table) => [
    index("ix_audit_logs_account_occurred").on(
      table.accountId,
      table.occurredAt
    ),
    index("ix_audit_logs_request").on(table.requestId),
    index("ix_audit_logs_device").on(table.deviceId)
  ]
);

export const schema = {
  accounts,
  llmSettings,
  devices,
  deviceTokens,
  syncBatches,
  projects,
  sessions,
  collectedEvents,
  eventVersions,
  agentTextSegments,
  blobObjects,
  blobChunks,
  eventBlobReferences,
  agentCaptureCompleteness,
  collectorBackfillCursors,
  promptEntries,
  visibleResults,
  dailySummaries,
  periodSummaries,
  summaryJobs,
  summaryEvidence,
  periodSummaryEvidence,
  skillCandidates,
  auditLogs
};
