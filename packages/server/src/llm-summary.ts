import { z } from "zod";
import type { SummaryPeriodType } from "@ai-worklog/contracts";
import {
  MAX_LLM_REQUEST_BYTES,
  llmJsonRequestByteLength,
  requestLlmJson,
  type LlmFetcher,
  type LlmMessage,
  type LlmResolver
} from "./llm-client";
import type { RuntimeLlmSettings } from "./llm-settings-service";
import {
  buildSummarySystemPrompt,
  type SummaryPromptScope
} from "./summary-prompts";

const MAX_LLM_EVIDENCE = 80;
const MAX_PROJECT_BYTES = 480;
const MAX_EVIDENCE_TEXT_BYTES = 4_096;
const MAX_TIMESTAMP_BYTES = 128;

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstDefined(
  record: Record<string, unknown>,
  keys: readonly string[]
): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function normalizeEvidenceIds(value: unknown): unknown {
  if (typeof value === "string") {
    const references = value.match(/\bE\d{3,}\b/gu);
    return references ?? [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item !== "string") return [item];
      const references = item.match(/\bE\d{3,}\b/gu);
      return references ?? [item];
    });
  }
  return value;
}

const EvidenceIdsSchema = z.preprocess(
  normalizeEvidenceIds,
  z.array(z.string().trim().min(1).max(64))
    .min(1)
    .transform((ids) => [...new Set(ids)].slice(0, 8))
);

const StatementSchema = z.preprocess((value) => {
  const record = recordValue(value);
  return {
    ...record,
    text: firstDefined(record, ["text", "summary", "description", "title"]),
    evidenceIds: firstDefined(record, [
      "evidenceIds",
      "evidence_refs",
      "evidenceRefs",
      "evidenceRef",
      "references",
      "refs"
    ])
  };
}, z
  .object({
    text: z.string().trim().min(1).max(1_200),
    evidenceIds: EvidenceIdsSchema
  })
  .strip());

function statementArray(max: number) {
  return z.preprocess((value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return [value];
    return [];
  }, z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const parsed = StatementSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }).slice(0, max)
  ));
}

function noteText(defaultValue: string) {
  return z.preprocess((value) => {
    if (typeof value === "string") return value;
    const record = recordValue(value);
    return firstDefined(record, [
      "text",
      "summary",
      "description",
      "note",
      "message"
    ]) ?? defaultValue;
  }, z.string().trim().min(1).max(1_200).default(defaultValue));
}

const LlmPeriodSummaryDraftSchema = z.preprocess((value) => {
  const record = recordValue(value);
  return {
    ...record,
    majorAccomplishments: firstDefined(record, [
      "majorAccomplishments",
      "majorAchievements",
      "accomplishments",
      "highlights"
    ]),
    nextFocus: firstDefined(record, [
      "nextFocus",
      "nextActions",
      "nextSteps",
      "futureFocus"
    ]),
    completenessNote: firstDefined(record, [
      "completenessNote",
      "coverageNote",
      "note"
    ])
  };
}, z
  .object({
    overview: statementArray(4),
    majorAccomplishments: statementArray(8),
    projectProgress: statementArray(12),
    decisions: statementArray(8),
    blockers: statementArray(8),
    nextFocus: statementArray(8),
    completenessNote: noteText("由模型基于周期内的 Prompt 与回答生成。")
  })
  .strip());

const LlmSummaryDraftSchema = z.preprocess((value) => {
  const record = recordValue(value);
  return {
    ...record,
    highlights: firstDefined(record, ["highlights", "overview"]),
    nextActions: firstDefined(record, [
      "nextActions",
      "nextFocus",
      "nextSteps"
    ]),
    completenessNote: firstDefined(record, [
      "completenessNote",
      "coverageNote",
      "note"
    ])
  };
}, z
  .object({
    highlights: statementArray(8),
    projectProgress: statementArray(16),
    decisions: statementArray(8),
    blockers: statementArray(8),
    nextActions: statementArray(8),
    completenessNote: noteText("由模型基于当日证据生成。")
  })
  .strip());

export interface SummaryEvidence {
  id: string;
  projectId: string;
  projectName: string;
  deviceId: string;
  content: string;
  contentHash: string;
  occurredAt: string;
  workDate?: string;
  result?: string | null;
  intent?: string | null;
}

export interface GeneratedLlmPeriodSummary {
  periodType: SummaryPeriodType;
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  dataCompleteness: "complete" | "partial";
  hasContent: boolean;
  inputTruncated: boolean;
  overview: Array<{ text: string; evidenceIds: string[] }>;
  majorAccomplishments: Array<{ text: string; evidenceIds: string[] }>;
  projectProgress: Array<{ text: string; evidenceIds: string[] }>;
  decisions: Array<{ text: string; evidenceIds: string[] }>;
  blockers: Array<{ text: string; evidenceIds: string[] }>;
  nextFocus: Array<{ text: string; evidenceIds: string[] }>;
  missingDeviceIds: string[];
  completenessNote: string;
}

export interface GeneratedLlmSummary {
  workDate: string;
  timeZone: string;
  status: "complete" | "partial";
  inputTruncated: boolean;
  highlights: Array<{ text: string; evidenceIds: string[] }>;
  projectProgress: Array<{ text: string; evidenceIds: string[] }>;
  decisions: Array<{ text: string; evidenceIds: string[] }>;
  blockers: Array<{ text: string; evidenceIds: string[] }>;
  nextActions: Array<{ text: string; evidenceIds: string[] }>;
  missingDeviceIds: string[];
  completenessNote: string;
}

export class LlmSummaryError extends Error {
  readonly code: string;
  readonly status = 502;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LlmSummaryError";
    this.code = code;
  }
}

function coverage(options: {
  expectedDeviceIds: readonly string[];
  arrivedDeviceIds: readonly string[];
}) {
  const arrived = new Set(options.arrivedDeviceIds);
  const missingDeviceIds = options.expectedDeviceIds.filter(
    (deviceId) => !arrived.has(deviceId)
  );
  return {
    status: missingDeviceIds.length === 0 ? "complete" as const : "partial" as const,
    missingDeviceIds,
    note:
      missingDeviceIds.length === 0
        ? "已收到全部活跃设备的数据。"
        : `数据可能不完整：尚未收到 ${missingDeviceIds.length} 台设备的数据。`
  };
}

function mapStatements(
  statements: Array<{ text: string; evidenceIds: string[] }>,
  evidenceByReference: ReadonlyMap<string, string>
): Array<{ text: string; evidenceIds: string[] }> {
  return statements.map((statement) => {
    const evidenceIds = statement.evidenceIds.map((reference) =>
      evidenceByReference.get(reference)
    );
    if (evidenceIds.some((id) => id === undefined)) {
      throw new LlmSummaryError(
        "LLM_SUMMARY_INVALID_EVIDENCE",
        "LLM 总结包含无效的证据引用"
      );
    }
    return {
      text: statement.text,
      evidenceIds: [...new Set(evidenceIds as string[])]
    };
  });
}

function mapEvidenceReferences(
  draft: z.infer<typeof LlmSummaryDraftSchema>,
  evidenceByReference: ReadonlyMap<string, string>
): z.infer<typeof LlmSummaryDraftSchema> {
  return {
    ...draft,
    highlights: mapStatements(draft.highlights, evidenceByReference),
    projectProgress: mapStatements(draft.projectProgress, evidenceByReference),
    decisions: mapStatements(draft.decisions, evidenceByReference),
    blockers: mapStatements(draft.blockers, evidenceByReference),
    nextActions: mapStatements(draft.nextActions, evidenceByReference)
  };
}

function mapPeriodEvidenceReferences(
  draft: z.infer<typeof LlmPeriodSummaryDraftSchema>,
  evidenceByReference: ReadonlyMap<string, string>
): z.infer<typeof LlmPeriodSummaryDraftSchema> {
  return {
    ...draft,
    overview: mapStatements(draft.overview, evidenceByReference),
    majorAccomplishments: mapStatements(
      draft.majorAccomplishments,
      evidenceByReference
    ),
    projectProgress: mapStatements(draft.projectProgress, evidenceByReference),
    decisions: mapStatements(draft.decisions, evidenceByReference),
    blockers: mapStatements(draft.blockers, evidenceByReference),
    nextFocus: mapStatements(draft.nextFocus, evidenceByReference)
  };
}

interface BoundedText {
  text: string;
  truncated: boolean;
}

interface ModelEvidence {
  evidenceRef: string;
  project: string;
  occurredAt: string;
  prompt: string;
  result: string | null;
}

interface ModelSummaryInput {
  workDate: string;
  timeZone: string;
  coverage: {
    expectedDeviceCount: number;
    arrivedDeviceCount: number;
    missingDeviceCount: number;
  };
  evidence: ModelEvidence[];
}

interface ModelPeriodSummaryInput {
  periodType: SummaryPeriodType;
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  coverage: {
    expectedDeviceCount: number;
    arrivedDeviceCount: number;
    missingDeviceCount: number;
  };
  evidence: ModelEvidence[];
}

function utf8Excerpt(value: string, maxBytes: number): BoundedText {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return { text: normalized, truncated: false };
  }
  const characters = Array.from(normalized);
  const suffix = "…";
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${suffix}`;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return {
    text: `${characters.slice(0, low).join("")}${suffix}`,
    truncated: true
  };
}

function summaryMessages(
  input: ModelSummaryInput,
  instructions: string
): readonly LlmMessage[] {
  return [
    {
      role: "system",
      content: buildSummarySystemPrompt("DAILY", instructions)
    },
    {
      role: "user",
      content: `Summarize this bounded evidence payload:\n${JSON.stringify(input)}`
    }
  ];
}

function periodSummaryMessages(
  input: ModelPeriodSummaryInput,
  scope: Exclude<SummaryPromptScope, "DAILY">,
  instructions: string
): readonly LlmMessage[] {
  return [
    {
      role: "system",
      content: buildSummarySystemPrompt(scope, instructions)
    },
    {
      role: "user",
      content: `Summarize this bounded evidence payload:\n${JSON.stringify(input)}`
    }
  ];
}

function modelEvidence(
  item: SummaryEvidence,
  reference: string,
  textByteLimit: number,
  includeResult = true
): { value: ModelEvidence; truncated: boolean } {
  const project = utf8Excerpt(item.projectName, MAX_PROJECT_BYTES);
  const occurredAt = utf8Excerpt(item.occurredAt, MAX_TIMESTAMP_BYTES);
  const prompt = utf8Excerpt(item.content, textByteLimit);
  const result = item.result && includeResult
    ? utf8Excerpt(item.result, textByteLimit)
    : null;
  return {
    value: {
      evidenceRef: reference,
      project: project.text,
      occurredAt: occurredAt.text,
      prompt: prompt.text,
      result: result?.text ?? null
    },
    truncated:
      project.truncated ||
      occurredAt.truncated ||
      prompt.truncated ||
      Boolean(item.result && (!includeResult || result?.truncated))
  };
}

function requestFits<TBase extends object>(
  settings: RuntimeLlmSettings,
  input: TBase,
  evidence: readonly ModelEvidence[],
  messages: (value: TBase & { evidence: ModelEvidence[] }) => readonly LlmMessage[]
): boolean {
  return llmJsonRequestByteLength(
    settings,
    messages({ ...input, evidence: [...evidence] })
  ) <= MAX_LLM_REQUEST_BYTES;
}

function packEvidence<TBase extends object>(options: {
  settings: RuntimeLlmSettings;
  input: TBase;
  evidence: readonly SummaryEvidence[];
  messages: (value: TBase & { evidence: ModelEvidence[] }) => readonly LlmMessage[];
}): {
  input: TBase & { evidence: ModelEvidence[] };
  referencedEvidence: Array<{
    reference: string;
    item: SummaryEvidence;
  }>;
  truncated: boolean;
} {
  const candidates = options.evidence.slice(0, MAX_LLM_EVIDENCE);
  const packed: ModelEvidence[] = [];
  const referencedEvidence: Array<{
    reference: string;
    item: SummaryEvidence;
  }> = [];
  let truncated = options.evidence.length > candidates.length;

  for (const item of candidates) {
    const reference = `E${String(packed.length + 1).padStart(3, "0")}`;
    const bounded = modelEvidence(
      item,
      reference,
      MAX_EVIDENCE_TEXT_BYTES
    );
    if (requestFits(
      options.settings,
      options.input,
      [...packed, bounded.value],
      options.messages
    )) {
      packed.push(bounded.value);
      referencedEvidence.push({ reference, item });
      truncated ||= bounded.truncated;
      continue;
    }

    truncated = true;
    let low = 64;
    let high = MAX_EVIDENCE_TEXT_BYTES - 1;
    let best: ReturnType<typeof modelEvidence> | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = modelEvidence(item, reference, middle);
      if (requestFits(
        options.settings,
        options.input,
        [...packed, candidate.value],
        options.messages
      )) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (!best) {
      const minimal = modelEvidence(item, reference, 64, false);
      if (requestFits(
        options.settings,
        options.input,
        [...packed, minimal.value],
        options.messages
      )) {
        best = minimal;
      }
    }
    if (best) {
      packed.push(best.value);
      referencedEvidence.push({ reference, item });
    }
    break;
  }

  if (packed.length === 0) {
    const item = candidates[0]!;
    const reference = "E001";
    const minimal = modelEvidence(item, reference, 64, false);
    if (!requestFits(
      options.settings,
      options.input,
      [minimal.value],
      options.messages
    )) {
      throw new LlmSummaryError(
        "LLM_SUMMARY_INPUT_TOO_LARGE",
        "LLM 总结上下文无法装入安全请求上限"
      );
    }
    packed.push(minimal.value);
    referencedEvidence.push({ reference, item });
    truncated = true;
  }

  if (packed.length < options.evidence.length) truncated = true;
  return {
    input: { ...options.input, evidence: packed },
    referencedEvidence,
    truncated
  };
}

export async function generateLlmDailySummary(options: {
  settings: RuntimeLlmSettings;
  workDate: string;
  timeZone: string;
  expectedDeviceIds: readonly string[];
  arrivedDeviceIds: readonly string[];
  evidence: readonly SummaryEvidence[];
  fetcher?: LlmFetcher;
  resolver?: LlmResolver;
}): Promise<GeneratedLlmSummary> {
  const deviceCoverage = coverage(options);
  if (options.evidence.length === 0) {
    return {
      workDate: options.workDate,
      timeZone: options.timeZone,
      status: "partial",
      inputTruncated: false,
      highlights: [],
      projectProgress: [],
      decisions: [],
      blockers: [],
      nextActions: [],
      missingDeviceIds: deviceCoverage.missingDeviceIds,
      completenessNote: `${deviceCoverage.note} 当日没有可用于总结的工作证据。`
    };
  }

  const boundedWorkDate = utf8Excerpt(options.workDate, 64).text;
  const boundedTimeZone = utf8Excerpt(options.timeZone, 128).text;
  const messages = (input: ModelSummaryInput) =>
    summaryMessages(input, options.settings.summaryPrompts.daily);
  const packed = packEvidence({
    settings: options.settings,
    input: {
      workDate: boundedWorkDate,
      timeZone: boundedTimeZone,
      coverage: {
        expectedDeviceCount: options.expectedDeviceIds.length,
        arrivedDeviceCount: options.arrivedDeviceIds.length,
        missingDeviceCount: deviceCoverage.missingDeviceIds.length
      }
    },
    evidence: options.evidence,
    messages
  });
  const referencedEvidence = packed.referencedEvidence;
  const evidenceByReference = new Map(
    referencedEvidence.map(({ reference, item }) => [reference, item.id])
  );
  const { data: draft } = await requestLlmJson({
    settings: options.settings,
    fetcher: options.fetcher,
    resolver: options.resolver,
    schema: LlmSummaryDraftSchema,
    messages: messages(packed.input)
  });
  const validatedDraft = mapEvidenceReferences(draft, evidenceByReference);
  const truncatedNote = packed.truncated
    ? ` 为满足模型请求大小限制，本次证据内容或数量已截断，使用 ${referencedEvidence.length}/${options.evidence.length} 条。`
    : "";
  return {
    workDate: options.workDate,
    timeZone: options.timeZone,
    status: deviceCoverage.status === "complete" && !packed.truncated
      ? "complete"
      : "partial",
    inputTruncated: packed.truncated,
    highlights: validatedDraft.highlights,
    projectProgress: validatedDraft.projectProgress,
    decisions: validatedDraft.decisions,
    blockers: validatedDraft.blockers,
    nextActions: validatedDraft.nextActions,
    missingDeviceIds: deviceCoverage.missingDeviceIds,
    completenessNote: `${deviceCoverage.note}${truncatedNote}`
  };
}

export function selectBalancedPeriodEvidence(
  evidence: readonly SummaryEvidence[],
  limit = MAX_LLM_EVIDENCE
): SummaryEvidence[] {
  if (!Number.isInteger(limit) || limit <= 0 || evidence.length === 0) return [];

  const buckets = new Map<string, SummaryEvidence[]>();
  for (const item of evidence) {
    const workDate = item.workDate ?? item.occurredAt.slice(0, 10);
    const key = `${workDate}\u001f${item.projectId}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }
  const orderedBuckets = [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, items]) => items.sort((left, right) => {
      const resultDifference = Number(Boolean(right.result?.trim())) -
        Number(Boolean(left.result?.trim()));
      if (resultDifference !== 0) return resultDifference;
      const timeDifference = right.occurredAt.localeCompare(left.occurredAt);
      return timeDifference !== 0 ? timeDifference : left.id.localeCompare(right.id);
    }));

  const selected: SummaryEvidence[] = [];
  while (selected.length < limit) {
    let added = false;
    for (const bucket of orderedBuckets) {
      const item = bucket.shift();
      if (!item) continue;
      selected.push(item);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected.sort((left, right) => {
    const timeDifference = left.occurredAt.localeCompare(right.occurredAt);
    return timeDifference !== 0 ? timeDifference : left.id.localeCompare(right.id);
  });
}

export async function generateLlmPeriodSummary(options: {
  settings: RuntimeLlmSettings;
  periodType: SummaryPeriodType;
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  expectedDeviceIds: readonly string[];
  arrivedDeviceIds: readonly string[];
  evidence: readonly SummaryEvidence[];
  sourceEvidenceCount?: number;
  fetcher?: LlmFetcher;
  resolver?: LlmResolver;
}): Promise<GeneratedLlmPeriodSummary> {
  const deviceCoverage = coverage(options);
  if (options.evidence.length === 0) {
    return {
      periodType: options.periodType,
      periodStart: options.periodStart,
      periodEnd: options.periodEnd,
      timeZone: options.timeZone,
      dataCompleteness: "partial",
      hasContent: false,
      inputTruncated: false,
      overview: [],
      majorAccomplishments: [],
      projectProgress: [],
      decisions: [],
      blockers: [],
      nextFocus: [],
      missingDeviceIds: deviceCoverage.missingDeviceIds,
      completenessNote: `${deviceCoverage.note} 该周期没有可用于总结的 Prompt 与回答。`
    };
  }

  const selectedEvidence = selectBalancedPeriodEvidence(
    options.evidence,
    MAX_LLM_EVIDENCE
  );
  const sourceEvidenceCount = Math.max(
    options.evidence.length,
    options.sourceEvidenceCount ?? options.evidence.length
  );
  const selectionTruncated = selectedEvidence.length < sourceEvidenceCount;
  const promptScope = options.periodType;
  const promptInstructions = promptScope === "WEEK"
    ? options.settings.summaryPrompts.weekly
    : options.settings.summaryPrompts.monthly;
  const messages = (input: ModelPeriodSummaryInput) =>
    periodSummaryMessages(input, promptScope, promptInstructions);
  const packed = packEvidence({
    settings: options.settings,
    input: {
      periodType: options.periodType,
      periodStart: utf8Excerpt(options.periodStart, 64).text,
      periodEnd: utf8Excerpt(options.periodEnd, 64).text,
      timeZone: utf8Excerpt(options.timeZone, 128).text,
      coverage: {
        expectedDeviceCount: options.expectedDeviceIds.length,
        arrivedDeviceCount: options.arrivedDeviceIds.length,
        missingDeviceCount: deviceCoverage.missingDeviceIds.length
      }
    },
    evidence: selectedEvidence,
    messages
  });
  const evidenceByReference = new Map(
    packed.referencedEvidence.map(({ reference, item }) => [reference, item.id])
  );
  const { data: draft } = await requestLlmJson({
    settings: options.settings,
    fetcher: options.fetcher,
    resolver: options.resolver,
    schema: LlmPeriodSummaryDraftSchema,
    messages: messages(packed.input)
  });
  const validatedDraft = mapPeriodEvidenceReferences(
    draft,
    evidenceByReference
  );
  const hasContent = [
    validatedDraft.overview,
    validatedDraft.majorAccomplishments,
    validatedDraft.projectProgress,
    validatedDraft.decisions,
    validatedDraft.blockers,
    validatedDraft.nextFocus
  ].some((section) => section.length > 0);
  const inputTruncated = selectionTruncated || packed.truncated;
  const truncatedNote = inputTruncated
    ? ` 为满足模型请求大小限制，本次按日期和项目均衡选取并可能截断证据，使用 ${packed.referencedEvidence.length}/${sourceEvidenceCount} 条。`
    : "";

  return {
    periodType: options.periodType,
    periodStart: options.periodStart,
    periodEnd: options.periodEnd,
    timeZone: options.timeZone,
    dataCompleteness:
      deviceCoverage.status === "complete" && !inputTruncated
        ? "complete"
        : "partial",
    hasContent,
    inputTruncated,
    overview: validatedDraft.overview,
    majorAccomplishments: validatedDraft.majorAccomplishments,
    projectProgress: validatedDraft.projectProgress,
    decisions: validatedDraft.decisions,
    blockers: validatedDraft.blockers,
    nextFocus: validatedDraft.nextFocus,
    missingDeviceIds: deviceCoverage.missingDeviceIds,
    completenessNote: `${deviceCoverage.note}${truncatedNote}`
  };
}
