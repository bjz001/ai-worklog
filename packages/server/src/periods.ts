import {
  PeriodSummaryRequestSchema,
  type SummaryPeriodType
} from "@ai-worklog/contracts";

export interface SummaryPeriod {
  periodType: SummaryPeriodType;
  periodStart: string;
  periodEnd: string;
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function summaryPeriod(
  periodType: SummaryPeriodType,
  periodStart: string
): SummaryPeriod {
  const parsed = PeriodSummaryRequestSchema.safeParse({
    periodType,
    periodStart
  });
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid summary period");
  }

  const start = new Date(`${parsed.data.periodStart}T00:00:00.000Z`);
  const end = parsed.data.periodType === "WEEK"
    ? new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000)
    : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));

  return {
    periodType: parsed.data.periodType,
    periodStart: parsed.data.periodStart,
    periodEnd: dateKey(end)
  };
}
