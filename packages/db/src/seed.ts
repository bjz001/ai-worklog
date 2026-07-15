import { createDatabaseClient, createDatabasePool } from "./client";
import { parseDatabaseConfig } from "./config";
import { loadLocalEnvironment, safeDatabaseErrorCode } from "./environment";
import { parseSeedConfig } from "./seed-plan";
import { runDemoSeed } from "./seeding";
import type { Pool } from "mysql2/promise";

async function main(): Promise<void> {
  let pool: Pool | undefined;
  try {
    loadLocalEnvironment();
    pool = createDatabasePool(parseDatabaseConfig());
    const result = await runDemoSeed(
      createDatabaseClient(pool),
      parseSeedConfig()
    );
    console.log(
      `Database seed complete: ${result.deviceCount} devices (${result.deviceIds.macos}, ${result.deviceIds.windows}) and ${result.deviceTokenCount} new token HMACs inserted; existing credentials were preserved.`
    );
  } catch (error) {
    console.error(`Database seed failed (${safeDatabaseErrorCode(error)}).`);
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
