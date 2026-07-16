import { z } from "zod";

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
    sanitizedContent: z.string().min(1).max(131_072),
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
        type: z.enum(["CODEX", "CLAUDE_CODE"]),
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

export const LlmProviderSchema = z.enum([
  "DEEPSEEK",
  "OPENAI_COMPATIBLE"
]);

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
      .optional()
  })
  .strict();

export const LlmSettingsViewSchema = z
  .object({
    provider: LlmProviderSchema,
    baseUrl: z.string(),
    model: z.string(),
    hasApiKey: z.boolean(),
    updatedAt: z.string().nullable()
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
  sourceType: z.enum(["CODEX", "CLAUDE_CODE"]),
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
