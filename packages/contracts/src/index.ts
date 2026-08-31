import { z } from "zod";

export const AgentSourceTypeSchema = z.enum([
  "CODEX",
  "CLAUDE_CODE",
  "ZCODE",
  "DSH"
]);

export const MAX_SYNC_EVENT_CONTENT_BYTES = 1_500_000;

export const MAX_SYNC_BATCH_BODY_BYTES = 2 * 1024 * 1024;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const DateTimeSchema = z.string().datetime({ offset: true });
export const MAX_LEGACY_EVENT_ALIASES = 4;

export const LegacyEventAliasSchema = z
  .object({
    eventId: Sha256Schema,
    sourceSessionId: z.string().min(1).max(255)
  })
  .strict();

export const LegacyEventAliasesSchema = z
  .array(LegacyEventAliasSchema)
  .min(1)
  .max(MAX_LEGACY_EVENT_ALIASES)
  .superRefine((aliases, context) => {
    if (new Set(aliases.map((alias) => alias.eventId)).size !== aliases.length) {
      context.addIssue({
        code: "custom",
        message: "legacy event aliases must have unique event IDs"
      });
    }
  });

const SyncEventMetadataSchema = z
  .record(z.string(), z.unknown())
  .superRefine((metadata, context) => {
    if (metadata.legacyEventId !== undefined) {
      const result = Sha256Schema.safeParse(metadata.legacyEventId);
      if (!result.success) {
        context.addIssue({ code: "custom", message: "invalid legacyEventId" });
      }
    }
    if (metadata.legacyEventAliases !== undefined) {
      const result = LegacyEventAliasesSchema.safeParse(
        metadata.legacyEventAliases
      );
      if (!result.success) {
        context.addIssue({
          code: "custom",
          message: "invalid legacyEventAliases"
        });
      }
    }
  });

export const ProjectHintSchema = z
  .object({
    gitRemoteKey: z.string().min(3).max(512).optional(),
    repoRootName: z.string().min(1).max(255).optional(),
    localPathHmac: Sha256Schema.optional()
  })
  .strict();

export const SyncEventSchema = z
  .object({
    eventId: Sha256Schema,
    kind: z.enum(["USER_PROMPT", "VISIBLE_RESULT"]),
    sourceSessionId: z.string().min(1).max(255),
    sourceMessageId: z.string().min(1).max(255).nullable().optional(),
    messageIndex: z.number().int().min(0).max(1_000_000),
    replyToEventId: Sha256Schema.nullable().optional(),
    occurredAt: DateTimeSchema,
    sourceTimeZone: z.string().min(1).max(64),
    sanitizedContent: z.string().min(1).max(MAX_SYNC_EVENT_CONTENT_BYTES),
    contentHash: Sha256Schema,
    redactionVersion: z.string().min(1).max(32),
    projectHint: ProjectHintSchema.optional(),
    metadata: SyncEventMetadataSchema.default({})
  })
  .strict()
  .superRefine((event, context) => {
    const aliases = event.metadata.legacyEventAliases;
    if (
      Array.isArray(aliases) &&
      aliases.some((alias) =>
        typeof alias === "object" &&
        alias !== null &&
        "eventId" in alias &&
        alias.eventId === event.eventId
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "canonical event ID cannot be a legacy alias"
      });
    }
    if (event.metadata.legacyEventId === event.eventId) {
      context.addIssue({
        code: "custom",
        message: "canonical event ID cannot be a legacy alias"
      });
    }
  });

export const SyncBatchRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    batchId: z.string().min(1).max(128),
    createdAt: DateTimeSchema,
    source: z
      .object({
        type: AgentSourceTypeSchema,
        instanceId: z.string().min(1).max(128),
        parserVersion: z.string().min(1).max(64)
      })
      .strict(),
    events: z.array(SyncEventSchema).min(1).max(200)
  })
  .strict();

export const SyncBatchResultSchema = z
  .object({
    batchId: z.string(),
    status: z.enum(["COMMITTED", "COMMITTED_WITH_WARNINGS"]),
    receivedCount: z.number().int().nonnegative(),
    insertedCount: z.number().int().nonnegative(),
    duplicateCount: z.number().int().nonnegative(),
    changedCount: z.number().int().nonnegative(),
    committedAt: DateTimeSchema
  })
  .strict();

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        requestId: z.string()
      })
      .strict()
  })
  .strict();

export type SyncBatchRequest = z.infer<typeof SyncBatchRequestSchema>;
export type SyncEvent = z.infer<typeof SyncEventSchema>;
export type SyncBatchResult = z.infer<typeof SyncBatchResultSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const MAX_BLOB_CHUNK_BYTES = 1024 * 1024;
export const MAX_AGENT_SYNC_RECORDS = 1_000;

export const AgentEventKindSchema = z.enum([
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
]);

export const RawCaptureStatusSchema = z.enum([
  "CAPTURED",
  "PARTIAL",
  "NOT_EXPOSED",
  "UNREADABLE",
  "CORRUPT"
]);

export const NormalizedCoverageSchema = z.enum([
  "FULL",
  "PARTIAL",
  "NONE",
  "UNKNOWN"
]);

export const AttachmentStatusSchema = z.enum([
  "NOT_APPLICABLE",
  "PENDING",
  "CAPTURED",
  "MISSING",
  "READ_ERROR",
  "NOT_REGULAR",
  "STORAGE_FULL"
]);

const AgentRecordMetadataSchema = z.record(z.string(), z.unknown());

export const AgentRunRecordSchema = z
  .object({
    recordType: z.literal("RUN"),
    runId: Sha256Schema,
    sourceSessionId: z.string().min(1).max(1_024),
    startedAt: DateTimeSchema,
    endedAt: DateTimeSchema.nullable().optional(),
    sourceTimeZone: z.string().min(1).max(64),
    title: z.string().max(4_096).nullable().optional(),
    cwd: z.string().max(32_768).nullable().optional(),
    parentRunId: Sha256Schema.nullable().optional(),
    projectHint: ProjectHintSchema.optional(),
    rawCaptureStatus: RawCaptureStatusSchema,
    normalizedCoverage: NormalizedCoverageSchema,
    attachmentStatus: AttachmentStatusSchema,
    missingReason: z.string().min(1).max(4_096).optional(),
    metadata: AgentRecordMetadataSchema.default({})
  })
  .strict();

export const AgentEventRecordSchema = z
  .object({
    recordType: z.literal("EVENT"),
    eventId: Sha256Schema,
    runId: Sha256Schema,
    sourceEventId: z.string().min(1).max(1_024),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    turnIndex: z.number().int().nonnegative().nullable().optional(),
    stepIndex: z.number().int().nonnegative().nullable().optional(),
    kind: AgentEventKindSchema,
    occurredAt: DateTimeSchema,
    sourceTimeZone: z.string().min(1).max(64),
    replyToEventId: Sha256Schema.nullable().optional(),
    mirrorOfEventId: Sha256Schema.nullable().optional(),
    contentSha256: Sha256Schema.nullable().optional(),
    rawPayloadSha256: Sha256Schema.nullable().optional(),
    rawCaptureStatus: RawCaptureStatusSchema,
    normalizedCoverage: NormalizedCoverageSchema,
    attachmentStatus: AttachmentStatusSchema,
    missingReason: z.string().min(1).max(4_096).optional(),
    metadata: AgentRecordMetadataSchema.default({})
  })
  .strict()
  .superRefine((event, context) => {
    if (event.rawCaptureStatus !== "CAPTURED" && !event.missingReason) {
      context.addIssue({
        code: "custom",
        path: ["missingReason"],
        message: "missingReason is required when raw capture is incomplete"
      });
    }
  });

export const AgentTextSegmentRecordSchema = z
  .object({
    recordType: z.literal("TEXT_SEGMENT"),
    segmentId: Sha256Schema,
    eventId: Sha256Schema,
    ordinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    format: z.enum(["TEXT", "MARKDOWN", "JSON"]),
    purpose: z.enum([
      "RENDERED_CONTENT",
      "RAW_PAYLOAD",
      "TOOL_ARGUMENTS",
      "TOOL_RESULT",
      "SEARCH_TEXT"
    ]),
    text: z.string(),
    contentSha256: Sha256Schema,
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    groupSha256: Sha256Schema.optional(),
    groupByteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    groupSegmentCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    isSearchable: z.boolean()
  })
  .strict()
  .superRefine((segment, context) => {
    const hasGroupField = segment.groupSha256 !== undefined ||
      segment.groupByteLength !== undefined ||
      segment.groupSegmentCount !== undefined;
    const hasCompleteGroup = segment.groupSha256 !== undefined &&
      segment.groupByteLength !== undefined &&
      segment.groupSegmentCount !== undefined;
    if (hasGroupField && !hasCompleteGroup) {
      context.addIssue({
        code: "custom",
        path: ["groupSha256"],
        message: "all text group fields must be supplied together"
      });
    }
    if (
      segment.groupSegmentCount !== undefined &&
      segment.ordinal >= segment.groupSegmentCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["ordinal"],
        message: "ordinal must be smaller than groupSegmentCount"
      });
    }
    if (
      segment.groupByteLength !== undefined &&
      segment.byteLength > segment.groupByteLength
    ) {
      context.addIssue({
        code: "custom",
        path: ["byteLength"],
        message: "segment byteLength exceeds its text group"
      });
    }
  });

export const AgentBlobReferenceRecordSchema = z
  .object({
    recordType: z.literal("BLOB_REFERENCE"),
    referenceId: Sha256Schema,
    eventId: Sha256Schema.nullable().optional(),
    runId: Sha256Schema,
    blobSha256: Sha256Schema.nullable(),
    purpose: z.enum([
      "RAW_EVENT",
      "SOURCE_TRANSCRIPT",
      "ATTACHMENT",
      "TEXT_OVERFLOW"
    ]),
    requestedPath: z.string().max(32_768).nullable().optional(),
    realPath: z.string().max(32_768).nullable().optional(),
    filename: z.string().max(4_096).nullable().optional(),
    mediaType: z.string().min(1).max(255).nullable().optional(),
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    capturedAt: DateTimeSchema.nullable().optional(),
    status: AttachmentStatusSchema,
    failureReason: z.string().min(1).max(4_096).nullable().optional(),
    metadata: AgentRecordMetadataSchema.default({})
  })
  .strict()
  .superRefine((reference, context) => {
    if (
      ["MISSING", "READ_ERROR", "NOT_REGULAR", "STORAGE_FULL"].includes(
        reference.status
      ) &&
      !reference.failureReason
    ) {
      context.addIssue({
        code: "custom",
        path: ["failureReason"],
        message: "failureReason is required for failed attachment capture"
      });
    }
    if (reference.status === "CAPTURED" && !reference.blobSha256) {
      context.addIssue({
        code: "custom",
        path: ["blobSha256"],
        message: "blobSha256 is required for a captured reference"
      });
    }
  });

export const AgentSyncRecordSchema = z.discriminatedUnion("recordType", [
  AgentRunRecordSchema,
  AgentEventRecordSchema,
  AgentTextSegmentRecordSchema,
  AgentBlobReferenceRecordSchema
]);

export const AgentSyncBatchRequestSchema = z
  .object({
    protocolVersion: z.literal(2),
    batchId: z.string().min(1).max(128),
    createdAt: DateTimeSchema,
    source: z
      .object({
        type: AgentSourceTypeSchema,
        instanceId: z.string().min(1).max(128),
        parserVersion: z.string().min(1).max(64)
      })
      .strict(),
    records: z.array(AgentSyncRecordSchema).min(1).max(MAX_AGENT_SYNC_RECORDS)
  })
  .strict();

export const SyncRequestSchema = z.discriminatedUnion("protocolVersion", [
  SyncBatchRequestSchema,
  AgentSyncBatchRequestSchema
]);

export const BlobManifestRequestSchema = z
  .object({
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    chunkSize: z.literal(MAX_BLOB_CHUNK_BYTES),
    mediaType: z.string().min(1).max(255),
    filename: z.string().min(1).max(4_096).optional()
  })
  .strict();

export const BlobCompleteRequestSchema = z
  .object({
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    chunkCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: Sha256Schema
  })
  .strict()
  .superRefine((request, context) => {
    const expected = Math.ceil(request.byteLength / MAX_BLOB_CHUNK_BYTES);
    if (request.chunkCount !== expected) {
      context.addIssue({
        code: "custom",
        path: ["chunkCount"],
        message: "chunkCount does not match byteLength"
      });
    }
  });

export const BlobInitializeResponseSchema = z
  .object({
    data: z
      .object({
        sha256: Sha256Schema,
        status: z.enum([
          "PENDING",
          "UPLOADING",
          "COMPLETE",
          "FAILED",
          "STORAGE_FULL"
        ]),
        chunkSize: z.literal(MAX_BLOB_CHUNK_BYTES),
        chunkCount: z.number().int().nonnegative(),
        receivedChunks: z.array(z.number().int().nonnegative())
      })
      .strict()
  })
  .strict();

export const BlobChunkResponseSchema = z
  .object({
    data: z
      .object({
        sha256: Sha256Schema,
        index: z.number().int().nonnegative(),
        chunkSha256: Sha256Schema,
        wasDuplicate: z.boolean()
      })
      .strict()
  })
  .strict();

export const BlobCompleteResponseSchema = z
  .object({
    data: z
      .object({
        sha256: Sha256Schema,
        status: z.literal("COMPLETE"),
        byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
      })
      .strict()
  })
  .strict();

export type AgentSourceType = z.infer<typeof AgentSourceTypeSchema>;
export type AgentEventKind = z.infer<typeof AgentEventKindSchema>;
export type RawCaptureStatus = z.infer<typeof RawCaptureStatusSchema>;
export type NormalizedCoverage = z.infer<typeof NormalizedCoverageSchema>;
export type AttachmentStatus = z.infer<typeof AttachmentStatusSchema>;
export type AgentRunRecord = z.infer<typeof AgentRunRecordSchema>;
export type AgentEventRecord = z.infer<typeof AgentEventRecordSchema>;
export type AgentTextSegmentRecord = z.infer<typeof AgentTextSegmentRecordSchema>;
export type AgentBlobReferenceRecord = z.infer<
  typeof AgentBlobReferenceRecordSchema
>;
export type AgentSyncRecord = z.infer<typeof AgentSyncRecordSchema>;
export type AgentSyncBatchRequest = z.infer<
  typeof AgentSyncBatchRequestSchema
>;
export type SyncRequest = z.infer<typeof SyncRequestSchema>;
export type BlobManifestRequest = z.infer<typeof BlobManifestRequestSchema>;
export type BlobCompleteRequest = z.infer<typeof BlobCompleteRequestSchema>;
export type BlobInitializeResponse = z.infer<
  typeof BlobInitializeResponseSchema
>;
export type BlobChunkResponse = z.infer<typeof BlobChunkResponseSchema>;
export type BlobCompleteResponse = z.infer<typeof BlobCompleteResponseSchema>;

export const AgentRunViewSchema = z
  .object({
    id: z.string().min(1),
    runId: Sha256Schema.nullable(),
    sourceType: AgentSourceTypeSchema,
    sourceSessionId: z.string(),
    title: z.string().nullable(),
    cwd: z.string().nullable(),
    projectId: z.string().nullable(),
    projectName: z.string(),
    deviceId: z.string(),
    deviceName: z.string(),
    startedAt: DateTimeSchema,
    endedAt: DateTimeSchema.nullable(),
    eventCount: z.number().int().nonnegative(),
    turnCount: z.number().int().nonnegative(),
    matchedEventCount: z.number().int().nonnegative(),
    matchSnippet: z.string().nullable(),
    rawCaptureStatus: RawCaptureStatusSchema,
    normalizedCoverage: NormalizedCoverageSchema,
    attachmentStatus: AttachmentStatusSchema
  })
  .strict();

export const AgentRunsResponseSchema = z
  .object({
    data: z.array(AgentRunViewSchema),
    pagination: z
      .object({
        page: z.number().int().positive(),
        pageSize: z.number().int().positive(),
        totalItems: z.number().int().nonnegative(),
        totalPages: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();

export const AgentAttachmentViewSchema = z
  .object({
    id: z.string(),
    referenceId: Sha256Schema,
    purpose: z.enum([
      "RAW_EVENT",
      "SOURCE_TRANSCRIPT",
      "ATTACHMENT",
      "TEXT_OVERFLOW"
    ]),
    filename: z.string().nullable(),
    requestedPath: z.string().nullable(),
    realPath: z.string().nullable(),
    byteLength: z.number().int().nonnegative().nullable(),
    sha256: Sha256Schema.nullable(),
    mediaType: z.string().nullable(),
    status: AttachmentStatusSchema,
    failureReason: z.string().nullable(),
    downloadUrl: z.string().nullable()
  })
  .strict();

export const AgentRunDetailResponseSchema = z
  .object({
    data: z
      .object({
        run: AgentRunViewSchema,
        metadata: z.record(z.string(), z.unknown()),
        completeness: z
          .object({
            missingReasons: z.array(z.string()),
            textSegmentCount: z.number().int().nonnegative(),
            pendingBlobCount: z.number().int().nonnegative()
          })
          .strict(),
        attachments: z.array(AgentAttachmentViewSchema)
      })
      .strict()
  })
  .strict();

export const AgentEventViewSchema = z
  .object({
    id: z.string(),
    eventId: Sha256Schema,
    sourceEventId: z.string().nullable(),
    sequence: z.number().int().nonnegative(),
    turnIndex: z.number().int().nonnegative().nullable(),
    stepIndex: z.number().int().nonnegative().nullable(),
    kind: AgentEventKindSchema,
    occurredAt: DateTimeSchema,
    replyToEventId: Sha256Schema.nullable(),
    mirrorOfEventId: Sha256Schema.nullable(),
    contentPreview: z.string().nullable(),
    contentPurposes: z.array(z.enum([
      "RENDERED_CONTENT",
      "RAW_PAYLOAD",
      "TOOL_ARGUMENTS",
      "TOOL_RESULT",
      "SEARCH_TEXT"
    ])),
    contentUrl: z.string().nullable(),
    rawPayloadUrl: z.string().nullable(),
    rawCaptureStatus: RawCaptureStatusSchema,
    normalizedCoverage: NormalizedCoverageSchema,
    attachmentStatus: AttachmentStatusSchema,
    missingReason: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    attachments: z.array(AgentAttachmentViewSchema)
  })
  .strict();

export const AgentRunEventsResponseSchema = z
  .object({
    data: z.array(AgentEventViewSchema),
    pagination: z
      .object({
        nextCursor: z.string().nullable(),
        hasMore: z.boolean()
      })
      .strict()
  })
  .strict();

export type AgentRunView = z.infer<typeof AgentRunViewSchema>;
export type AgentRunsResponse = z.infer<typeof AgentRunsResponseSchema>;
export type AgentRunDetailResponse = z.infer<
  typeof AgentRunDetailResponseSchema
>;
export type AgentAttachmentView = z.infer<typeof AgentAttachmentViewSchema>;
export type AgentEventView = z.infer<typeof AgentEventViewSchema>;
export type AgentRunEventsResponse = z.infer<
  typeof AgentRunEventsResponseSchema
>;

export const LlmProviderSchema = z.enum([
  "DEEPSEEK",
  "OPENAI_COMPATIBLE"
]);

export const SummaryPromptInstructionsSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 4_096,
    { message: "Summary prompt must not exceed 4096 UTF-8 bytes" }
  )
  .refine(
    (value) => Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 9 ||
        codePoint === 10 ||
        codePoint === 13 ||
        (codePoint >= 32 && codePoint !== 127)
      );
    }),
    { message: "Summary prompt must not contain control characters" }
  );

export const SummaryPromptOverridesSchema = z
  .object({
    daily: SummaryPromptInstructionsSchema.nullable(),
    weekly: SummaryPromptInstructionsSchema.nullable(),
    monthly: SummaryPromptInstructionsSchema.nullable()
  })
  .strict();

export const SummaryPromptViewSchema = z
  .object({
    instructions: z.string(),
    defaultInstructions: z.string(),
    effectivePrompt: z.string(),
    isCustomized: z.boolean()
  })
  .strict();

export const SummaryPromptsViewSchema = z
  .object({
    daily: SummaryPromptViewSchema,
    weekly: SummaryPromptViewSchema,
    monthly: SummaryPromptViewSchema
  })
  .strict();

export const LlmSettingsUpdateSchema = z
  .object({
    provider: LlmProviderSchema,
    baseUrl: z.string().trim().min(1).max(512),
    model: z.string().trim().min(1).max(128),
    apiKey: z
      .string()
      .min(8)
      .max(1024)
      .regex(/^[\x21-\x7E]+$/)
      .optional(),
    summaryPrompts: SummaryPromptOverridesSchema.optional()
  })
  .strict();

export const LlmSettingsViewSchema = z
  .object({
    provider: LlmProviderSchema,
    baseUrl: z.string(),
    model: z.string(),
    hasApiKey: z.boolean(),
    updatedAt: z.string().nullable(),
    summaryPrompts: SummaryPromptsViewSchema
  })
  .strict();

export const LlmSettingsResponseSchema = z
  .object({ data: LlmSettingsViewSchema })
  .strict();

export const LlmConnectionTestResponseSchema = z
  .object({
    data: z
      .object({
        ok: z.literal(true),
        provider: LlmProviderSchema,
        model: z.string(),
        latencyMs: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();

export type LlmProvider = z.infer<typeof LlmProviderSchema>;
export type SummaryPromptOverrides = z.infer<
  typeof SummaryPromptOverridesSchema
>;
export type SummaryPromptsView = z.infer<typeof SummaryPromptsViewSchema>;
export type LlmSettingsUpdate = z.infer<typeof LlmSettingsUpdateSchema>;
export type LlmSettingsView = z.infer<typeof LlmSettingsViewSchema>;
export type LlmSettingsResponse = z.infer<typeof LlmSettingsResponseSchema>;
export type LlmConnectionTestResponse = z.infer<
  typeof LlmConnectionTestResponseSchema
>;

export const DevicePlatformSchema = z.enum(["MACOS", "WINDOWS"]);

export const DeviceCreateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine(
        (value) => Array.from(value).every((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint >= 32 && codePoint !== 127;
        }),
        { message: "Device name must not contain control characters" }
      ),
    platform: DevicePlatformSchema
  })
  .strict();

export const DeviceTokenRotateSchema = z.object({}).strict();

export const DeviceStatusSchema = z.enum([
  "NOT_CONFIGURED",
  "WAITING",
  "SYNCING",
  "SUCCESS",
  "PARTIAL",
  "OFFLINE",
  "FAILED"
]);

export const DeviceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  os: z.enum(["MACOS", "WINDOWS", "OTHER"]),
  status: DeviceStatusSchema,
  lastSeenAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  promptCount: z.number().int().nonnegative()
});

export const DeviceEnrollmentSchema = z
  .object({
    accountId: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/),
    deviceId: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/),
    deviceToken: z.string().regex(/^[a-f0-9]{64}$/),
    syncUrl: z.string().url()
  })
  .strict();

export const DeviceEnrollmentResponseSchema = z
  .object({
    data: z
      .object({
        device: DeviceViewSchema,
        enrollment: DeviceEnrollmentSchema
      })
      .strict()
  })
  .strict();

export const ProjectViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  canonicalKey: z.string(),
  assignmentReason: z.string(),
  promptCount: z.number().int().nonnegative(),
  deviceCount: z.number().int().nonnegative(),
  lastActivityAt: z.string().nullable(),
  recentPrompt: z.string().nullable()
});

export const EvidenceViewSchema = z
  .object({
    id: z.string(),
    excerpt: z.string(),
    projectName: z.string(),
    occurredAt: DateTimeSchema
  })
  .strict();

const SummaryStatementSchema = z
  .object({
    text: z.string(),
    evidenceIds: z.array(z.string())
  })
  .strict();

export const WorkDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });

export const SummaryViewSchema = z
  .object({
    id: z.string(),
    workDate: WorkDateSchema,
    status: z.enum(["complete", "partial"]),
    inputTruncated: z.boolean().default(false),
    highlights: z.array(SummaryStatementSchema),
    projectProgress: z.array(SummaryStatementSchema),
    decisions: z.array(SummaryStatementSchema),
    blockers: z.array(SummaryStatementSchema),
    nextActions: z.array(SummaryStatementSchema),
    completenessNote: z.string(),
    evidence: z.array(EvidenceViewSchema)
  })
  .strict();

export const SummaryGenerationRequestSchema = z
  .object({ workDate: WorkDateSchema })
  .strict();

export const SummaryResponseSchema = z
  .object({
    data: z.object({ summary: SummaryViewSchema.nullable() }).strict()
  })
  .strict();

export const SummaryGenerationResponseSchema = z
  .object({
    data: z
      .object({
        summary: SummaryViewSchema,
        generated: z.boolean()
      })
      .strict()
  })
  .strict();

export const SummaryPeriodTypeSchema = z.enum(["WEEK", "MONTH"]);

export const PeriodSummaryRequestSchema = z
  .object({
    periodType: SummaryPeriodTypeSchema,
    periodStart: WorkDateSchema
  })
  .strict()
  .superRefine((value, context) => {
    const date = new Date(`${value.periodStart}T00:00:00.000Z`);
    if (value.periodType === "WEEK" && date.getUTCDay() !== 1) {
      context.addIssue({
        code: "custom",
        message: "weekly summaries must start on Monday",
        path: ["periodStart"]
      });
    }
    if (value.periodType === "MONTH" && !value.periodStart.endsWith("-01")) {
      context.addIssue({
        code: "custom",
        message: "monthly summaries must start on the first day",
        path: ["periodStart"]
      });
    }
  });

export const PeriodSummaryActivityViewSchema = z
  .object({
    periodType: SummaryPeriodTypeSchema,
    periodStart: WorkDateSchema,
    periodEnd: WorkDateSchema,
    promptCount: z.number().int().nonnegative(),
    projectCount: z.number().int().nonnegative(),
    activeDayCount: z.number().int().nonnegative()
  })
  .strict();

export const PeriodSummaryViewSchema = z
  .object({
    id: z.string(),
    periodType: SummaryPeriodTypeSchema,
    periodStart: WorkDateSchema,
    periodEnd: WorkDateSchema,
    dataCompleteness: z.enum(["complete", "partial"]),
    hasContent: z.boolean(),
    inputTruncated: z.boolean(),
    overview: z.array(SummaryStatementSchema),
    majorAccomplishments: z.array(SummaryStatementSchema),
    projectProgress: z.array(SummaryStatementSchema),
    decisions: z.array(SummaryStatementSchema),
    blockers: z.array(SummaryStatementSchema),
    nextFocus: z.array(SummaryStatementSchema),
    completenessNote: z.string(),
    evidence: z.array(EvidenceViewSchema)
  })
  .strict();

export const PeriodSummaryResponseSchema = z
  .object({
    data: z
      .object({
        period: PeriodSummaryActivityViewSchema,
        generationState: z.enum(["missing", "ready"]),
        summary: PeriodSummaryViewSchema.nullable()
      })
      .strict()
  })
  .strict();

export const PeriodSummaryGenerationResponseSchema = z
  .object({
    data: z
      .object({
        period: PeriodSummaryActivityViewSchema,
        generationState: z.literal("ready"),
        summary: PeriodSummaryViewSchema,
        generated: z.boolean()
      })
      .strict()
  })
  .strict();

export const PromptViewSchema = z.object({
  id: z.string(),
  content: z.string(),
  resultExcerpt: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  sourceType: AgentSourceTypeSchema,
  occurredAt: z.string(),
  workDate: z.string(),
  tags: z.array(z.string()),
  isFavorite: z.boolean()
});

export const CalendarDayViewSchema = z.object({
  date: z.string(),
  promptCount: z.number().int().nonnegative(),
  projectCount: z.number().int().nonnegative(),
  summaryStatus: z.enum(["complete", "partial", "missing"]),
  hasSyncError: z.boolean()
});

export const SkillCandidateViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(["candidate", "ignored", "accepted"]),
  evidenceIds: z.array(z.string()),
  evidenceCount: z.number().int().nonnegative(),
  diff: z.array(
    z.object({ type: z.enum(["add", "remove", "context"]), text: z.string() })
  )
});

export const SyncRunViewSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  status: z.enum(["SUCCESS", "PARTIAL", "FAILED"]),
  receivedCount: z.number().int().nonnegative(),
  insertedCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  errorCode: z.string().nullable()
});

export type DeviceView = z.infer<typeof DeviceViewSchema>;
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;
export type DeviceCreateInput = z.infer<typeof DeviceCreateSchema>;
export type DeviceEnrollment = z.infer<typeof DeviceEnrollmentSchema>;
export type DeviceEnrollmentResponse = z.infer<
  typeof DeviceEnrollmentResponseSchema
>;
export type ProjectView = z.infer<typeof ProjectViewSchema>;
export type EvidenceView = z.infer<typeof EvidenceViewSchema>;
export type SummaryView = z.infer<typeof SummaryViewSchema>;
export type SummaryResponse = z.infer<typeof SummaryResponseSchema>;
export type SummaryGenerationResponse = z.infer<
  typeof SummaryGenerationResponseSchema
>;
export type SummaryPeriodType = z.infer<typeof SummaryPeriodTypeSchema>;
export type PeriodSummaryRequest = z.infer<typeof PeriodSummaryRequestSchema>;
export type PeriodSummaryActivityView = z.infer<
  typeof PeriodSummaryActivityViewSchema
>;
export type PeriodSummaryView = z.infer<typeof PeriodSummaryViewSchema>;
export type PeriodSummaryResponse = z.infer<typeof PeriodSummaryResponseSchema>;
export type PeriodSummaryGenerationResponse = z.infer<
  typeof PeriodSummaryGenerationResponseSchema
>;
export type PromptView = z.infer<typeof PromptViewSchema>;
export type CalendarDayView = z.infer<typeof CalendarDayViewSchema>;
export type SkillCandidateView = z.infer<typeof SkillCandidateViewSchema>;
export type SyncRunView = z.infer<typeof SyncRunViewSchema>;

export interface DashboardResponse {
  data: {
    fixtureMode: boolean;
    summary: SummaryView | null;
    devices: DeviceView[];
    projects: ProjectView[];
    pendingSkillCount: number;
  };
}

export interface ProjectsResponse {
  data: ProjectView[];
}

export interface PromptsResponse {
  data: PromptView[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface CalendarResponse {
  data: CalendarDayView[];
  month: string;
}

export interface SkillsResponse {
  data: SkillCandidateView[];
}

export interface SyncResponse {
  data: {
    devices: DeviceView[];
    runs: SyncRunView[];
  };
}

export interface PrivacyResponse {
  data: {
    retentionDays: number | null;
    redactionVersion: string;
    rawContentStored: boolean;
    exportReady: boolean;
    pendingDeletionCount: number;
  };
}
