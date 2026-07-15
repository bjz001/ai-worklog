import { excerpt, sha256Hex } from "@ai-worklog/core";
import {
  deriveSkillCandidates,
  type EvidenceInput
} from "@ai-worklog/insights";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket
} from "mysql2/promise";
import { accountTimeZone } from "./query-service";
import {
  inferEvidenceIntent,
  utcRangeForWorkDate,
  workDateInTimeZone
} from "./presentation";
import { parseLlmEncryptionKey } from "./llm-crypto";
import {
  getLlmSettingsView,
  getRuntimeLlmSettings
} from "./llm-settings-service";
import {
  generateLlmDailySummary,
  type GeneratedLlmSummary,
  type SummaryEvidence
} from "./llm-summary";
import type { LlmFetcher, LlmResolver } from "./llm-client";

interface EvidenceRow extends RowDataPacket {
  id: string;
  project_id: string | null;
  project_name: string | null;
  device_id: string;
  content: string;
  content_hash: string;
  occurred_at: Date;
  result_content: string | null;
}

interface DeviceRow extends RowDataPacket {
  id: string;
}

interface ArrivalRow extends RowDataPacket {
  device_id: string;
  occurred_at: Date;
}

interface LatestSummaryRow extends RowDataPacket {
  id: string;
  revision: number | string;
  input_fingerprint: string;
  content: unknown;
  is_manually_edited: number | boolean;
}

interface IdentifierRow extends RowDataPacket {
  id: string;
}

interface LockRow extends RowDataPacket {
  acquired: number | string | null;
}

interface ReleaseLockRow extends RowDataPacket {
  released: number | string | null;
}

type QueryExecutor = Pick<PoolConnection, "execute">;

function databaseId(prefix: string, ...parts: string[]): string {
  const digest = sha256Hex([prefix, ...parts].join("\u001f"));
  return `${prefix}_${digest.slice(0, 64 - prefix.length - 1)}`;
}

export function summaryLockName(accountId: string, workDate: string): string {
  return `aiw:summary:${sha256Hex(`${accountId}\u001f${workDate}`).slice(0, 50)}`;
}

export function summaryFingerprint(input: {
  evidenceFingerprint: string;
  expectedDeviceIds: readonly string[];
  arrivedDeviceIds: readonly string[];
  generatorFingerprint?: string;
}): string {
  return sha256Hex(
    [
      "summary-input-v2",
      input.evidenceFingerprint,
      [...input.expectedDeviceIds].sort().join(","),
      [...input.arrivedDeviceIds].sort().join(","),
      input.generatorFingerprint ?? "rule-summary-v1"
    ].join("\u001f")
  );
}

export function summaryEvidenceFingerprint(
  evidence: readonly SummaryEvidence[]
): string {
  return sha256Hex(
    [...evidence]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) =>
        [
          item.id,
          item.contentHash,
          sha256Hex(item.result ?? "")
        ].join(":")
      )
      .join("|")
  );
}

type SummaryEvidenceSections = Pick<
  GeneratedLlmSummary,
  "highlights" | "projectProgress" | "decisions" | "blockers" | "nextActions"
>;

export function summaryEvidenceStatements(summary: SummaryEvidenceSections) {
  return [
    ...summary.highlights.map((statement, index) => ({
      key: `highlight:${index}`,
      ...statement
    })),
    ...summary.projectProgress.map((statement, index) => ({
      key: `project:${index}`,
      ...statement
    })),
    ...summary.decisions.map((statement, index) => ({
      key: `decision:${index}`,
      ...statement
    })),
    ...summary.blockers.map((statement, index) => ({
      key: `blocker:${index}`,
      ...statement
    })),
    ...summary.nextActions.map((statement, index) => ({
      key: `next-action:${index}`,
      ...statement
    }))
  ];
}

export function latestSummaryMatchesInput(options: {
  latestInputFingerprint: string;
  latestContent: unknown;
  requestedInputFingerprint: string;
  canonicalInputFingerprint: string;
  isManualRegeneration: boolean;
}): boolean {
  if (options.latestInputFingerprint === options.requestedInputFingerprint) {
    return true;
  }
  if (options.isManualRegeneration) return false;

  try {
    const content = typeof options.latestContent === "string"
      ? JSON.parse(options.latestContent) as unknown
      : options.latestContent;
    return (
      Boolean(content) &&
      typeof content === "object" &&
      !Array.isArray(content) &&
      (content as Record<string, unknown>).canonicalInputFingerprint ===
        options.canonicalInputFingerprint
    );
  } catch {
    return false;
  }
}

function broadUtcRange(workDate: string): { from: Date; until: Date } {
  const center = new Date(`${workDate}T00:00:00.000Z`);
  return {
    from: new Date(center.getTime() - 2 * 24 * 60 * 60 * 1000),
    until: new Date(center.getTime() + 3 * 24 * 60 * 60 * 1000)
  };
}

async function evidenceForDate(options: {
  pool: QueryExecutor;
  accountId: string;
  timeZone: string;
  workDate: string;
}): Promise<SummaryEvidence[]> {
  const range = broadUtcRange(options.workDate);
  const [rows] = await options.pool.execute<EvidenceRow[]>(
    `SELECT pe.collected_event_id AS id, pe.project_id,
            COALESCE(p.name, '未分类项目') AS project_name,
            pe.device_id, pe.sanitized_content AS content, pe.content_hash,
            (SELECT vr.sanitized_content
               FROM visible_results vr
              WHERE vr.account_id = pe.account_id
                AND vr.prompt_entry_id = pe.id
              ORDER BY vr.occurred_at DESC
              LIMIT 1) AS result_content,
            pe.occurred_at
       FROM prompt_entries pe
       LEFT JOIN projects p
         ON p.id = pe.project_id AND p.account_id = pe.account_id
      WHERE pe.account_id = ? AND pe.occurred_at >= ? AND pe.occurred_at < ?
      ORDER BY pe.occurred_at ASC`,
    [options.accountId, range.from, range.until]
  );
  return rows
    .filter(
      (row) =>
        workDateInTimeZone(row.occurred_at, options.timeZone) === options.workDate
    )
    .map((row) => ({
      id: row.id,
      projectId: row.project_id ?? "unclassified",
      projectName: row.project_name ?? "未分类项目",
      deviceId: row.device_id,
      content: row.content,
      contentHash: row.content_hash,
      result: row.result_content,
      occurredAt: row.occurred_at.toISOString(),
      intent: inferEvidenceIntent(row.content)
    }));
}

async function arrivedDevicesForDate(options: {
  pool: QueryExecutor;
  accountId: string;
  timeZone: string;
  workDate: string;
}): Promise<string[]> {
  const range = broadUtcRange(options.workDate);
  const [rows] = await options.pool.execute<ArrivalRow[]>(
    `SELECT device_id, occurred_at FROM collected_events
      WHERE account_id = ? AND occurred_at >= ? AND occurred_at < ?`,
    [options.accountId, range.from, range.until]
  );
  return [
    ...new Set(
      rows
        .filter(
          (row) =>
            workDateInTimeZone(row.occurred_at, options.timeZone) ===
            options.workDate
        )
        .map((row) => row.device_id)
    )
  ];
}

export async function expectedDeviceIdsForDate(options: {
  pool: QueryExecutor;
  accountId: string;
  timeZone: string;
  workDate: string;
}): Promise<string[]> {
  const range = utcRangeForWorkDate(options.workDate, options.timeZone);
  const [rows] = await options.pool.execute<DeviceRow[]>(
    `SELECT id FROM devices
      WHERE account_id = ? AND status = 'ACTIVE' AND created_at < ?
      ORDER BY id`,
    [options.accountId, range.until]
  );
  return rows.map((row) => row.id);
}

async function refreshSkillCandidates(options: {
  pool: QueryExecutor;
  accountId: string;
}): Promise<number> {
  const [rows] = await options.pool.execute<EvidenceRow[]>(
    `SELECT pe.collected_event_id AS id, pe.project_id,
            COALESCE(p.name, '未分类项目') AS project_name,
            pe.device_id, pe.sanitized_content AS content, pe.content_hash,
            pe.occurred_at
       FROM prompt_entries pe
       LEFT JOIN projects p
         ON p.id = pe.project_id AND p.account_id = pe.account_id
      WHERE pe.account_id = ?
      ORDER BY pe.occurred_at DESC
      LIMIT 5000`,
    [options.accountId]
  );
  const evidence: EvidenceInput[] = rows.map((row) => ({
    id: row.id,
    projectId: row.project_id ?? "unclassified",
    projectName: row.project_name ?? "未分类项目",
    deviceId: row.device_id,
    content: row.content,
    contentHash: row.content_hash,
    occurredAt: row.occurred_at.toISOString(),
    intent: inferEvidenceIntent(row.content)
  }));
  const drafts = deriveSkillCandidates(evidence);

  for (const draft of drafts) {
    const candidateEvidence = evidence.filter((item) =>
      draft.evidenceIds.includes(item.id)
    );
    const proposal = {
      intent: draft.intent,
      evidenceIds: draft.evidenceIds,
      suggestedSteps: draft.suggestedSteps,
      diff: draft.suggestedSteps.map((step) => ({ type: "add", text: step }))
    };
    await options.pool.execute(
      `INSERT INTO skill_candidates
         (id, account_id, project_id, name, slug, description, status,
          evidence_count, proposal)
       VALUES (?, ?, ?, ?, ?, ?, 'CANDIDATE', ?, ?)
       ON DUPLICATE KEY UPDATE
         project_id = IF(status IN ('CANDIDATE', 'IN_REVIEW'), VALUES(project_id), project_id),
         name = IF(status IN ('CANDIDATE', 'IN_REVIEW'), VALUES(name), name),
         description = IF(status IN ('CANDIDATE', 'IN_REVIEW'), VALUES(description), description),
         evidence_count = IF(status IN ('CANDIDATE', 'IN_REVIEW'), VALUES(evidence_count), evidence_count),
         proposal = IF(status IN ('CANDIDATE', 'IN_REVIEW'), VALUES(proposal), proposal),
         updated_at = IF(status IN ('CANDIDATE', 'IN_REVIEW'), UTC_TIMESTAMP(6), updated_at)`,
      [
        databaseId("skill", options.accountId, draft.intent),
        options.accountId,
        candidateEvidence[0]?.projectId === "unclassified"
          ? null
          : candidateEvidence[0]?.projectId ?? null,
        draft.name,
        draft.intent,
        draft.description,
        draft.evidenceIds.length,
        JSON.stringify(proposal)
      ]
    );
  }
  return drafts.length;
}

export interface RefreshInsightResult {
  workDate: string;
  generated: boolean;
  requiresManualMerge: boolean;
  summaryId: string | null;
  skillCandidateCount: number;
}

async function refreshDailyInsightsLocked(options: {
  connection: PoolConnection;
  accountId: string;
  workDate: string;
  masterKey?: Buffer;
  fetcher?: LlmFetcher;
  resolver?: LlmResolver;
  regenerationKey?: string;
}): Promise<RefreshInsightResult> {
  const timeZone = await accountTimeZone(options.connection, options.accountId);
  const [deviceRows, evidence, arrivedDeviceIds, latestRows] = await Promise.all([
    expectedDeviceIdsForDate({
      pool: options.connection,
      accountId: options.accountId,
      workDate: options.workDate,
      timeZone
    }),
    evidenceForDate({
      pool: options.connection,
      accountId: options.accountId,
      workDate: options.workDate,
      timeZone
    }),
    arrivedDevicesForDate({
      pool: options.connection,
      accountId: options.accountId,
      workDate: options.workDate,
      timeZone
    }),
    options.connection.execute<LatestSummaryRow[]>(
      `SELECT id, revision, input_fingerprint, content, is_manually_edited
         FROM daily_summaries
        WHERE account_id = ? AND work_date = ?
        ORDER BY revision DESC
        LIMIT 1`,
      [options.accountId, options.workDate]
    )
  ]);
  const expectedDeviceIds = deviceRows;
  const llmView = await getLlmSettingsView({
    pool: options.connection,
    accountId: options.accountId
  });
  const canonicalGeneratorFingerprint = [
    "llm-summary-v1",
    llmView.provider,
    llmView.baseUrl,
    llmView.model
  ].join(":");
  const evidenceFingerprint = summaryEvidenceFingerprint(evidence);
  const canonicalInputFingerprint = summaryFingerprint({
    evidenceFingerprint,
    expectedDeviceIds,
    arrivedDeviceIds,
    generatorFingerprint: canonicalGeneratorFingerprint
  });
  const generatorFingerprint = options.regenerationKey
    ? `${canonicalGeneratorFingerprint}:manual:${options.regenerationKey}`
    : canonicalGeneratorFingerprint;
  const inputFingerprint = summaryFingerprint({
    evidenceFingerprint,
    expectedDeviceIds,
    arrivedDeviceIds,
    generatorFingerprint
  });
  const latest = latestRows[0][0];
  const skillCandidateCount = await refreshSkillCandidates({
    pool: options.connection,
    accountId: options.accountId
  });
  if (
    latest &&
    latestSummaryMatchesInput({
      latestInputFingerprint: latest.input_fingerprint,
      latestContent: latest.content,
      requestedInputFingerprint: inputFingerprint,
      canonicalInputFingerprint,
      isManualRegeneration: Boolean(options.regenerationKey)
    })
  ) {
    return {
      workDate: options.workDate,
      generated: false,
      requiresManualMerge: false,
      summaryId: latest.id,
      skillCandidateCount
    };
  }
  if (latest && Boolean(latest.is_manually_edited)) {
    await options.connection.execute(
      `UPDATE daily_summaries SET status = 'STALE'
        WHERE id = ? AND account_id = ?`,
      [latest.id, options.accountId]
    );
    return {
      workDate: options.workDate,
      generated: false,
      requiresManualMerge: true,
      summaryId: latest.id,
      skillCandidateCount
    };
  }

  const llmSettings = await getRuntimeLlmSettings({
    pool: options.connection,
    accountId: options.accountId,
    masterKey: options.masterKey ?? parseLlmEncryptionKey()
  });
  const summary = await generateLlmDailySummary({
    settings: llmSettings,
    workDate: options.workDate,
    timeZone,
    expectedDeviceIds,
    arrivedDeviceIds,
    evidence,
    fetcher: options.fetcher,
    resolver: options.resolver
  });

  const revision = Number(latest?.revision ?? 0) + 1;
  const summaryId = databaseId(
    "summary",
    options.accountId,
    options.workDate,
    inputFingerprint
  );
  const connection = options.connection;
  try {
    await connection.beginTransaction();
    const [insert] = await connection.execute<ResultSetHeader>(
      `INSERT INTO daily_summaries
         (id, account_id, work_date, time_zone, revision, status,
          input_fingerprint, content, coverage, model_provider, model_name,
          template_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'llm-summary-v1')
       ON DUPLICATE KEY UPDATE id = id`,
      [
        summaryId,
        options.accountId,
        options.workDate,
        timeZone,
        revision,
        summary.status === "complete" ? "COMPLETE" : "PARTIAL",
        inputFingerprint,
        JSON.stringify({
          ...summary,
          inputFingerprint,
          canonicalInputFingerprint
        }),
        JSON.stringify({ expectedDeviceIds, arrivedDeviceIds }),
        llmSettings.provider,
        llmSettings.model
      ]
    );
    const [summaryRows] = await connection.execute<IdentifierRow[]>(
      `SELECT id FROM daily_summaries
        WHERE account_id = ? AND work_date = ? AND input_fingerprint = ?
        LIMIT 1`,
      [options.accountId, options.workDate, inputFingerprint]
    );
    const persistedSummaryId = summaryRows[0]?.id;
    if (!persistedSummaryId) throw new Error("SUMMARY_NOT_FOUND");

    if (insert.affectedRows === 1) {
      const statements = summaryEvidenceStatements(summary);
      const evidenceById = new Map(evidence.map((item) => [item.id, item]));
      for (const statement of statements) {
        for (const evidenceId of statement.evidenceIds) {
          const item = evidenceById.get(evidenceId);
          if (!item) continue;
          await connection.execute(
            `INSERT INTO summary_evidence
               (id, account_id, summary_id, collected_event_id, claim_key,
                claim_type, excerpt)
             VALUES (?, ?, ?, ?, ?, 'FACT', ?)`,
            [
              databaseId(
                "evidence",
                persistedSummaryId,
                statement.key,
                evidenceId
              ),
              options.accountId,
              persistedSummaryId,
              evidenceId,
              statement.key,
              excerpt(item.content, 240)
            ]
          );
        }
      }
      await connection.execute(
        `INSERT INTO audit_logs
           (account_id, action, resource_type, resource_id, outcome, metadata)
         VALUES (?, 'DAILY_SUMMARY_GENERATED', 'DAILY_SUMMARY', ?, 'SUCCEEDED', ?)`,
        [
          options.accountId,
          persistedSummaryId,
          JSON.stringify({
            workDate: options.workDate,
            revision,
            evidenceCount: evidence.length,
            status: summary.status,
            provider: llmSettings.provider,
            model: llmSettings.model
          })
        ]
      );
    }
    await connection.commit();
    return {
      workDate: options.workDate,
      generated: insert.affectedRows === 1,
      requiresManualMerge: false,
      summaryId: persistedSummaryId,
      skillCandidateCount
    };
  } catch (error) {
    await connection.rollback().catch(() => connection.destroy());
    throw error;
  }
}

export async function refreshDailyInsights(options: {
  pool: Pool;
  accountId: string;
  workDate: string;
  masterKey?: Buffer;
  fetcher?: LlmFetcher;
  resolver?: LlmResolver;
  regenerationKey?: string;
}): Promise<RefreshInsightResult> {
  const connection = await options.pool.getConnection();
  const lockName = summaryLockName(options.accountId, options.workDate);
  let acquired = false;
  let reusable = true;
  try {
    const [rows] = await connection.execute<LockRow[]>(
      "SELECT GET_LOCK(?, 10) AS acquired",
      [lockName]
    );
    acquired = Number(rows[0]?.acquired) === 1;
    if (!acquired) throw new Error("SUMMARY_LOCK_TIMEOUT");
    return await refreshDailyInsightsLocked({
      connection,
      accountId: options.accountId,
      workDate: options.workDate,
      masterKey: options.masterKey,
      fetcher: options.fetcher,
      resolver: options.resolver,
      regenerationKey: options.regenerationKey
    });
  } finally {
    if (acquired) {
      try {
        const [rows] = await connection.execute<ReleaseLockRow[]>(
          "SELECT RELEASE_LOCK(?) AS released",
          [lockName]
        );
        reusable = Number(rows[0]?.released) === 1;
      } catch {
        reusable = false;
      }
    }
    if (reusable) connection.release();
    else connection.destroy();
  }
}

export async function refreshInsightsForEvents(options: {
  pool: Pool;
  accountId: string;
  occurredAt: readonly string[];
}): Promise<RefreshInsightResult[]> {
  const timeZone = await accountTimeZone(options.pool, options.accountId);
  const dates = [
    ...new Set(
      options.occurredAt.map((timestamp) =>
        workDateInTimeZone(timestamp, timeZone)
      )
    )
  ].sort();
  const results: RefreshInsightResult[] = [];
  for (const workDate of dates) {
    results.push(
      await refreshDailyInsights({
        pool: options.pool,
        accountId: options.accountId,
        workDate
      })
    );
  }
  return results;
}
