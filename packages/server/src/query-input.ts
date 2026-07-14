import { z } from "zod";

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

const PromptQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(500).default(""),
  date: z.union([IsoDateSchema, z.literal("")]).default(""),
  source: z.enum(["CODEX", "CLAUDE_CODE", ""]).default("")
});

export interface PromptQuery {
  page: number;
  pageSize: number;
  q: string;
  date: string;
  source: "CODEX" | "CLAUDE_CODE" | "";
}

export function parsePromptQuery(searchParams: URLSearchParams): PromptQuery {
  const parsed = PromptQuerySchema.safeParse({
    page: searchParams.get("page") || undefined,
    pageSize: searchParams.get("pageSize") || undefined,
    q: searchParams.get("q") ?? undefined,
    date: searchParams.get("date") ?? undefined,
    source: searchParams.get("source") ?? undefined
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
