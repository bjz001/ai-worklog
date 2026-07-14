import type {
  Pool,
  ResultSetHeader,
  RowDataPacket
} from "mysql2/promise";

interface SummaryJobRow extends RowDataPacket {
  work_date: string | Date;
  dirty_version: string | number | bigint;
}

type QueryExecutor = Pick<Pool, "execute">;

export interface SummaryJob {
  workDate: string;
  dirtyVersion: string;
}

function mysqlWorkDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export async function listSummaryJobs(options: {
  pool: QueryExecutor;
  accountId: string;
  workDate?: string;
}): Promise<SummaryJob[]> {
  const parameters: string[] = [options.accountId];
  const dateFilter = options.workDate ? " AND work_date = ?" : "";
  if (options.workDate) parameters.push(options.workDate);
  const [rows] = await options.pool.execute<SummaryJobRow[]>(
    `SELECT work_date, dirty_version
       FROM summary_jobs
      WHERE account_id = ?${dateFilter}
      ORDER BY work_date ASC`,
    parameters
  );
  return rows.map((row) => ({
    workDate: mysqlWorkDate(row.work_date),
    dirtyVersion: String(row.dirty_version)
  }));
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
