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
