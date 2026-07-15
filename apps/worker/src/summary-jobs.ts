import type {
  Pool,
  ResultSetHeader,
  RowDataPacket
} from "mysql2/promise";
import { MAX_BACKFILL_DATES } from "./plan";

const MAX_FILTERED_WORK_DATES = 2;

interface SummaryJobCountRow extends RowDataPacket {
  total: string | number | bigint;
}

interface SummaryJobRow extends RowDataPacket {
  work_date: string | Date;
  dirty_version: string | number | bigint;
}

type QueryExecutor = Pick<Pool, "execute">;

export interface SummaryJob {
  workDate: string;
  dirtyVersion: string;
}

export interface SummaryJobPage {
  jobs: SummaryJob[];
  totalCount: number;
  remainingCount: number;
  bounded: boolean;
}

function mysqlWorkDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return MAX_BACKFILL_DATES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Invalid summary job page limit");
  }
  return Math.min(value, MAX_BACKFILL_DATES);
}

function mysqlCount(value: string | number | bigint | undefined): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Invalid summary job count");
  }
  return count;
}

function filteredWorkDates(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  const workDates = [...new Set(value)];
  if (workDates.length === 0) {
    throw new Error("Filtered summary job lookup requires a work date");
  }
  if (workDates.length > MAX_FILTERED_WORK_DATES) {
    throw new Error("Filtered summary job lookup accepts at most 2 work dates");
  }
  return workDates;
}

export async function listSummaryJobs(options: {
  pool: QueryExecutor;
  accountId: string;
  workDates?: readonly string[];
  limit?: number;
}): Promise<SummaryJobPage> {
  const workDates = filteredWorkDates(options.workDates);
  const parameters = [options.accountId, ...workDates];
  const dateFilter = workDates.length > 0
    ? ` AND work_date IN (${workDates.map(() => "?").join(", ")})`
    : "";
  const limit = pageLimit(options.limit);
  const [countRows] = await options.pool.execute<SummaryJobCountRow[]>(
    `SELECT COUNT(*) AS total
       FROM summary_jobs
      WHERE account_id = ?${dateFilter}`,
    parameters
  );
  const [rows] = await options.pool.execute<SummaryJobRow[]>(
    `SELECT work_date, dirty_version
      FROM summary_jobs
      WHERE account_id = ?${dateFilter}
      ORDER BY work_date ASC
      LIMIT ${limit}`,
    parameters
  );
  const jobs = rows.map((row) => ({
    workDate: mysqlWorkDate(row.work_date),
    dirtyVersion: String(row.dirty_version)
  }));
  const totalCount = mysqlCount(countRows[0]?.total);
  const remainingCount = Math.max(0, totalCount - jobs.length);
  return {
    jobs,
    totalCount,
    remainingCount,
    bounded: remainingCount > 0
  };
}

export async function acknowledgeSummaryJob(options: {
  pool: QueryExecutor;
  accountId: string;
  job: SummaryJob;
}): Promise<boolean> {
  const [result] = await options.pool.execute<ResultSetHeader>(
    `DELETE FROM summary_jobs
      WHERE account_id = ? AND work_date = ? AND dirty_version = ?`,
    [options.accountId, options.job.workDate, options.job.dirtyVersion]
  );
  return result.affectedRows === 1;
}
