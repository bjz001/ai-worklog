import { createPool } from "mysql2/promise";
import { createDatabasePool } from "./client";
import {
  parseDatabaseConfig,
  toPoolOptions,
  type DatabaseConfig
} from "./config";
import { runMigrations, type MigrationResult } from "./migrations";

export async function bootstrapDatabase(
  config: DatabaseConfig = parseDatabaseConfig()
): Promise<MigrationResult> {
  const serverOptions = toPoolOptions(config);
  delete serverOptions.database;
  const serverPool = createPool(serverOptions);

  try {
    await serverPool.query(
      "CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
      [config.database]
    );
  } finally {
    await serverPool.end();
  }

  const databasePool = createDatabasePool(config);
  try {
    return await runMigrations(databasePool);
  } finally {
    await databasePool.end();
  }
}
