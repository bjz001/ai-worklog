import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

const migrationFilePattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const migrationLockName = "ai_worklog_schema_migrations";

export interface Migration {
  name: string;
  checksum: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export interface MigrationState {
  name: string;
  checksum: string;
  status: "RUNNING" | "APPLIED";
}

export const defaultMigrationsDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url)
);

export async function loadMigrations(
  directory = defaultMigrationsDirectory
): Promise<Migration[]> {
  const fileNames = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && migrationFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const migrations = await Promise.all(
    fileNames.map(async (name) => {
      const sql = await readFile(join(directory, name), "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex")
      };
    })
  );

  if (new Set(migrations.map(({ name }) => name)).size !== migrations.length) {
    throw new Error("Duplicate migration names are not allowed");
  }

  return migrations;
}

export function planMigrations(
  migrations: Migration[],
  applied: ReadonlyMap<string, string>
): Migration[] {
  const migrationNames = migrations.map(({ name }) => name);
  if (new Set(migrationNames).size !== migrationNames.length) {
    throw new Error("Duplicate migration names are not allowed");
  }

  const manifestNames = new Set(migrationNames);
  for (const appliedName of applied.keys()) {
    if (!manifestNames.has(appliedName)) {
      throw new Error(`Applied migration is missing from the manifest: ${appliedName}`);
    }
  }

  const latestAppliedName = [...applied.keys()].sort().at(-1);
  const pending: Migration[] = [];

  for (const migration of [...migrations].sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const existingChecksum = applied.get(migration.name);
    if (existingChecksum === undefined) {
      if (latestAppliedName !== undefined && migration.name < latestAppliedName) {
        throw new Error(
          `Historical migration ${migration.name} cannot be inserted before ${latestAppliedName}`
        );
      }
      pending.push(migration);
      continue;
    }

    if (existingChecksum !== migration.checksum) {
      throw new Error(
        `Migration checksum mismatch for ${migration.name}; applied migrations are immutable`
      );
    }
  }

  return pending;
}

export function appliedMigrationChecksums(
  states: MigrationState[]
): Map<string, string> {
  const dirty = states.find(({ status }) => status !== "APPLIED");
  if (dirty) {
    throw new Error(
      `Dirty migration state detected for ${dirty.name}; perform an explicit forward repair before retrying`
    );
  }
  return new Map(states.map(({ name, checksum }) => [name, checksum]));
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] ?? "";
    const next = sql[index + 1] ?? "";
    const afterNext = sql[index + 2] ?? "";

    if (inLineComment) {
      current += character;
      if (character === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      current += character;
      if (character === "*" && next === "/") {
        current += next;
        index += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (quote !== null) {
      current += character;
      if (character === "\\" && quote !== "`" && next) {
        current += next;
        index += 1;
      } else if (character === quote && next === quote) {
        current += next;
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (
      character === "-" &&
      next === "-" &&
      (afterNext === "" || /\s/.test(afterNext))
    ) {
      current += character + next;
      index += 1;
      inLineComment = true;
      continue;
    }

    if (character === "#") {
      current += character;
      inLineComment = true;
      continue;
    }

    if (character === "/" && next === "*") {
      current += character + next;
      index += 1;
      inBlockComment = true;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      current += character;
      continue;
    }

    if (character === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

export async function runMigrations(
  pool: Pool,
  migrations?: Migration[]
): Promise<MigrationResult> {
  const connection = await pool.getConnection();
  let lockAcquired = false;

  try {
    const [lockRows] = await connection.query<RowDataPacket[]>(
      "SELECT GET_LOCK(?, 30) AS acquired",
      [migrationLockName]
    );
    lockAcquired = Number(lockRows[0]?.acquired) === 1;
    if (!lockAcquired) {
      throw new Error("Timed out waiting for the database migration lock");
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`__ai_worklog_migrations\` (
        \`name\` VARCHAR(255) NOT NULL PRIMARY KEY,
        \`checksum\` CHAR(64) NOT NULL,
        \`status\` ENUM('RUNNING', 'APPLIED') NOT NULL,
        \`started_at\` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`applied_at\` DATETIME(6) NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT `name`, `checksum`, `status` FROM `__ai_worklog_migrations`"
    );
    const applied = appliedMigrationChecksums(
      rows.map((row) => ({
        name: String(row.name),
        checksum: String(row.checksum),
        status: String(row.status) as MigrationState["status"]
      }))
    );
    const manifest = migrations ?? (await loadMigrations());
    const pending = planMigrations(manifest, applied);

    for (const migration of pending) {
      await connection.execute(
        "INSERT INTO `__ai_worklog_migrations` (`name`, `checksum`, `status`) VALUES (?, ?, 'RUNNING')",
        [migration.name, migration.checksum]
      );
      for (const statement of splitSqlStatements(migration.sql)) {
        await connection.query(statement);
      }
      const [updateResult] = await connection.execute<ResultSetHeader>(
        "UPDATE `__ai_worklog_migrations` SET `status` = 'APPLIED', `applied_at` = CURRENT_TIMESTAMP(6) WHERE `name` = ? AND `checksum` = ? AND `status` = 'RUNNING'",
        [migration.name, migration.checksum]
      );
      if (updateResult.affectedRows !== 1) {
        throw new Error(`Failed to finalize migration state for ${migration.name}`);
      }
    }

    return {
      applied: pending.map(({ name }) => name),
      skipped: manifest
        .filter(({ name }) => applied.has(name))
        .map(({ name }) => name)
    };
  } finally {
    let canReturnConnectionToPool = true;
    if (lockAcquired) {
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [migrationLockName]);
      } catch {
        connection.destroy();
        canReturnConnectionToPool = false;
      }
    }
    if (canReturnConnectionToPool) connection.release();
  }
}
