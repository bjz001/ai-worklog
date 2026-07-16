import type {
  CalendarDayView,
  CalendarResponse,
  DashboardResponse,
  DeviceView,
  PeriodSummaryActivityView,
  PeriodSummaryView,
  PrivacyResponse,
  ProjectView,
  ProjectsResponse,
  PromptView,
  PromptsResponse,
  SkillCandidateView,
  SkillsResponse,
  SummaryView,
  SummaryPeriodType,
  SyncResponse,
  SyncRunView
} from "@ai-worklog/contracts";
import { excerpt } from "@ai-worklog/core";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { PromptQuery } from "./query-input";
import {
  isoDateTime,
  utcRangeForWorkDate,
  workDateInTimeZone
} from "./presentation";
import { summaryPeriod } from "./periods";

interface TimeZoneRow extends RowDataPacket {
  time_zone: string;
}

interface DeviceRow extends RowDataPacket {
  id: string;
  name: string;
  platform: "MACOS" | "WINDOWS" | "LINUX";
  status: "ACTIVE" | "OFFLINE" | "REVOKED";
  last_seen_at: Date | null;
  last_synced_at: Date | null;
  prompt_count: number | string;
  active_token_count: number | string;
  active_token_last_used_at: Date | null;
}

interface ProjectRow extends RowDataPacket {
  id: string;
  name: string;
  normalized_git_remote: string | null;
  classification_source: string;
  confidence_basis_points: number;
  prompt_count: number | string;
  device_count: number | string;
  last_activity_at: Date | null;
  recent_prompt: string | null;
}

interface PromptRow extends RowDataPacket {
  id: string;
  content: string;
  result_content: string | null;
  project_id: string | null;
  project_name: string | null;
  device_id: string;
  device_name: string;
  source_type: "CODEX" | "CLAUDE_CODE";
  occurred_at: Date;
  is_favorite: number | boolean;
}

interface CountRow extends RowDataPacket {
  total: number | string;
}

interface SummaryRow extends RowDataPacket {
  id: string;
  work_date: string | Date;
  status: string;
  content: unknown;
}

interface PeriodSummaryRow extends RowDataPacket {
  id: string;
  period_type: SummaryPeriodType;
  period_start: string | Date;
  period_end: string | Date;
  status: string;
  content: unknown;
}

interface PeriodActivityRow extends RowDataPacket {
  occurred_at: Date;
  project_id: string | null;
}

interface EvidenceRow extends RowDataPacket {
  id: string;
  excerpt: string | null;
  project_name: string | null;
  occurred_at: Date;
}

interface SkillRow extends RowDataPacket {
  id: string;
  name: string;
  description: string;
  status: string;
  evidence_count: number | string;
  proposal: unknown;
}

interface SyncRunRow extends RowDataPacket {
  id: string;
  device_id: string;
  status: string;
  received_count: number | string;
  inserted_count: number | string;
  duplicate_count: number | string;
  received_at: Date;
  committed_at: Date | null;
}

function asNumber(value: number | string | null | undefined): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function statementList(value: unknown): Array<{
  text: string;
  evidenceIds: string[];
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.text !== "string" || !Array.isArray(record.evidenceIds)) {
      return [];
    }
    return [
      {
        text: record.text,
        evidenceIds: record.evidenceIds.filter(
          (id): id is string => typeof id === "string"
        )
      }
    ];
  });
}

export async function accountTimeZone(
  pool: Pool | PoolConnection,
  accountId: string
): Promise<string> {
  const [rows] = await pool.execute<TimeZoneRow[]>(
    "SELECT time_zone FROM accounts WHERE id = ? LIMIT 1",
    [accountId]
  );
  if (!rows[0]) throw new Error("ACCOUNT_NOT_FOUND");
  return rows[0].time_zone;
}

function deviceStatus(row: DeviceRow, now = Date.now()): DeviceView["status"] {
  if (row.status === "REVOKED") return "OFFLINE";
  if (row.status === "OFFLINE") return "OFFLINE";
  if (asNumber(row.active_token_count) === 0) return "NOT_CONFIGURED";
  if (!row.active_token_last_used_at) return "WAITING";
  if (!row.last_synced_at) return "WAITING";
  if (now - row.last_synced_at.getTime() > 48 * 60 * 60 * 1000) {
    return "OFFLINE";
  }
  return "SUCCESS";
}

export async function listDevices(
  pool: Pool,
  accountId: string
): Promise<DeviceView[]> {
  const [rows] = await pool.execute<DeviceRow[]>(
    `SELECT d.id, d.name, d.platform, d.status, d.last_seen_at, d.last_synced_at,
            COUNT(pe.id) AS prompt_count,
            COALESCE(credentials.active_token_count, 0) AS active_token_count,
            credentials.active_token_last_used_at
       FROM devices d
       LEFT JOIN prompt_entries pe
         ON pe.device_id = d.id AND pe.account_id = d.account_id
       LEFT JOIN (
         SELECT account_id, device_id, COUNT(*) AS active_token_count,
                MAX(last_used_at) AS active_token_last_used_at
           FROM device_tokens
          WHERE revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(6))
          GROUP BY account_id, device_id
       ) credentials
         ON credentials.device_id = d.id AND credentials.account_id = d.account_id
      WHERE d.account_id = ?
      GROUP BY d.id, d.name, d.platform, d.status, d.last_seen_at, d.last_synced_at,
               credentials.active_token_count, credentials.active_token_last_used_at
      ORDER BY d.name ASC`,
    [accountId]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    os:
      row.platform === "MACOS"
        ? "MACOS"
        : row.platform === "WINDOWS"
          ? "WINDOWS"
          : "OTHER",
    status: deviceStatus(row),
    lastSeenAt: isoDateTime(row.last_seen_at),
    lastSyncAt: isoDateTime(row.last_synced_at),
    promptCount: asNumber(row.prompt_count)
  }));
}

function assignmentReason(row: ProjectRow): string {
  const confidence = Math.round(asNumber(row.confidence_basis_points) / 100);
  const labels: Record<string, string> = {
    MANUAL: "人工指定",
    MAPPING_RULE: "映射规则",
    GIT_REMOTE: "Git Remote",
    GIT_ROOT: "Git 根目录",
    WORKING_DIRECTORY: "工作目录指纹",
    SOURCE_HINT: "数据源提示",
    UNCLASSIFIED: "待归类"
  };
  return `${labels[row.classification_source] ?? "待归类"} · 置信度 ${confidence}%`;
}

export async function listProjects(
  pool: Pool,
  accountId: string
): Promise<ProjectView[]> {
  const [rows] = await pool.execute<ProjectRow[]>(
    `SELECT p.id, p.name, p.canonical_key, p.normalized_git_remote, p.classification_source,
            p.confidence_basis_points, COUNT(pe.id) AS prompt_count,
            COUNT(DISTINCT pe.device_id) AS device_count,
            MAX(pe.occurred_at) AS last_activity_at,
            (SELECT pe2.sanitized_content
               FROM prompt_entries pe2
              WHERE pe2.account_id = p.account_id AND pe2.project_id = p.id
              ORDER BY pe2.occurred_at DESC
              LIMIT 1) AS recent_prompt
       FROM projects p
       LEFT JOIN prompt_entries pe
         ON pe.project_id = p.id AND pe.account_id = p.account_id
      WHERE p.account_id = ? AND p.archived_at IS NULL
      GROUP BY p.id, p.name, p.canonical_key, p.normalized_git_remote, p.classification_source,
               p.confidence_basis_points
      ORDER BY last_activity_at DESC, p.name ASC`,
    [accountId]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    canonicalKey: row.canonical_key,
    assignmentReason: assignmentReason(row),
    promptCount: asNumber(row.prompt_count),
    deviceCount: asNumber(row.device_count),
    lastActivityAt: isoDateTime(row.last_activity_at),
    recentPrompt: row.recent_prompt ? excerpt(row.recent_prompt, 180) : null
  }));
}

function escapedLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

export async function listPrompts(options: {
  pool: Pool;
  accountId: string;
  query: PromptQuery;
}): Promise<PromptsResponse> {
  if (
    !Number.isInteger(options.query.page) ||
    options.query.page < 1 ||
    options.query.page > 10_000 ||
    !Number.isInteger(options.query.pageSize) ||
    options.query.pageSize < 1 ||
    options.query.pageSize > 100
  ) {
    throw new Error("Invalid prompt query");
  }
  const timeZone = await accountTimeZone(options.pool, options.accountId);
  const clauses = ["pe.account_id = ?"];
  const values: Array<string | number | Date> = [options.accountId];
  if (options.query.source) {
    clauses.push("s.source_type = ?");
    values.push(options.query.source);
  }
  if (options.query.q) {
    clauses.push(
      `(pe.sanitized_content LIKE ? ESCAPE '\\\\'
        OR COALESCE(p.name, '') LIKE ? ESCAPE '\\\\')`
    );
    const pattern = escapedLike(options.query.q);
    values.push(pattern, pattern);
  }

  if (options.query.projectId) {
    clauses.push("pe.project_id = ?");
    values.push(options.query.projectId);
  }

  if (options.query.date) {
    const range = utcRangeForWorkDate(options.query.date, timeZone);
    clauses.push("pe.occurred_at >= ? AND pe.occurred_at < ?");
    values.push(range.from, range.until);
  }

  const commonFrom = `FROM prompt_entries pe
       JOIN sessions s ON s.id = pe.session_id AND s.account_id = pe.account_id
       LEFT JOIN projects p ON p.id = pe.project_id AND p.account_id = pe.account_id
      WHERE ${clauses.join(" AND ")}`;

  const [countRows] = await options.pool.execute<CountRow[]>(
    `SELECT COUNT(*) AS total ${commonFrom}`,
    values
  );
  const totalItems = asNumber(countRows[0]?.total);
  const offset = (options.query.page - 1) * options.query.pageSize;

  const [rows] = await options.pool.execute<PromptRow[]>(
    `SELECT pe.id, pe.sanitized_content AS content,
            (SELECT vr.sanitized_content
               FROM visible_results vr
              WHERE vr.prompt_entry_id = pe.id AND vr.account_id = pe.account_id
              ORDER BY vr.occurred_at DESC, vr.id DESC
              LIMIT 1) AS result_content,
            pe.project_id, p.name AS project_name,
            pe.device_id, d.name AS device_name, s.source_type,
            pe.occurred_at, pe.is_favorite
       FROM prompt_entries pe
       JOIN devices d ON d.id = pe.device_id AND d.account_id = pe.account_id
       JOIN sessions s ON s.id = pe.session_id AND s.account_id = pe.account_id
       LEFT JOIN projects p ON p.id = pe.project_id AND p.account_id = pe.account_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY pe.occurred_at DESC, pe.id DESC
      LIMIT ${options.query.pageSize} OFFSET ${offset}`,
    values
  );
  const mapped: PromptView[] = rows.map((row) => {
    const occurredAt = isoDateTime(row.occurred_at) ?? new Date(0).toISOString();
    return {
      id: row.id,
      content: row.content,
      resultExcerpt: row.result_content ? excerpt(row.result_content, 240) : null,
      projectId: row.project_id,
      projectName: row.project_name ?? "未分类项目",
      deviceId: row.device_id,
      deviceName: row.device_name,
      sourceType: row.source_type,
      occurredAt,
      workDate: workDateInTimeZone(occurredAt, timeZone),
      tags: [],
      isFavorite: Boolean(row.is_favorite)
    };
  });

  return {
    data: mapped,
    pagination: {
      page: options.query.page,
      pageSize: options.query.pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / options.query.pageSize)
    }
  };
}

function mysqlWorkDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export async function getCalendar(options: {
  pool: Pool;
  accountId: string;
  month: string;
}): Promise<CalendarResponse> {
  const timeZone = await accountTimeZone(options.pool, options.accountId);
  const first = new Date(`${options.month}-01T00:00:00.000Z`);
  const from = new Date(first.getTime() - 2 * 24 * 60 * 60 * 1000);
  const until = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 3));
  const [promptRows] = await options.pool.execute<
    Array<RowDataPacket & { occurred_at: Date; project_id: string | null }>
  >(
    `SELECT occurred_at, project_id FROM prompt_entries
      WHERE account_id = ? AND occurred_at >= ? AND occurred_at < ?`,
    [options.accountId, from, until]
  );
  const [summaryRows] = await options.pool.execute<
    Array<RowDataPacket & { work_date: string | Date; status: string }>
  >(
    `SELECT work_date, status FROM daily_summaries ds
      WHERE account_id = ? AND work_date LIKE ?
        AND revision = (
          SELECT MAX(ds2.revision) FROM daily_summaries ds2
           WHERE ds2.account_id = ds.account_id AND ds2.work_date = ds.work_date
        )`,
    [options.accountId, `${options.month}-%`]
  );
  const [errorRows] = await options.pool.execute<
    Array<RowDataPacket & { activity_at: Date }>
  >(
    `SELECT received_at AS activity_at FROM sync_batches
      WHERE account_id = ? AND status = 'FAILED'
        AND received_at >= ? AND received_at < ?`,
    [options.accountId, from, until]
  );

  const days = new Map<
    string,
    { promptCount: number; projects: Set<string>; hasSyncError: boolean }
  >();
  for (const row of promptRows) {
    const date = workDateInTimeZone(row.occurred_at, timeZone);
    if (!date.startsWith(`${options.month}-`)) continue;
    const day = days.get(date) ?? {
      promptCount: 0,
      projects: new Set<string>(),
      hasSyncError: false
    };
    day.promptCount += 1;
    if (row.project_id) day.projects.add(row.project_id);
    days.set(date, day);
  }
  for (const row of errorRows) {
    const date = workDateInTimeZone(row.activity_at, timeZone);
    if (!date.startsWith(`${options.month}-`)) continue;
    const day = days.get(date) ?? {
      promptCount: 0,
      projects: new Set<string>(),
      hasSyncError: false
    };
    day.hasSyncError = true;
    days.set(date, day);
  }
  const summaryByDate = new Map(
    summaryRows.map((row) => [mysqlWorkDate(row.work_date), row.status])
  );
  const allDates = new Set([...days.keys(), ...summaryByDate.keys()]);
  const data: CalendarDayView[] = [...allDates]
    .sort()
    .map((date) => {
      const day = days.get(date);
      const summaryStatus = summaryByDate.get(date);
      return {
        date,
        promptCount: day?.promptCount ?? 0,
        projectCount: day?.projects.size ?? 0,
        summaryStatus:
          summaryStatus === "COMPLETE"
            ? "complete"
            : summaryStatus
              ? "partial"
              : "missing",
        hasSyncError: day?.hasSyncError ?? false
      };
    });
  return { data, month: options.month };
}

export async function listSkills(
  pool: Pool,
  accountId: string
): Promise<SkillCandidateView[]> {
  const [rows] = await pool.execute<SkillRow[]>(
    `SELECT id, name, description, status, evidence_count, proposal
       FROM skill_candidates
      WHERE account_id = ?
      ORDER BY updated_at DESC`,
    [accountId]
  );
  return rows.map((row) => {
    const proposal = recordValue(row.proposal);
    const evidenceIds = Array.isArray(proposal.evidenceIds)
      ? proposal.evidenceIds.filter((id): id is string => typeof id === "string")
      : [];
    const rawDiff = Array.isArray(proposal.diff)
      ? proposal.diff
      : Array.isArray(proposal.suggestedSteps)
        ? proposal.suggestedSteps.map((text) => ({ type: "add", text }))
        : [];
    const diff = rawDiff.flatMap((line) => {
      if (!line || typeof line !== "object") return [];
      const item = line as Record<string, unknown>;
      if (
        !["add", "remove", "context"].includes(String(item.type)) ||
        typeof item.text !== "string"
      ) {
        return [];
      }
      return [
        {
          type: item.type as "add" | "remove" | "context",
          text: item.text
        }
      ];
    });
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status:
        row.status === "ACCEPTED"
          ? "accepted"
          : row.status === "IGNORED"
            ? "ignored"
            : "candidate",
      evidenceIds,
      evidenceCount: asNumber(row.evidence_count),
      diff
    };
  });
}

export async function getSummaryForDate(options: {
  pool: Pool;
  accountId: string;
  workDate: string;
}): Promise<SummaryView | null> {
  const [rows] = await options.pool.execute<SummaryRow[]>(
    `SELECT id, work_date, status, content
       FROM daily_summaries
      WHERE account_id = ? AND work_date = ?
      ORDER BY revision DESC
      LIMIT 1`,
    [options.accountId, options.workDate]
  );
  const row = rows[0];
  if (!row) return null;
  const content = recordValue(row.content);
  const summarySections = {
    highlights: statementList(content.highlights),
    projectProgress: statementList(content.projectProgress),
    decisions: statementList(content.decisions),
    blockers: statementList(content.blockers),
    nextActions: statementList(content.nextActions)
  };
  const [evidenceRows] = await options.pool.execute<EvidenceRow[]>(
    `SELECT ce.id, se.excerpt, COALESCE(p.name, '未分类项目') AS project_name,
            ce.occurred_at
       FROM summary_evidence se
       JOIN collected_events ce
         ON ce.id = se.collected_event_id AND ce.account_id = se.account_id
       LEFT JOIN projects p
         ON p.id = ce.project_id AND p.account_id = ce.account_id
      WHERE se.account_id = ? AND se.summary_id = ?
      GROUP BY ce.id, se.excerpt, p.name, ce.occurred_at
      ORDER BY ce.occurred_at ASC`,
    [options.accountId, row.id]
  );
  const evidenceById = new Map(
    evidenceRows.map((evidence) => [evidence.id, evidence])
  );
  const referencedEvidenceIds = [
    ...new Set(
      Object.values(summarySections)
        .flatMap((statements) => statements)
        .flatMap((statement) => statement.evidenceIds)
        .filter((id) => id.length > 0 && id.length <= 64)
    )
  ].slice(0, 256);
  const missingEvidenceIds = referencedEvidenceIds.filter(
    (id) => !evidenceById.has(id)
  );
  if (missingEvidenceIds.length > 0) {
    const placeholders = missingEvidenceIds.map(() => "?").join(", ");
    const [fallbackRows] = await options.pool.execute<EvidenceRow[]>(
      `SELECT ce.id,
              LEFT(COALESCE(pe.sanitized_content, ev.sanitized_content,
                            '已脱敏证据'), 240) AS excerpt,
              COALESCE(p.name, '未分类项目') AS project_name,
              ce.occurred_at
         FROM collected_events ce
         LEFT JOIN prompt_entries pe
           ON pe.collected_event_id = ce.id AND pe.account_id = ce.account_id
         LEFT JOIN event_versions ev
           ON ev.collected_event_id = ce.id AND ev.account_id = ce.account_id
          AND ev.version = ce.current_version
         LEFT JOIN projects p
           ON p.id = ce.project_id AND p.account_id = ce.account_id
        WHERE ce.account_id = ? AND ce.id IN (${placeholders})
        ORDER BY ce.occurred_at ASC`,
      [options.accountId, ...missingEvidenceIds]
    );
    for (const evidence of fallbackRows) {
      if (!evidenceById.has(evidence.id)) evidenceById.set(evidence.id, evidence);
    }
  }
  const allEvidenceRows = [...evidenceById.values()].sort(
    (left, right) => left.occurred_at.getTime() - right.occurred_at.getTime()
  );
  return {
    id: row.id,
    workDate: mysqlWorkDate(row.work_date),
    status: row.status === "COMPLETE" ? "complete" : "partial",
    ...summarySections,
    completenessNote:
      typeof content.completenessNote === "string"
        ? content.completenessNote
        : "总结完整性信息缺失。",
    evidence: allEvidenceRows.map((evidence) => ({
      id: evidence.id,
      excerpt: evidence.excerpt ?? "已脱敏证据",
      projectName: evidence.project_name ?? "未分类项目",
      occurredAt: isoDateTime(evidence.occurred_at) ?? new Date(0).toISOString()
    }))
  };
}

export async function getPeriodActivity(options: {
  pool: Pool;
  accountId: string;
  periodType: SummaryPeriodType;
  periodStart: string;
}): Promise<PeriodSummaryActivityView> {
  const period = summaryPeriod(options.periodType, options.periodStart);
  const timeZone = await accountTimeZone(options.pool, options.accountId);
  const from = utcRangeForWorkDate(period.periodStart, timeZone).from;
  const until = utcRangeForWorkDate(period.periodEnd, timeZone).until;
  const [rows] = await options.pool.execute<PeriodActivityRow[]>(
    `SELECT occurred_at, project_id FROM prompt_entries
      WHERE account_id = ? AND occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at ASC`,
    [options.accountId, from, until]
  );
  return {
    ...period,
    promptCount: rows.length,
    projectCount: new Set(
      rows.flatMap((row) => row.project_id ? [row.project_id] : [])
    ).size,
    activeDayCount: new Set(
      rows.map((row) => workDateInTimeZone(row.occurred_at, timeZone))
    ).size
  };
}

export async function getPeriodSummary(options: {
  pool: Pool;
  accountId: string;
  periodType: SummaryPeriodType;
  periodStart: string;
}): Promise<PeriodSummaryView | null> {
  const period = summaryPeriod(options.periodType, options.periodStart);
  const [rows] = await options.pool.execute<PeriodSummaryRow[]>(
    `SELECT id, period_type, period_start, period_end, status, content
       FROM period_summaries
      WHERE account_id = ? AND period_type = ? AND period_start = ?
      ORDER BY revision DESC
      LIMIT 1`,
    [options.accountId, period.periodType, period.periodStart]
  );
  const row = rows[0];
  if (!row) return null;
  const content = recordValue(row.content);
  const sections = {
    overview: statementList(content.overview),
    majorAccomplishments: statementList(content.majorAccomplishments),
    projectProgress: statementList(content.projectProgress),
    decisions: statementList(content.decisions),
    blockers: statementList(content.blockers),
    nextFocus: statementList(content.nextFocus)
  };
  const [evidenceRows] = await options.pool.execute<EvidenceRow[]>(
    `SELECT ce.id, pse.excerpt,
            COALESCE(p.name, '未分类项目') AS project_name, ce.occurred_at
       FROM period_summary_evidence pse
       JOIN collected_events ce
         ON ce.id = pse.collected_event_id AND ce.account_id = pse.account_id
       LEFT JOIN projects p
         ON p.id = ce.project_id AND p.account_id = ce.account_id
      WHERE pse.account_id = ? AND pse.summary_id = ?
      GROUP BY ce.id, pse.excerpt, p.name, ce.occurred_at
      ORDER BY ce.occurred_at ASC`,
    [options.accountId, row.id]
  );
  const evidenceById = new Map(
    evidenceRows.map((evidence) => [evidence.id, evidence])
  );
  const referencedEvidenceIds = [
    ...new Set(
      Object.values(sections)
        .flatMap((statements) => statements)
        .flatMap((statement) => statement.evidenceIds)
        .filter((id) => id.length > 0 && id.length <= 64)
    )
  ].slice(0, 256);
  const missingEvidenceIds = referencedEvidenceIds.filter(
    (id) => !evidenceById.has(id)
  );
  if (missingEvidenceIds.length > 0) {
    const placeholders = missingEvidenceIds.map(() => "?").join(", ");
    const [fallbackRows] = await options.pool.execute<EvidenceRow[]>(
      `SELECT ce.id,
              LEFT(COALESCE(pe.sanitized_content, ev.sanitized_content,
                            '已脱敏证据'), 240) AS excerpt,
              COALESCE(p.name, '未分类项目') AS project_name,
              ce.occurred_at
         FROM collected_events ce
         LEFT JOIN prompt_entries pe
           ON pe.collected_event_id = ce.id AND pe.account_id = ce.account_id
         LEFT JOIN event_versions ev
           ON ev.collected_event_id = ce.id AND ev.account_id = ce.account_id
          AND ev.version = ce.current_version
         LEFT JOIN projects p
           ON p.id = ce.project_id AND p.account_id = ce.account_id
        WHERE ce.account_id = ? AND ce.id IN (${placeholders})
        ORDER BY ce.occurred_at ASC`,
      [options.accountId, ...missingEvidenceIds]
    );
    for (const evidence of fallbackRows) {
      if (!evidenceById.has(evidence.id)) evidenceById.set(evidence.id, evidence);
    }
  }
  const hasContent = Object.values(sections).some(
    (statements) => statements.length > 0
  );
  return {
    id: row.id,
    periodType: row.period_type,
    periodStart: mysqlWorkDate(row.period_start),
    periodEnd: mysqlWorkDate(row.period_end),
    dataCompleteness:
      row.status === "COMPLETE" && hasContent ? "complete" : "partial",
    hasContent,
    inputTruncated: content.inputTruncated === true,
    ...sections,
    completenessNote:
      typeof content.completenessNote === "string"
        ? content.completenessNote
        : "总结完整性信息缺失。",
    evidence: [...evidenceById.values()]
      .sort((left, right) => left.occurred_at.getTime() - right.occurred_at.getTime())
      .map((evidence) => ({
        id: evidence.id,
        excerpt: evidence.excerpt ?? "已脱敏证据",
        projectName: evidence.project_name ?? "未分类项目",
        occurredAt: isoDateTime(evidence.occurred_at) ?? new Date(0).toISOString()
      }))
  };
}

export async function getDashboard(options: {
  pool: Pool;
  accountId: string;
  fixtureMode?: boolean;
  now?: Date;
}): Promise<DashboardResponse> {
  const timeZone = await accountTimeZone(options.pool, options.accountId);
  const workDate = workDateInTimeZone(options.now ?? new Date(), timeZone);
  const [devices, projects, summary, skills] = await Promise.all([
    listDevices(options.pool, options.accountId),
    listProjects(options.pool, options.accountId),
    getSummaryForDate({ pool: options.pool, accountId: options.accountId, workDate }),
    listSkills(options.pool, options.accountId)
  ]);
  return {
    data: {
      fixtureMode: options.fixtureMode ?? false,
      summary,
      devices,
      projects,
      pendingSkillCount: skills.filter((skill) => skill.status === "candidate")
        .length
    }
  };
}

export async function getProjectsResponse(
  pool: Pool,
  accountId: string
): Promise<ProjectsResponse> {
  return { data: await listProjects(pool, accountId) };
}

export async function getSkillsResponse(
  pool: Pool,
  accountId: string
): Promise<SkillsResponse> {
  return { data: await listSkills(pool, accountId) };
}

export async function getSyncResponse(
  pool: Pool,
  accountId: string
): Promise<SyncResponse> {
  const [devices, rows] = await Promise.all([
    listDevices(pool, accountId),
    pool.execute<SyncRunRow[]>(
      `SELECT id, device_id, status, received_count, inserted_count,
              duplicate_count, received_at, committed_at
         FROM sync_batches
        WHERE account_id = ?
        ORDER BY received_at DESC
        LIMIT 50`,
      [accountId]
    )
  ]);
  const runs: SyncRunView[] = rows[0].map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    status:
      row.status === "COMMITTED" || row.status === "COMMITTED_WITH_WARNINGS"
        ? "SUCCESS"
        : "FAILED",
    receivedCount: asNumber(row.received_count),
    insertedCount: asNumber(row.inserted_count),
    duplicateCount: asNumber(row.duplicate_count),
    startedAt: isoDateTime(row.received_at) ?? new Date(0).toISOString(),
    completedAt: isoDateTime(row.committed_at),
    errorCode: row.status === "FAILED" ? "SYNC_BATCH_FAILED" : null
  }));
  return { data: { devices, runs } };
}

export function getPrivacyResponse(): PrivacyResponse {
  return {
    data: {
      retentionDays: null,
      redactionVersion: "core-v1",
      rawContentStored: false,
      exportReady: false,
      pendingDeletionCount: 0
    }
  };
}
