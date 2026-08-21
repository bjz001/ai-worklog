import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appliedMigrationChecksums,
  loadMigrations,
  planMigrations,
  splitSqlStatements
} from "./migrations";

describe("migration manifest", () => {
  it("defines the full utf8mb4, InnoDB, microsecond-UTC schema", async () => {
    const migrations = await loadMigrations();
    const sql = migrations.map((migration) => migration.sql).join("\n");

    expect(migrations.map((migration) => migration.name)).toEqual([
      "0001_initial.sql",
      "0002_project_canonical_key.sql",
      "0003_summary_jobs.sql",
      "0004_llm_settings.sql",
      "0005_period_summaries.sql",
      "0006_period_summary_evidence.sql",
      "0007_llm_summary_prompts.sql",
      "0008_agent_trajectories.sql"
    ]);

    for (const table of [
      "accounts",
      "devices",
      "device_tokens",
      "sync_batches",
      "projects",
      "sessions",
      "collected_events",
      "event_versions",
      "prompt_entries",
      "visible_results",
      "daily_summaries",
      "period_summaries",
      "summary_jobs",
      "llm_settings",
      "summary_evidence",
      "period_summary_evidence",
      "skill_candidates",
      "audit_logs",
      "agent_text_segments",
      "blob_objects",
      "blob_chunks",
      "event_blob_references",
      "agent_capture_completeness",
      "collector_backfill_cursors"
    ]) {
      expect(sql).toContain(`CREATE TABLE \`${table}\``);
    }
    expect(sql).not.toContain("CREATE TABLE IF NOT EXISTS");

    expect(sql).toMatch(/ENGINE=InnoDB/g);
    expect(sql).toMatch(/CHARSET=utf8mb4/g);
    expect(sql).toContain("DATETIME(6)");
    expect(sql).toContain(
      "UNIQUE KEY `uq_collected_events_account_event` (`account_id`, `event_id`)"
    );
    expect(sql).toContain(
      "UNIQUE KEY `uq_sync_batches_account_device_batch` (`account_id`, `device_id`, `batch_id`)"
    );
    expect(sql).toContain(
      "UNIQUE KEY `uq_sessions_source_identity` (`account_id`, `source_type`, `source_instance_id`, `source_session_id`)"
    );
    expect(sql).toContain("uq_projects_account_canonical_key");
    expect(sql).toContain("MODIFY COLUMN `source_type` VARCHAR(32) NOT NULL");
    expect(sql).toContain("MODIFY COLUMN `source_session_key` CHAR(64) NOT NULL");
    expect(sql).toContain("MODIFY COLUMN `kind` VARCHAR(64) NOT NULL");
    expect(sql).toContain("FULLTEXT KEY `ft_agent_text_segments_content`");
    expect(sql).toContain("`group_segment_count` BIGINT UNSIGNED NOT NULL");
    expect(sql).toContain("uq_agent_text_segments_event_group_ordinal");
    expect(sql).toContain("UNIQUE KEY `uq_blob_objects_account_sha256`");
  });

  it("plans no work when an unchanged migration was already applied", async () => {
    const migrations = await loadMigrations();
    const applied = new Map(
      migrations.map((migration) => [migration.name, migration.checksum])
    );

    expect(planMigrations(migrations, applied)).toEqual([]);
  });

  it("refuses to run when an applied migration was modified", async () => {
    const [migration] = await loadMigrations();

    expect(() =>
      planMigrations([migration], new Map([[migration.name, "0".repeat(64)]]))
    ).toThrow(/checksum/i);
  });

  it("rejects missing, duplicate, or retroactively inserted migrations", async () => {
    const [migration] = await loadMigrations();

    expect(() =>
      planMigrations([migration], new Map([["0000_removed.sql", "a".repeat(64)]]))
    ).toThrow(/missing/i);
    expect(() => planMigrations([migration, migration], new Map())).toThrow(
      /duplicate/i
    );
    expect(() =>
      planMigrations(
        [
          { name: "0000_inserted_late.sql", checksum: "b".repeat(64), sql: "SELECT 1" },
          migration
        ],
        new Map([[migration.name, migration.checksum]])
      )
    ).toThrow(/historical/i);
  });

  it("loads migrations only from the explicitly selected directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-worklog-migrations-"));
    try {
      await writeFile(
        join(directory, "9999_test_only.sql"),
        "SELECT 'custom migration';\n",
        "utf8"
      );

      const migrations = await loadMigrations(directory);

      expect(migrations.map(({ name }) => name)).toEqual([
        "9999_test_only.sql"
      ]);
      expect(migrations[0]?.sql).toContain("custom migration");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to continue when a non-transactional DDL migration is dirty", () => {
    expect(() =>
      appliedMigrationChecksums([
        {
          name: "0001_initial.sql",
          checksum: "a".repeat(64),
          status: "RUNNING"
        }
      ])
    ).toThrow(/dirty/i);
  });
});

describe("splitSqlStatements", () => {
  it("does not split semicolons inside strings, identifiers, or comments", () => {
    const sql = [
      "-- comment containing ;",
      "CREATE TABLE `semi;colon` (`value` VARCHAR(20));",
      "INSERT INTO `semi;colon` VALUES ('a;b');",
      "# another ; comment",
      "SELECT \"c;d\";"
    ].join("\n");

    expect(splitSqlStatements(sql)).toHaveLength(3);
  });
});
