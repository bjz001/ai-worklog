import { bootstrapDatabase } from "./bootstrap-database";
import { parseDatabaseConfig } from "./config";
import { loadLocalEnvironment, safeDatabaseErrorCode } from "./environment";

async function main(): Promise<void> {
  try {
    loadLocalEnvironment();
    const result = await bootstrapDatabase(parseDatabaseConfig());
    console.log(
      `Database bootstrap complete: ${result.applied.length} applied, ${result.skipped.length} unchanged.`
    );
  } catch (error) {
    console.error(`Database bootstrap failed (${safeDatabaseErrorCode(error)}).`);
    process.exitCode = 1;
  }
}

await main();
