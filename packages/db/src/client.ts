import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import {
  parseDatabaseConfig,
  toPoolOptions,
  type DatabaseConfig
} from "./config";
import { schema } from "./schema";

export type Database = MySql2Database<typeof schema>;

let singletonPool: Pool | undefined;
let singletonDatabase: Database | undefined;

export function createDatabasePool(
  config: DatabaseConfig = parseDatabaseConfig()
): Pool {
  const pool = createPool(toPoolOptions(config));

  // mysql2 emits this before handing a new connection to a caller. The SET is
  // queued first, so every later statement on that connection observes UTC.
  pool.pool.on("connection", (connection) => {
    connection.query("SET SESSION time_zone = '+00:00'", (error) => {
      if (error) connection.destroy();
    });
  });

  return pool;
}

export function createDatabaseClient(pool: Pool): Database {
  return drizzle(pool, { schema, mode: "default" });
}

export function getPool(): Pool {
  singletonPool ??= createDatabasePool();
  return singletonPool;
}

export function getDatabase(): Database {
  singletonDatabase ??= createDatabaseClient(getPool());
  return singletonDatabase;
}

export async function closeDatabasePool(): Promise<void> {
  const pool = singletonPool;
  singletonDatabase = undefined;
  singletonPool = undefined;
  if (pool) await pool.end();
}
