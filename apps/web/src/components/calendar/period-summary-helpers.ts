import type { SummaryPeriodType } from "@ai-worklog/contracts";

function parseWorkDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatWorkDateValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function canonicalPeriodStart(
  workDate: string,
  periodType: SummaryPeriodType
): string {
  const date = parseWorkDate(workDate);
  if (periodType === "MONTH") {
    date.setUTCDate(1);
  } else {
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  }
  return formatWorkDateValue(date);
}

export function movePeriodStart(
  periodStart: string,
  periodType: SummaryPeriodType,
  offset: number
): string {
  const date = parseWorkDate(periodStart);
  if (periodType === "MONTH") {
    date.setUTCMonth(date.getUTCMonth() + offset, 1);
  } else {
    date.setUTCDate(date.getUTCDate() + offset * 7);
  }
  return formatWorkDateValue(date);
}

export function periodRangeLabel(
  periodType: SummaryPeriodType,
  periodStart: string,
  periodEnd: string
): string {
  const start = parseWorkDate(periodStart);
  if (periodType === "MONTH") {
    return `${start.getUTCFullYear()} 年 ${start.getUTCMonth() + 1} 月`;
  }
  const end = parseWorkDate(periodEnd);
  const startLabel = `${start.getUTCFullYear()} 年 ${start.getUTCMonth() + 1} 月 ${start.getUTCDate()} 日`;
  const endLabel = start.getUTCFullYear() === end.getUTCFullYear()
    ? `${end.getUTCMonth() + 1} 月 ${end.getUTCDate()} 日`
    : `${end.getUTCFullYear()} 年 ${end.getUTCMonth() + 1} 月 ${end.getUTCDate()} 日`;
  return `${startLabel} – ${endLabel}`;
}

export function periodSummaryPath(
  periodType: SummaryPeriodType,
  periodStart: string
): string {
  return `/api/v1/period-summaries?periodType=${periodType}&periodStart=${periodStart}`;
}

export function periodExportHref(
  periodType: SummaryPeriodType,
  periodStart: string
): string {
  return `/api/v1/period-summaries/export?periodType=${periodType}&periodStart=${periodStart}`;
}

export function localWorkDate(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
}

export function periodEndFromStart(
  periodType: SummaryPeriodType,
  periodStart: string
): string {
  const date = parseWorkDate(periodStart);
  if (periodType === "MONTH") {
    date.setUTCMonth(date.getUTCMonth() + 1, 0);
  } else {
    date.setUTCDate(date.getUTCDate() + 6);
  }
  return formatWorkDateValue(date);
}
