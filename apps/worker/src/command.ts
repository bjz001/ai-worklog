export interface WorkerCommand {
  workDate: string | null;
}

function validWorkDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseWorkerCommand(arguments_: string[]): WorkerCommand {
  if (arguments_.length > 1) throw new Error("Invalid worker arguments");
  const workDate = arguments_[0] ?? null;
  if (workDate !== null && !validWorkDate(workDate)) {
    throw new Error("Invalid worker date");
  }
  return { workDate };
}
