import { z } from "zod";
import type { AgentSourceType } from "@ai-worklog/contracts";

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

const ProjectIdSchema = z.union([
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  z.literal("")
]);

const PromptQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(500).default(""),
  date: z.union([IsoDateSchema, z.literal("")]).default(""),
  source: z.enum(["CODEX", "CLAUDE_CODE", "ZCODE", "DSH", ""]).default(""),
  projectId: ProjectIdSchema.default("")
});

export interface PromptQuery {
  page: number;
  pageSize: number;
  q: string;
  date: string;
  source: AgentSourceType | "";
  projectId: string;
}

export function parsePromptQuery(searchParams: URLSearchParams): PromptQuery {
  const parsed = PromptQuerySchema.safeParse({
    page: searchParams.get("page") || undefined,
    pageSize: searchParams.get("pageSize") || undefined,
    q: searchParams.get("q") ?? undefined,
    date: searchParams.get("date") ?? undefined,
    source: searchParams.get("source") ?? undefined,
    projectId: searchParams.get("projectId") ?? undefined
  });
  if (!parsed.success) throw new Error("Invalid prompt query");
  return parsed.data;
}

export function parseCalendarMonth(month: string | null): string {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("Invalid calendar month");
  }
  const monthNumber = Number(month.slice(5, 7));
  if (monthNumber < 1 || monthNumber > 12) {
    throw new Error("Invalid calendar month");
  }
  return month;
}

const AgentRunQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    q: z.string().trim().max(500).default(""),
    source: z.enum(["CODEX", "CLAUDE_CODE", "ZCODE", "DSH", ""]).default(""),
    from: z.union([IsoDateSchema, z.literal("")]).default(""),
    to: z.union([IsoDateSchema, z.literal("")]).default(""),
    projectId: ProjectIdSchema.default(""),
    eventKind: z.enum([
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
      "SOURCE_EVENT",
      ""
    ]).default(""),
    completeness: z.enum([
      "CAPTURED",
      "PARTIAL",
      "NOT_EXPOSED",
      "UNREADABLE",
      "CORRUPT",
      ""
    ]).default("")
  })
  .strict()
  .superRefine((query, context) => {
    if (query.from && query.to && query.from > query.to) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "to must not be earlier than from"
      });
    }
  });

export type AgentRunQuery = z.infer<typeof AgentRunQuerySchema>;

export function parseAgentRunQuery(searchParams: URLSearchParams): AgentRunQuery {
  const parsed = AgentRunQuerySchema.safeParse({
    page: searchParams.get("page") || undefined,
    pageSize: searchParams.get("pageSize") || undefined,
    q: searchParams.get("q") ?? undefined,
    source: searchParams.get("source") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    projectId: searchParams.get("projectId") ?? undefined,
    eventKind: searchParams.get("eventKind") ?? undefined,
    completeness: searchParams.get("completeness") ?? undefined
  });
  if (!parsed.success) throw new Error("Invalid agent run query");
  return parsed.data;
}

const AgentEventCursorSchema = z
  .object({
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    eventId: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict();

export type AgentEventCursor = z.infer<typeof AgentEventCursorSchema>;

export function encodeAgentEventCursor(cursor: AgentEventCursor): string {
  return Buffer.from(JSON.stringify(AgentEventCursorSchema.parse(cursor)), "utf8")
    .toString("base64url");
}

export interface AgentEventQuery {
  cursor: AgentEventCursor | null;
  pageSize: number;
}

export function parseAgentEventQuery(
  searchParams: URLSearchParams
): AgentEventQuery {
  const rawCursor = searchParams.get("cursor") ?? "";
  if (rawCursor.length > 2_000) throw new Error("Invalid agent event query");
  const pageSizeResult = z.coerce.number().int().min(1).max(200).default(100)
    .safeParse(searchParams.get("pageSize") || undefined);
  if (!pageSizeResult.success) throw new Error("Invalid agent event query");
  let cursor: AgentEventCursor | null = null;
  if (rawCursor) {
    try {
      const decoded = Buffer.from(rawCursor, "base64url").toString("utf8");
      cursor = AgentEventCursorSchema.parse(JSON.parse(decoded));
    } catch {
      throw new Error("Invalid agent event query");
    }
  }
  return { cursor, pageSize: pageSizeResult.data };
}
