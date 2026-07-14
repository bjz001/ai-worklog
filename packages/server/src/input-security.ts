import type { SyncEvent } from "@ai-worklog/contracts";
import { redactSensitiveText, sha256Hex } from "@ai-worklog/core";

export class UnsafeEventContentError extends Error {
  readonly code = "UNSAFE_EVENT_CONTENT";
  readonly status = 422;

  constructor(
    reason:
      | "digest mismatch"
      | "not fully redacted"
      | "unsafe metadata"
      | "invalid time zone"
  ) {
    super(`Event content is unsafe: ${reason}`);
    this.name = "UnsafeEventContentError";
  }
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new UnsafeEventContentError("invalid time zone");
  }
}

const metadataLimits: Record<string, number> = {
  model: 128,
  intent: 128,
  clientVersion: 64,
  connector: 64,
  sourceFormat: 64,
  gitBranch: 512
};

function validateMetadata(metadata: Record<string, unknown>): void {
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 16 * 1024) {
    throw new UnsafeEventContentError("unsafe metadata");
  }
  for (const [key, value] of Object.entries(metadata)) {
    const maxLength = metadataLimits[key];
    if (
      maxLength === undefined ||
      typeof value !== "string" ||
      value.length > maxLength ||
      redactSensitiveText(value) !== value
    ) {
      throw new UnsafeEventContentError("unsafe metadata");
    }
  }
}

function validateProjectHint(event: SyncEvent): void {
  const rootName = event.projectHint?.repoRootName;
  if (
    rootName !== undefined &&
    (rootName.trim().length === 0 ||
      [...rootName].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      }) ||
      redactSensitiveText(rootName) !== rootName)
  ) {
    throw new UnsafeEventContentError("unsafe metadata");
  }
}

export function validateSanitizedEvents(events: readonly SyncEvent[]): void {
  for (const event of events) {
    validateTimeZone(event.sourceTimeZone);
    validateProjectHint(event);
    if (sha256Hex(event.sanitizedContent) !== event.contentHash) {
      throw new UnsafeEventContentError("digest mismatch");
    }
    if (redactSensitiveText(event.sanitizedContent) !== event.sanitizedContent) {
      throw new UnsafeEventContentError("not fully redacted");
    }
    validateMetadata(event.metadata);
  }
}
