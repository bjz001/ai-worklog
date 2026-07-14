import { workDateInTimeZone } from "@ai-worklog/server";

export function workDatesToRefresh(options: {
  explicitWorkDate: string | null;
  dirtyWorkDates: readonly string[];
  timeZone: string;
  now?: Date;
}): string[] {
  if (options.explicitWorkDate) return [options.explicitWorkDate];
  const dates = new Set<string>([
    workDateInTimeZone(options.now ?? new Date(), options.timeZone)
  ]);
  for (const workDate of options.dirtyWorkDates) dates.add(workDate);
  return [...dates].sort();
}
