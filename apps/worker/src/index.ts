import { closeDatabasePool, getPool } from "@ai-worklog/db/client";
import {
  accountTimeZone,
  parseServerIdentity,
  refreshDailyInsights
} from "@ai-worklog/server";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseWorkerCommand } from "./command";
import { workDatesToRefresh } from "./plan";
import {
  acknowledgeSummaryJob,
  listSummaryJobs
} from "./summary-jobs";

function loadEnvironment(): void {
  for (const candidate of [
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), "../../.env.local")
  ]) {
    try {
      loadEnvFile(candidate);
      return;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
}

function safeCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{3,64}$/.test(error.code)
  ) {
    return error.code;
  }
  return "WORKER_FAILED";
}

async function main(): Promise<void> {
  try {
    loadEnvironment();
    const command = parseWorkerCommand(process.argv.slice(2));
    const { accountId } = parseServerIdentity();
    const pool = getPool();
    const timeZone = await accountTimeZone(pool, accountId);
    const jobs = await listSummaryJobs({
      pool,
      accountId,
      workDate: command.workDate ?? undefined
    });
    const jobsByDate = new Map(jobs.map((job) => [job.workDate, job]));
    const workDates = workDatesToRefresh({
      explicitWorkDate: command.workDate,
      dirtyWorkDates: jobs.map((job) => job.workDate),
      timeZone
    });
    const results = [];
    const failures: Array<{ workDate: string; code: string }> = [];
    let acknowledgedCount = 0;
    for (const workDate of workDates) {
      try {
        const result = await refreshDailyInsights({ pool, accountId, workDate });
        results.push(result);
        const job = jobsByDate.get(workDate);
        if (job && !result.requiresManualMerge) {
          if (await acknowledgeSummaryJob({ pool, accountId, job })) {
            acknowledgedCount += 1;
          }
        }
      } catch (error) {
        failures.push({ workDate, code: safeCode(error) });
      }
    }
    console.log(
      JSON.stringify({
        workDates,
        acknowledgedCount,
        failureCount: failures.length,
        failures,
        generatedCount: results.filter((result) => result.generated).length,
        manualMergeCount: results.filter((result) => result.requiresManualMerge).length,
        skillCandidateCount: Math.max(
          0,
          ...results.map((result) => result.skillCandidateCount)
        )
      })
    );
    if (failures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`Worker failed (${safeCode(error)}).`);
    process.exitCode = 1;
  } finally {
    await closeDatabasePool().catch(() => {
      process.exitCode = 1;
    });
  }
}

await main();
