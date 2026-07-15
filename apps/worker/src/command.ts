export interface WorkerCommand {
  mode: "today" | "date" | "backfill";
  workDate: string | null;
}

function validWorkDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseWorkerCommand(arguments_: string[]): WorkerCommand {
  if (arguments_.length === 0) return { mode: "today", workDate: null };
  if (arguments_.length !== 1) throw new Error("Invalid worker arguments");
  const value = arguments_[0];
  if (value === "--backfill") return { mode: "backfill", workDate: null };
  if (!value || value.startsWith("-")) throw new Error("Invalid worker arguments");
  if (!validWorkDate(value)) {
    throw new Error("Invalid worker date");
  }
  return { mode: "date", workDate: value };
}
