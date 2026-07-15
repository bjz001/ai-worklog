import { workDateInTimeZone } from "@ai-worklog/server";
import type { WorkerCommand } from "./command";

export const MAX_BACKFILL_DATES = 31;

export interface WorkerPlan {
  mode: WorkerCommand["mode"];
  workDates: string[];
  bounded: boolean;
  deferredJobCount: number | null;
}

function previousCalendarWorkDate(workDate: string): string {
  const date = new Date(`${workDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function defaultSummaryJobWorkDates(options: {
  timeZone: string;
  now?: Date;
}): [yesterday: string, today: string] {
  const today = workDateInTimeZone(options.now ?? new Date(), options.timeZone);
  return [previousCalendarWorkDate(today), today];
}

export function workDatesToRefresh(options: {
  command: WorkerCommand;
  dirtyWorkDates: readonly string[];
  totalDirtyCount: number;
  timeZone: string;
  now?: Date;
}): WorkerPlan {
  if (options.command.mode === "today") {
    const [yesterday, today] = defaultSummaryJobWorkDates(options);
    return {
      mode: "today",
      workDates: options.dirtyWorkDates.includes(yesterday)
        ? [yesterday, today]
        : [today],
      bounded: false,
      deferredJobCount: null
    };
  }
  if (options.command.mode === "date") {
    if (!options.command.workDate) throw new Error("Explicit worker date is required");
    return {
      mode: "date",
      workDates: [options.command.workDate],
      bounded: false,
      deferredJobCount: null
    };
  }

  const workDates = [...new Set(options.dirtyWorkDates)]
    .sort()
    .slice(0, MAX_BACKFILL_DATES);
  const totalDirtyCount = Math.max(
    workDates.length,
    Math.max(0, Math.trunc(options.totalDirtyCount))
  );
  const deferredJobCount = Math.max(0, totalDirtyCount - workDates.length);
  return {
    mode: "backfill",
    workDates,
    bounded: deferredJobCount > 0,
    deferredJobCount
  };
}
