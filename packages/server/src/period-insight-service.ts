import type { SummaryPeriodType } from "@ai-worklog/contracts";
import { excerpt, sha256Hex } from "@ai-worklog/core";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket
} from "mysql2/promise";
import type { LlmFetcher, LlmResolver } from "./llm-client";
import { parseLlmEncryptionKey } from "./llm-crypto";
import {
  generateLlmPeriodSummary,
  selectBalancedPeriodEvidence,
  type GeneratedLlmPeriodSummary,
  type SummaryEvidence
} from "./llm-summary";
import {
  getLlmSettingsView,
  getRuntimeLlmSettings
} from "./llm-settings-service";
import {
  expectedDeviceIdsForDate,
  latestSummaryMatchesInput
} from "./insight-service";
import { summaryPeriod, type SummaryPeriod } from "./periods";
import {
  utcRangeForWorkDate,
  workDateInTimeZone
} from "./presentation";
import { accountTimeZone } from "./query-service";

const MAX_PERIOD_EVIDENCE_METADATA = 10_000;
const MAX_SELECTED_PERIOD_EVIDENCE = 80;
const EVIDENCE_INSERT_CHUNK_SIZE = 100;

interface EvidenceMetadataRow extends RowDataPacket {
  id: string;
  project_id: string | null;
  project_name: string | null;
  device_id: string;
  content_hash: string;
  result_hash: string | null;
  occurred_at: Date;
}

interface EvidenceDetailRow extends EvidenceMetadataRow {
  content: string;
  result_content: string | null;
}

interface EvidenceAggregateRow extends RowDataPacket {
  prompt_count: number | string;
  project_count: number | string;
  latest_prompt_update: Date | null;
  latest_result_update: Date | null;
}

interface DeviceArrivalRow extends RowDataPacket {
  device_id: string;
}

interface LatestPeriodSummaryRow extends RowDataPacket {
  id: string;
  revision: number | string;
  input_fingerprint: string;
  content: unknown;
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

interface PeriodEvidenceSnapshot {
  evidence: SummaryEvidence[];
  evidenceFingerprint: string;
  expectedDeviceIds: string[];
  arrivedDeviceIds: string[];
  promptCount: number;
  projectCount: number;
  activeDayCount: number;
  metadataTruncated: boolean;
}

export class PeriodSummaryServiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "PeriodSummaryServiceError";
    this.code = code;
    this.status = status;
  }
}

function databaseId(prefix: string, ...parts: string[]): string {
  const digest = sha256Hex([prefix, ...parts].join("\u001f"));
  return `${prefix}_${digest.slice(0, 64 - prefix.length - 1)}`;
}

export function periodSummaryLockName(
  accountId: string,
  periodType: SummaryPeriodType,
  periodStart: string
): string {
  const digest = sha256Hex(
    `${accountId}\u001f${periodType}\u001f${periodStart}`
  );
  return `aiw:period:${digest.slice(0, 48)}`;
}

export function periodSummaryFingerprint(input: {
  periodType: SummaryPeriodType;
  periodStart: string;
  periodEnd: string;
  evidenceFingerprint: string;
  expectedDeviceIds: readonly string[];
  arrivedDeviceIds: readonly string[];
  generatorFingerprint: string;
}): string {
  return sha256Hex([
    "period-summary-input-v1",
    input.periodType,
    input.periodStart,
    input.periodEnd,
    input.evidenceFingerprint,
    [...input.expectedDeviceIds].sort().join(","),
    [...input.arrivedDeviceIds].sort().join(","),
    input.generatorFingerprint
  ].join("\u001f"));
}

type PeriodEvidenceSections = Pick<
  GeneratedLlmPeriodSummary,
  | "overview"
  | "majorAccomplishments"
  | "projectProgress"
  | "decisions"
  | "blockers"
  | "nextFocus"
>;

export function periodSummaryEvidenceStatements(
  summary: PeriodEvidenceSections
) {
  return [
    ...summary.overview.map((statement, index) => ({
      key: `overview:${index}`,
      ...statement
    })),
    ...summary.majorAccomplishments.map((statement, index) => ({
      key: `accomplishment:${index}`,
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
    ...summary.nextFocus.map((statement, index) => ({
      key: `next-focus:${index}`,
      ...statement
    }))
  ];
}

export const periodSummaryDatabaseId = databaseId;

function asCount(value: number | string | null | undefined): number {
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function snapshotFingerprint(options: {
  rows: readonly EvidenceMetadataRow[];
  promptCount: number;
  projectCount: number;
  latestPromptUpdate: Date | null;
  latestResultUpdate: Date | null;
  metadataTruncated: boolean;
}): string {
  return sha256Hex([
    "period-evidence-v1",
    String(options.promptCount),
    String(options.projectCount),
    options.latestPromptUpdate?.toISOString() ?? "",
    options.latestResultUpdate?.toISOString() ?? "",
    options.metadataTruncated ? "truncated" : "complete",
    options.rows.map((row) => [
      row.id,
      row.project_id ?? "",
      row.device_id,
      row.content_hash,
      row.result_hash ?? "",
      row.occurred_at.toISOString()
    ].join(":")).join("|")
  ].join("\u001f"));
}

async function selectedEvidenceDetails(options: {
  pool: QueryExecutor;
  accountId: string;
  metadata: readonly EvidenceMetadataRow[];
  timeZone: string;
}): Promise<SummaryEvidence[]> {
  const candidates = options.metadata.map((row) => ({
    id: row.id,
    projectId: row.project_id ?? "unclassified",
    projectName: row.project_name ?? "未分类项目",
    deviceId: row.device_id,
    content: "",
    contentHash: row.content_hash,
    occurredAt: row.occurred_at.toISOString(),
    workDate: workDateInTimeZone(row.occurred_at, options.timeZone),
    result: row.result_hash ? "result-available" : null
  }));
  const selected = selectBalancedPeriodEvidence(
    candidates,
    MAX_SELECTED_PERIOD_EVIDENCE
  );
  if (selected.length === 0) return [];
  const placeholders = selected.map(() => "?").join(", ");
  const [rows] = await options.pool.execute<EvidenceDetailRow[]>(
    `SELECT pe.collected_event_id AS id, pe.project_id,
            COALESCE(p.name, '未分类项目') AS project_name,
            pe.device_id, pe.sanitized_content AS content, pe.content_hash,
            (SELECT vr.content_hash
               FROM visible_results vr
              WHERE vr.account_id = pe.account_id
                AND vr.prompt_entry_id = pe.id
              ORDER BY vr.occurred_at DESC
              LIMIT 1) AS result_hash,
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
      WHERE pe.account_id = ? AND pe.collected_event_id IN (${placeholders})`,
    [options.accountId, ...selected.map((item) => item.id)]
  );
  const detailsById = new Map(rows.map((row) => [row.id, row]));
  return selected.flatMap((item) => {
    const row = detailsById.get(item.id);
    if (!row) return [];
    return [{
      id: row.id,
      projectId: row.project_id ?? "unclassified",
      projectName: row.project_name ?? "未分类项目",
      deviceId: row.device_id,
      content: row.content,
      contentHash: row.content_hash,
      occurredAt: row.occurred_at.toISOString(),
      workDate: workDateInTimeZone(row.occurred_at, options.timeZone),
      result: row.result_content
    }];
  });
}

async function loadPeriodEvidenceSnapshot(options: {
  pool: QueryExecutor;
  accountId: string;
  period: SummaryPeriod;
  timeZone: string;
}): Promise<PeriodEvidenceSnapshot> {
  const from = utcRangeForWorkDate(
    options.period.periodStart,
    options.timeZone
  ).from;
  const until = utcRangeForWorkDate(
    options.period.periodEnd,
    options.timeZone
  ).until;
  const [metadataRows] = await options.pool.execute<EvidenceMetadataRow[]>(
    `SELECT pe.collected_event_id AS id, pe.project_id,
            COALESCE(p.name, '未分类项目') AS project_name,
            pe.device_id, pe.content_hash,
            (SELECT vr.content_hash
               FROM visible_results vr
              WHERE vr.account_id = pe.account_id
                AND vr.prompt_entry_id = pe.id
              ORDER BY vr.occurred_at DESC
              LIMIT 1) AS result_hash,
            pe.occurred_at
       FROM prompt_entries pe
       LEFT JOIN projects p
         ON p.id = pe.project_id AND p.account_id = pe.account_id
      WHERE pe.account_id = ? AND pe.occurred_at >= ? AND pe.occurred_at < ?
      ORDER BY pe.occurred_at ASC
      LIMIT ?`,
    [options.accountId, from, until, MAX_PERIOD_EVIDENCE_METADATA + 1]
  );
  const [aggregateRows] = await options.pool.execute<EvidenceAggregateRow[]>(
    `SELECT COUNT(DISTINCT pe.id) AS prompt_count,
            COUNT(DISTINCT pe.project_id) AS project_count,
            MAX(pe.updated_at) AS latest_prompt_update,
            MAX(vr.created_at) AS latest_result_update
       FROM prompt_entries pe
       LEFT JOIN visible_results vr
         ON vr.prompt_entry_id = pe.id AND vr.account_id = pe.account_id
      WHERE pe.account_id = ? AND pe.occurred_at >= ? AND pe.occurred_at < ?`,
    [options.accountId, from, until]
  );
  const [arrivalRows] = await options.pool.execute<DeviceArrivalRow[]>(
    `SELECT DISTINCT device_id FROM collected_events
      WHERE account_id = ? AND occurred_at >= ? AND occurred_at < ?
      ORDER BY device_id`,
    [options.accountId, from, until]
  );
  const expectedDeviceIds = await expectedDeviceIdsForDate({
    pool: options.pool,
    accountId: options.accountId,
    timeZone: options.timeZone,
    workDate: options.period.periodEnd
  });
  const aggregate = aggregateRows[0];
  const promptCount = asCount(aggregate?.prompt_count);
  const projectCount = asCount(aggregate?.project_count);
  const metadataTruncated = metadataRows.length > MAX_PERIOD_EVIDENCE_METADATA ||
    promptCount > MAX_PERIOD_EVIDENCE_METADATA;
  const metadata = metadataRows.slice(0, MAX_PERIOD_EVIDENCE_METADATA);
  const evidence = await selectedEvidenceDetails({
    pool: options.pool,
    accountId: options.accountId,
    metadata,
    timeZone: options.timeZone
  });
  return {
    evidence,
    evidenceFingerprint: snapshotFingerprint({
      rows: metadata,
      promptCount,
      projectCount,
      latestPromptUpdate: aggregate?.latest_prompt_update ?? null,
      latestResultUpdate: aggregate?.latest_result_update ?? null,
      metadataTruncated
    }),
    expectedDeviceIds,
    arrivedDeviceIds: arrivalRows.map((row) => row.device_id),
    promptCount,
    projectCount,
    activeDayCount: new Set(
      metadata.map((row) => workDateInTimeZone(row.occurred_at, options.timeZone))
    ).size,
    metadataTruncated
  };
}

export interface RefreshPeriodInsightResult {
  period: SummaryPeriod;
  generated: boolean;
  summaryId: string | null;
  promptCount: number;
}

async function persistPeriodSummary(options: {
  pool: Pool;
  accountId: string;
  period: SummaryPeriod;
  timeZone: string;
  canonicalGeneratorFingerprint: string;
  canonicalInputFingerprint: string;
  inputFingerprint: string;
  snapshot: PeriodEvidenceSnapshot;
  summary: GeneratedLlmPeriodSummary;
  provider: string;
  model: string;
}): Promise<{ generated: boolean; summaryId: string }> {
  const connection = await options.pool.getConnection();
  const lockName = periodSummaryLockName(
    options.accountId,
    options.period.periodType,
    options.period.periodStart
  );
  let acquired = false;
  let reusable = true;
  try {
    const [lockRows] = await connection.execute<LockRow[]>(
      "SELECT GET_LOCK(?, 10) AS acquired",
      [lockName]
    );
    acquired = Number(lockRows[0]?.acquired) === 1;
    if (!acquired) {
      throw new PeriodSummaryServiceError(
        "PERIOD_SUMMARY_IN_PROGRESS",
        409,
        "该周期的总结正在生成，请稍后重试"
      );
    }
    const currentSnapshot = await loadPeriodEvidenceSnapshot({
      pool: connection,
      accountId: options.accountId,
      period: options.period,
      timeZone: options.timeZone
    });
    const currentCanonicalFingerprint = periodSummaryFingerprint({
      ...options.period,
      evidenceFingerprint: currentSnapshot.evidenceFingerprint,
      expectedDeviceIds: currentSnapshot.expectedDeviceIds,
      arrivedDeviceIds: currentSnapshot.arrivedDeviceIds,
      generatorFingerprint: options.canonicalGeneratorFingerprint
    });
    if (currentCanonicalFingerprint !== options.canonicalInputFingerprint) {
      throw new PeriodSummaryServiceError(
        "PERIOD_SUMMARY_SOURCE_CHANGED",
        409,
        "生成期间同步数据发生变化，请重新生成"
      );
    }
    const [latestRows] = await connection.execute<LatestPeriodSummaryRow[]>(
      `SELECT id, revision, input_fingerprint, content
         FROM period_summaries
        WHERE account_id = ? AND period_type = ? AND period_start = ?
        ORDER BY revision DESC
        LIMIT 1`,
      [options.accountId, options.period.periodType, options.period.periodStart]
    );
    const revision = Number(latestRows[0]?.revision ?? 0) + 1;
    const summaryId = databaseId(
      "period-summary",
      options.accountId,
      options.period.periodType,
      options.period.periodStart,
      options.inputFingerprint
    );
    await connection.beginTransaction();
    try {
      const [insert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO period_summaries
           (id, account_id, period_type, period_start, period_end, time_zone,
            revision, status, input_fingerprint, content, coverage,
            model_provider, model_name, template_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'llm-period-summary-v1')
         ON DUPLICATE KEY UPDATE id = id`,
        [
          summaryId,
          options.accountId,
          options.period.periodType,
          options.period.periodStart,
          options.period.periodEnd,
          options.timeZone,
          revision,
          options.summary.dataCompleteness === "complete" ? "COMPLETE" : "PARTIAL",
          options.inputFingerprint,
          JSON.stringify({
            ...options.summary,
            canonicalInputFingerprint: options.canonicalInputFingerprint
          }),
          JSON.stringify({
            expectedDeviceIds: options.snapshot.expectedDeviceIds,
            arrivedDeviceIds: options.snapshot.arrivedDeviceIds,
            sourceEvidenceCount: options.snapshot.promptCount,
            selectedEvidenceCount: options.snapshot.evidence.length,
            metadataTruncated: options.snapshot.metadataTruncated
          }),
          options.provider,
          options.model
        ]
      );
      const [identifierRows] = await connection.execute<IdentifierRow[]>(
        `SELECT id FROM period_summaries
          WHERE account_id = ? AND period_type = ? AND period_start = ?
            AND input_fingerprint = ?
          LIMIT 1`,
        [
          options.accountId,
          options.period.periodType,
          options.period.periodStart,
          options.inputFingerprint
        ]
      );
      const persistedSummaryId = identifierRows[0]?.id;
      if (!persistedSummaryId) throw new Error("PERIOD_SUMMARY_NOT_FOUND");

      if (insert.affectedRows === 1) {
        const evidenceById = new Map(
          options.snapshot.evidence.map((item) => [item.id, item])
        );
        const associations = periodSummaryEvidenceStatements(options.summary)
          .flatMap((statement) => statement.evidenceIds.map((evidenceId) => ({
            statementKey: statement.key,
            evidenceId,
            item: evidenceById.get(evidenceId)
          })))
          .filter((association) => association.item !== undefined);
        for (
          let offset = 0;
          offset < associations.length;
          offset += EVIDENCE_INSERT_CHUNK_SIZE
        ) {
          const chunk = associations.slice(
            offset,
            offset + EVIDENCE_INSERT_CHUNK_SIZE
          );
          const placeholders = chunk
            .map(() => "(?, ?, ?, ?, ?, 'FACT', ?)")
            .join(", ");
          const values = chunk.flatMap((association) => {
            const item = association.item!;
            const evidenceText = item.result
              ? `Prompt: ${item.content}\n回答: ${item.result}`
              : `Prompt: ${item.content}`;
            return [
              databaseId(
                "period-evidence",
                persistedSummaryId,
                association.statementKey,
                association.evidenceId
              ),
              options.accountId,
              persistedSummaryId,
              association.evidenceId,
              association.statementKey,
              excerpt(evidenceText, 480)
            ];
          });
          await connection.execute(
            `INSERT INTO period_summary_evidence
               (id, account_id, summary_id, collected_event_id, claim_key,
                claim_type, excerpt)
             VALUES ${placeholders}`,
            values
          );
        }
        await connection.execute(
          `INSERT INTO audit_logs
             (account_id, action, resource_type, resource_id, outcome, metadata)
           VALUES (?, 'PERIOD_SUMMARY_GENERATED', 'PERIOD_SUMMARY', ?, 'SUCCEEDED', ?)`,
          [
            options.accountId,
            persistedSummaryId,
            JSON.stringify({
              periodType: options.period.periodType,
              periodStart: options.period.periodStart,
              periodEnd: options.period.periodEnd,
              revision,
              sourceEvidenceCount: options.snapshot.promptCount,
              status: options.summary.dataCompleteness,
              provider: options.provider,
              model: options.model
            })
          ]
        );
      }
      await connection.commit();
      return {
        generated: insert.affectedRows === 1,
        summaryId: persistedSummaryId
      };
    } catch (error) {
      await connection.rollback().catch(() => connection.destroy());
      throw error;
    }
  } finally {
    if (acquired) {
      try {
        const [releaseRows] = await connection.execute<ReleaseLockRow[]>(
          "SELECT RELEASE_LOCK(?) AS released",
          [lockName]
        );
        reusable = Number(releaseRows[0]?.released) === 1;
      } catch {
        reusable = false;
      }
    }
    if (reusable) connection.release();
    else connection.destroy();
  }
}

async function refreshPeriodInsightsOnce(options: {
  pool: Pool;
  accountId: string;
  periodType: SummaryPeriodType;
  periodStart: string;
  masterKey?: Buffer;
  fetcher?: LlmFetcher;
  resolver?: LlmResolver;
  regenerationKey?: string;
}): Promise<RefreshPeriodInsightResult> {
  const period = summaryPeriod(options.periodType, options.periodStart);
  const timeZone = await accountTimeZone(options.pool, options.accountId);
  const snapshot = await loadPeriodEvidenceSnapshot({
    pool: options.pool,
    accountId: options.accountId,
    period,
    timeZone
  });
  if (snapshot.promptCount === 0 || snapshot.evidence.length === 0) {
    return {
      period,
      generated: false,
      summaryId: null,
      promptCount: snapshot.promptCount
    };
  }

  const llmView = await getLlmSettingsView({
    pool: options.pool,
    accountId: options.accountId
  });
  const canonicalGeneratorFingerprint = [
    "llm-period-summary-v1",
    llmView.provider,
    llmView.baseUrl,
    llmView.model
  ].join(":");
  const canonicalInputFingerprint = periodSummaryFingerprint({
    ...period,
    evidenceFingerprint: snapshot.evidenceFingerprint,
    expectedDeviceIds: snapshot.expectedDeviceIds,
    arrivedDeviceIds: snapshot.arrivedDeviceIds,
    generatorFingerprint: canonicalGeneratorFingerprint
  });
  const generatorFingerprint = options.regenerationKey
    ? `${canonicalGeneratorFingerprint}:manual:${options.regenerationKey}`
    : canonicalGeneratorFingerprint;
  const inputFingerprint = periodSummaryFingerprint({
    ...period,
    evidenceFingerprint: snapshot.evidenceFingerprint,
    expectedDeviceIds: snapshot.expectedDeviceIds,
    arrivedDeviceIds: snapshot.arrivedDeviceIds,
    generatorFingerprint
  });
  const [latestRows] = await options.pool.execute<LatestPeriodSummaryRow[]>(
    `SELECT id, revision, input_fingerprint, content
       FROM period_summaries
      WHERE account_id = ? AND period_type = ? AND period_start = ?
      ORDER BY revision DESC
      LIMIT 1`,
    [options.accountId, period.periodType, period.periodStart]
  );
  const latest = latestRows[0];
  if (latest && latestSummaryMatchesInput({
    latestInputFingerprint: latest.input_fingerprint,
    latestContent: latest.content,
    requestedInputFingerprint: inputFingerprint,
    canonicalInputFingerprint,
    isManualRegeneration: Boolean(options.regenerationKey)
  })) {
    return {
      period,
      generated: false,
      summaryId: latest.id,
      promptCount: snapshot.promptCount
    };
  }

  const llmSettings = await getRuntimeLlmSettings({
    pool: options.pool,
    accountId: options.accountId,
    masterKey: options.masterKey ?? parseLlmEncryptionKey()
  });
  const summary = await generateLlmPeriodSummary({
    settings: llmSettings,
    ...period,
    timeZone,
    expectedDeviceIds: snapshot.expectedDeviceIds,
    arrivedDeviceIds: snapshot.arrivedDeviceIds,
    evidence: snapshot.evidence,
    sourceEvidenceCount: snapshot.promptCount,
    fetcher: options.fetcher,
    resolver: options.resolver
  });
  if (!summary.hasContent) {
    return {
      period,
      generated: false,
      summaryId: null,
      promptCount: snapshot.promptCount
    };
  }
  const persisted = await persistPeriodSummary({
    pool: options.pool,
    accountId: options.accountId,
    period,
    timeZone,
    canonicalGeneratorFingerprint,
    canonicalInputFingerprint,
    inputFingerprint,
    snapshot,
    summary,
    provider: llmSettings.provider,
    model: llmSettings.model
  });
  return {
    period,
    generated: persisted.generated,
    summaryId: persisted.summaryId,
    promptCount: snapshot.promptCount
  };
}

const inFlightPeriodSummaries = new Map<
  string,
  Promise<RefreshPeriodInsightResult>
>();

export function refreshPeriodInsights(options: {
  pool: Pool;
  accountId: string;
  periodType: SummaryPeriodType;
  periodStart: string;
  masterKey?: Buffer;
  fetcher?: LlmFetcher;
  resolver?: LlmResolver;
  regenerationKey?: string;
}): Promise<RefreshPeriodInsightResult> {
  const key = [options.accountId, options.periodType, options.periodStart]
    .join("\u001f");
  const existing = inFlightPeriodSummaries.get(key);
  if (existing) return existing;
  const pending = refreshPeriodInsightsOnce(options);
  inFlightPeriodSummaries.set(key, pending);
  void pending.finally(() => {
    if (inFlightPeriodSummaries.get(key) === pending) {
      inFlightPeriodSummaries.delete(key);
    }
  }).catch(() => undefined);
  return pending;
}
