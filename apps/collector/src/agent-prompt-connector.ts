import type {
  AgentEventRecord,
  AgentSyncRecord,
  AgentTextSegmentRecord,
  SyncEvent
} from "@ai-worklog/contracts";
import { buildEventId, sha256Hex } from "@ai-worklog/core";
import type { AgentCapture, AgentConnector } from "./agent-connector.js";
import type { NormalizedPromptSession, PromptConnector } from "./prompt-connector.js";

function promptText(
  records: readonly AgentSyncRecord[],
  eventId: string
): string | undefined {
  const segments = records
    .filter((record): record is AgentTextSegmentRecord =>
      record.recordType === "TEXT_SEGMENT" &&
      record.eventId === eventId &&
      record.purpose === "RENDERED_CONTENT"
    )
    .sort((left, right) => left.ordinal - right.ordinal);
  if (segments.length === 0) return undefined;
  const text = segments.map((segment) => segment.text).join("");
  return text.length > 0 ? text : undefined;
}

function sourceMessageId(event: AgentEventRecord): string {
  if (event.sourceEventId.length <= 255) return event.sourceEventId;
  return `sha256:${sha256Hex(event.sourceEventId)}`;
}

export class AgentPromptConnector implements PromptConnector {
  readonly sourceType: AgentCapture["sourceType"];
  readonly sourceInstanceId: string;
  readonly parserVersion: string;
  private readonly connector: AgentConnector;

  constructor(options: { connector: AgentConnector }) {
    this.connector = options.connector;
    this.sourceType = options.connector.sourceType;
    this.sourceInstanceId = options.connector.sourceInstanceId;
    this.parserVersion = `${options.connector.parserVersion}-prompt-v1`;
  }

  async readFile(filePath: string): Promise<NormalizedPromptSession> {
    const captures = await this.connector.readSource(filePath);
    const events: SyncEvent[] = [];

    for (const capture of captures) {
      let messageIndex = 0;
      for (const record of capture.records) {
        if (record.recordType !== "EVENT" || record.kind !== "USER") continue;
        const content = promptText(capture.records, record.eventId);
        if (!content) continue;
        const sourceMessage = sourceMessageId(record);
        events.push({
          eventId: buildEventId({
            accountId: capture.accountId,
            deviceId: capture.deviceId,
            sourceType: capture.sourceType,
            sourceInstanceId: capture.sourceInstanceId,
            sourceSessionId: capture.sourceSessionId,
            sourceMessageId: sourceMessage,
            messageIndex
          }),
          kind: "USER_PROMPT",
          sourceSessionId: capture.sourceSessionId,
          sourceMessageId: sourceMessage,
          messageIndex,
          occurredAt: record.occurredAt,
          sourceTimeZone: record.sourceTimeZone,
          sanitizedContent: content,
          contentHash: sha256Hex(content),
          redactionVersion: "RAW_V1",
          metadata: {}
        });
        messageIndex += 1;
      }
    }

    events.sort((left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.eventId.localeCompare(right.eventId)
    );
    return {
      sessionId: captures.length === 1
        ? captures[0]?.sourceSessionId ?? `source:${sha256Hex(filePath)}`
        : `source:${sha256Hex(filePath)}`,
      events
    };
  }
}
