import { createDatabasePool } from "./client";
import { parseDatabaseConfig } from "./config";
import { loadLocalEnvironment, safeDatabaseErrorCode } from "./environment";
import { runMigrations } from "./migrations";
import type { Pool } from "mysql2/promise";

async function main(): Promise<void> {
  let pool: Pool | undefined;
  try {
    loadLocalEnvironment();
    pool = createDatabasePool(parseDatabaseConfig());
    const result = await runMigrations(pool);
    console.log(
      `Database migration complete: ${result.applied.length} applied, ${result.skipped.length} unchanged.`
    );
  } catch (error) {
    console.error(`Database migration failed (${safeDatabaseErrorCode(error)}).`);
    process.exitCode = 1;
  } finally {
    try {
      await pool?.end();
    } catch (error) {
      console.error(
        `Database pool cleanup failed (${safeDatabaseErrorCode(error)}).`
      );
      process.exitCode = 1;
    }
  }
}

await main();
