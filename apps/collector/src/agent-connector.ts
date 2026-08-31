import {
  AgentSyncRecordSchema,
  type AgentEventKind,
  type AgentEventRecord,
  type AgentSourceType,
  type AgentSyncRecord,
  type AttachmentStatus,
  type NormalizedCoverage,
  type RawCaptureStatus,
  type SyncEvent
} from "@ai-worklog/contracts";
import {
  buildAgentEventId,
  buildAgentRunId,
  buildAgentTextSegmentId,
  sha256Hex
} from "@ai-worklog/core";

export const TEXT_SEGMENT_TARGET_BYTES = 256 * 1024;

export interface AgentConnectorIdentity {
  accountId: string;
  deviceId: string;
  sourceType: AgentSourceType;
  sourceInstanceId: string;
  parserVersion: string;
}

export interface AgentAttachmentRequest {
  runId: string;
  eventId?: string | null;
  purpose: "RAW_EVENT" | "SOURCE_TRANSCRIPT" | "ATTACHMENT";
  requestedPath: string;
  filename?: string | null;
  mediaType?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AgentCapture extends AgentConnectorIdentity {
  sourceSessionId: string;
  records: AgentSyncRecord[];
  attachmentRequests: AgentAttachmentRequest[];
}

export interface AgentConnector {
  readonly sourceType: AgentSourceType;
  readonly sourceInstanceId: string;
  readonly parserVersion: string;
  readSource(path: string): Promise<AgentCapture[]>;
  readSourceEach?(
    path: string,
    onCapture: (capture: AgentCapture) => Promise<void>
  ): Promise<void>;
  readPromptSourceEach?(
    path: string,
    onSession: (session: { sessionId: string; events: SyncEvent[] }) => Promise<void>
  ): Promise<void>;
}

interface BuilderOptions extends AgentConnectorIdentity {
  sourceSessionId: string;
  startedAt: string;
  endedAt?: string | null;
  sourceTimeZone: string;
  title?: string | null;
  cwd?: string | null;
  parentRunId?: string | null;
  projectHint?: {
    gitRemoteKey?: string;
    repoRootName?: string;
    localPathHmac?: string;
  };
  rawCaptureStatus?: RawCaptureStatus;
  normalizedCoverage?: NormalizedCoverage;
  attachmentStatus?: AttachmentStatus;
  missingReason?: string;
  metadata?: Record<string, unknown>;
}

interface AddEventOptions {
  sourceEventId: string;
  sequence: number;
  kind: AgentEventKind;
  occurredAt: string;
  sourceTimeZone?: string;
  turnIndex?: number | null;
  stepIndex?: number | null;
  replyToEventId?: string | null;
  mirrorOfEventId?: string | null;
  renderedText?: string;
  renderedFormat?: "TEXT" | "MARKDOWN" | "JSON";
  rawPayload?: string;
  toolArguments?: string;
  toolResult?: string;
  searchText?: string;
  rawCaptureStatus?: RawCaptureStatus;
  normalizedCoverage?: NormalizedCoverage;
  attachmentStatus?: AttachmentStatus;
  missingReason?: string;
  metadata?: Record<string, unknown>;
}

interface TextInput {
  text: string;
  purpose: "RENDERED_CONTENT" | "RAW_PAYLOAD" | "TOOL_ARGUMENTS" |
    "TOOL_RESULT" | "SEARCH_TEXT";
  format: "TEXT" | "MARKDOWN" | "JSON";
  isSearchable: boolean;
}

function utf8Width(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function splitUtf8Text(text: string, maxBytes: number): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw new Error("Text chunk size must be an integer of at least four bytes");
  }
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  let chunkStart = 0;
  let index = 0;
  let bytes = 0;
  for (const character of text) {
    const width = utf8Width(character.codePointAt(0) ?? 0);
    if (bytes > 0 && bytes + width > maxBytes) {
      chunks.push(text.slice(chunkStart, index));
      chunkStart = index;
      bytes = 0;
    }
    bytes += width;
    index += character.length;
  }
  chunks.push(text.slice(chunkStart));
  return chunks;
}

function safeSourceEventId(
  value: string,
  sequence: number
): { id: string; original?: string } {
  const candidate = value.trim() || `index:${sequence}`;
  if (candidate.length <= 1_024) return { id: candidate };
  return {
    id: `sha256:${sha256Hex(candidate)}`,
    original: candidate
  };
}

export class AgentCaptureBuilder {
  readonly runId: string;
  private readonly options: BuilderOptions;
  private readonly eventRecords: AgentSyncRecord[] = [];
  private readonly textRecords: AgentSyncRecord[] = [];
  private readonly attachments: AgentAttachmentRequest[] = [];
  private readonly eventIds = new Set<string>();

  constructor(options: BuilderOptions) {
    this.options = options;
    this.runId = buildAgentRunId({
      accountId: options.accountId,
      deviceId: options.deviceId,
      sourceType: options.sourceType,
      sourceInstanceId: options.sourceInstanceId,
      sourceSessionId: options.sourceSessionId
    });
  }

  addEvent(options: AddEventOptions): AgentEventRecord {
    const sourceIdentity = safeSourceEventId(
      options.sourceEventId,
      options.sequence
    );
    const eventId = buildAgentEventId({
      accountId: this.options.accountId,
      deviceId: this.options.deviceId,
      sourceType: this.options.sourceType,
      sourceInstanceId: this.options.sourceInstanceId,
      sourceSessionId: this.options.sourceSessionId,
      sourceEventId: sourceIdentity.id,
      sequence: options.sequence
    });
    if (this.eventIds.has(eventId)) {
      throw new Error("Duplicate source event identity in one Agent run");
    }
    this.eventIds.add(eventId);

    const texts: TextInput[] = [];
    if (options.renderedText !== undefined) {
      texts.push({
        text: options.renderedText,
        purpose: "RENDERED_CONTENT",
        format: options.renderedFormat ?? "TEXT",
        isSearchable: true
      });
    }
    if (options.toolArguments !== undefined) {
      texts.push({
        text: options.toolArguments,
        purpose: "TOOL_ARGUMENTS",
        format: "JSON",
        isSearchable: true
      });
    }
    if (options.toolResult !== undefined) {
      texts.push({
        text: options.toolResult,
        purpose: "TOOL_RESULT",
        format: "TEXT",
        isSearchable: true
      });
    }
    if (options.searchText !== undefined) {
      texts.push({
        text: options.searchText,
        purpose: "SEARCH_TEXT",
        format: "TEXT",
        isSearchable: true
      });
    }
    if (options.rawPayload !== undefined) {
      texts.push({
        text: options.rawPayload,
        purpose: "RAW_PAYLOAD",
        format: "JSON",
        isSearchable: false
      });
    }

    const primaryText = options.renderedText ?? options.toolArguments ??
      options.toolResult ?? options.searchText;
    const rawCaptureStatus = options.rawCaptureStatus ?? "CAPTURED";
    const metadata = {
      ...(options.metadata ?? {}),
      ...(sourceIdentity.original
        ? { originalSourceEventId: sourceIdentity.original }
        : {})
    };
    const event = AgentSyncRecordSchema.parse({
      recordType: "EVENT",
      eventId,
      runId: this.runId,
      sourceEventId: sourceIdentity.id,
      sequence: options.sequence,
      turnIndex: options.turnIndex ?? null,
      stepIndex: options.stepIndex ?? null,
      kind: options.kind,
      occurredAt: options.occurredAt,
      sourceTimeZone: options.sourceTimeZone ?? this.options.sourceTimeZone,
      replyToEventId: options.replyToEventId ?? null,
      mirrorOfEventId: options.mirrorOfEventId ?? null,
      contentSha256: primaryText === undefined ? null : sha256Hex(primaryText),
      rawPayloadSha256: options.rawPayload === undefined
        ? null
        : sha256Hex(options.rawPayload),
      rawCaptureStatus,
      normalizedCoverage: options.normalizedCoverage ??
        (primaryText === undefined ? "NONE" : "FULL"),
      attachmentStatus: options.attachmentStatus ?? "NOT_APPLICABLE",
      ...(rawCaptureStatus !== "CAPTURED" || options.missingReason
        ? { missingReason: options.missingReason ?? "Source content is incomplete" }
        : {}),
      metadata
    });
    if (event.recordType !== "EVENT") {
      throw new Error("Agent event validation returned the wrong record type");
    }
    this.eventRecords.push(event);

    for (const text of texts) this.addText(eventId, text);
    return event;
  }

  addAttachment(request: Omit<AgentAttachmentRequest, "runId">): void {
    this.attachments.push({ ...request, runId: this.runId });
  }

  finish(): AgentCapture {
    const run = AgentSyncRecordSchema.parse({
      recordType: "RUN",
      runId: this.runId,
      sourceSessionId: this.options.sourceSessionId,
      startedAt: this.options.startedAt,
      endedAt: this.options.endedAt ?? null,
      sourceTimeZone: this.options.sourceTimeZone,
      title: this.options.title ?? null,
      cwd: this.options.cwd ?? null,
      parentRunId: this.options.parentRunId ?? null,
      ...(this.options.projectHint
        ? { projectHint: this.options.projectHint }
        : {}),
      rawCaptureStatus: this.options.rawCaptureStatus ?? "CAPTURED",
      normalizedCoverage: this.options.normalizedCoverage ?? "FULL",
      attachmentStatus: this.options.attachmentStatus ??
        (this.attachments.length > 0 ? "PENDING" : "NOT_APPLICABLE"),
      ...(this.options.missingReason
        ? { missingReason: this.options.missingReason }
        : {}),
      metadata: this.options.metadata ?? {}
    });
    return {
      accountId: this.options.accountId,
      deviceId: this.options.deviceId,
      sourceType: this.options.sourceType,
      sourceInstanceId: this.options.sourceInstanceId,
      parserVersion: this.options.parserVersion,
      sourceSessionId: this.options.sourceSessionId,
      records: [run, ...this.eventRecords, ...this.textRecords],
      attachmentRequests: [...this.attachments]
    };
  }

  private addText(eventId: string, input: TextInput): void {
    const chunks = splitUtf8Text(input.text, TEXT_SEGMENT_TARGET_BYTES);
    const groupSha256 = sha256Hex(input.text);
    const groupByteLength = Buffer.byteLength(input.text, "utf8");
    chunks.forEach((text, ordinal) => {
      const contentSha256 = sha256Hex(text);
      this.textRecords.push(AgentSyncRecordSchema.parse({
        recordType: "TEXT_SEGMENT",
        segmentId: buildAgentTextSegmentId({
          eventId,
          ordinal,
          purpose: input.purpose,
          contentSha256,
          groupSha256
        }),
        eventId,
        ordinal,
        format: chunks.length === 1 ? input.format : "TEXT",
        purpose: input.purpose,
        text,
        contentSha256,
        byteLength: Buffer.byteLength(text, "utf8"),
        groupSha256,
        groupByteLength,
        groupSegmentCount: chunks.length,
        isSearchable: input.isSearchable
      }));
    });
  }
}
