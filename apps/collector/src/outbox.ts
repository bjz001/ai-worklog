import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface PendingBatch {
  batchId: string;
  payloadJson: string;
  payloadSha256: string;
  attempts: number;
}

export interface OutboxStatus {
  pending: number;
  acked: number;
  total: number;
}

interface BatchRow {
  batch_id: string;
  payload_json: string;
  payload_sha256: string;
  attempts: number;
}

interface StatusRow {
  status: "pending" | "acked";
  count: number;
}

export class Outbox {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new Database(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS outbox_batches (
        batch_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'acked')),
        attempts INTEGER NOT NULL DEFAULT 0,
        acked_at TEXT,
        last_error_code TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_outbox_batches_pending
        ON outbox_batches(status, created_at);
    `);
  }

  enqueue(batch: {
    batchId: string;
    createdAt: string;
    payloadJson: string;
    payloadSha256: string;
  }): boolean {
    if (!/^[a-f0-9]{64}$/u.test(batch.batchId)) throw new Error("Invalid batch ID");
    if (!/^[a-f0-9]{64}$/u.test(batch.payloadSha256)) throw new Error("Invalid payload digest");
    const result = this.database.prepare(`
      INSERT INTO outbox_batches (
        batch_id, created_at, payload_json, payload_sha256
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(batch_id) DO NOTHING
    `).run(batch.batchId, batch.createdAt, batch.payloadJson, batch.payloadSha256);
    if (result.changes === 1) return true;

    const existing = this.database.prepare(`
      SELECT payload_sha256
      FROM outbox_batches
      WHERE batch_id = ?
    `).get(batch.batchId) as { payload_sha256: string } | undefined;
    if (existing?.payload_sha256 !== batch.payloadSha256) {
      throw new Error("Batch identity collision detected");
    }
    return false;
  }

  listPending(limit: number): PendingBatch[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    const rows = this.database.prepare(`
      SELECT batch_id, payload_json, payload_sha256, attempts
      FROM outbox_batches
      WHERE status = 'pending'
      ORDER BY created_at, batch_id
      LIMIT ?
    `).all(safeLimit) as BatchRow[];

    return rows.map((row) => ({
      batchId: row.batch_id,
      payloadJson: row.payload_json,
      payloadSha256: row.payload_sha256,
      attempts: row.attempts
    }));
  }

  recordAttempt(batchId: string): void {
    const result = this.database.prepare(`
      UPDATE outbox_batches
      SET attempts = attempts + 1, last_error_code = NULL
      WHERE batch_id = ? AND status = 'pending'
    `).run(batchId);
    if (result.changes !== 1) throw new Error("Cannot attempt an unknown or ACKed batch");
  }

  recordFailure(batchId: string, errorCode: string): void {
    const safeErrorCode = errorCode.replace(/[^A-Z0-9_-]/gi, "_").slice(0, 64) || "SYNC_FAILED";
    const result = this.database.prepare(`
      UPDATE outbox_batches
      SET last_error_code = ?
      WHERE batch_id = ? AND status = 'pending'
    `).run(safeErrorCode, batchId);
    if (result.changes !== 1) throw new Error("Cannot fail an unknown or ACKed batch");
  }

  markAcked(batchId: string): void {
    const result = this.database.prepare(`
      UPDATE outbox_batches
      SET status = 'acked', acked_at = ?, last_error_code = NULL
      WHERE batch_id = ? AND status = 'pending'
    `).run(new Date().toISOString(), batchId);
    if (result.changes === 1) return;

    const existing = this.database.prepare(
      "SELECT status FROM outbox_batches WHERE batch_id = ?"
    ).get(batchId) as { status: string } | undefined;
    if (!existing) throw new Error("Cannot ACK unknown batch");
  }

  status(): OutboxStatus {
    const rows = this.database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM outbox_batches
      GROUP BY status
    `).all() as StatusRow[];
    const pending = rows.find((row) => row.status === "pending")?.count ?? 0;
    const acked = rows.find((row) => row.status === "acked")?.count ?? 0;
    return { pending, acked, total: pending + acked };
  }

  close(): void {
    this.database.close();
  }
}
