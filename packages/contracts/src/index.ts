import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const DateTimeSchema = z.string().datetime({ offset: true });

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
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

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

export const EvidenceViewSchema = z.object({
  id: z.string(),
  excerpt: z.string(),
  projectName: z.string(),
  occurredAt: z.string()
});

export const SummaryViewSchema = z.object({
  id: z.string(),
  workDate: z.string(),
  status: z.enum(["complete", "partial"]),
  highlights: z.array(
    z.object({ text: z.string(), evidenceIds: z.array(z.string()) })
  ),
  projectProgress: z.array(
    z.object({ text: z.string(), evidenceIds: z.array(z.string()) })
  ),
  completenessNote: z.string(),
  evidence: z.array(EvidenceViewSchema)
});

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
export type ProjectView = z.infer<typeof ProjectViewSchema>;
export type EvidenceView = z.infer<typeof EvidenceViewSchema>;
export type SummaryView = z.infer<typeof SummaryViewSchema>;
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
