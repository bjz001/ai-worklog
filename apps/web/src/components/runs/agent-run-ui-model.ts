import type {
  AgentAttachmentView,
  AgentEventKind,
  AgentEventView,
  AgentSourceType,
  AttachmentStatus,
  NormalizedCoverage,
  RawCaptureStatus
} from "@ai-worklog/contracts";

export type AgentTextPurpose = AgentEventView["contentPurposes"][number];
export type AgentStatusTone = "neutral" | "info" | "success" | "warning" | "danger";
type StatusMeta = { label: string; tone: AgentStatusTone };

export interface AgentResourceTreeNode {
  id: string;
  name: string;
  path: string;
  kind: "folder" | "file";
  children: AgentResourceTreeNode[];
  attachment: AgentAttachmentView | null;
}

const SOURCE_LABELS: Record<AgentSourceType, string> = {
  CODEX: "Codex",
  CLAUDE_CODE: "Claude Code",
  ZCODE: "Z.ai ZCode",
  DSH: "DeepSeek Harness"
};

const EVENT_LABELS: Record<AgentEventKind, string> = {
  SYSTEM: "System",
  CONTEXT: "Context",
  USER: "User",
  ASSISTANT: "Assistant result",
  REASONING: "Reasoning",
  TOOL_CALL: "Tool",
  TOOL_RESULT: "Result",
  SUBAGENT: "Subagent",
  STATE: "State",
  TURN_BOUNDARY: "Turn",
  ERROR: "Error",
  SOURCE_EVENT: "Source event"
};

const EVENT_TONES: Record<AgentEventKind, AgentStatusTone> = {
  SYSTEM: "neutral",
  CONTEXT: "info",
  USER: "info",
  ASSISTANT: "success",
  REASONING: "warning",
  TOOL_CALL: "warning",
  TOOL_RESULT: "success",
  SUBAGENT: "info",
  STATE: "neutral",
  TURN_BOUNDARY: "neutral",
  ERROR: "danger",
  SOURCE_EVENT: "neutral"
};

export function agentSourceLabel(source: AgentSourceType): string {
  return SOURCE_LABELS[source];
}

export function agentEventLabel(kind: AgentEventKind): string {
  return EVENT_LABELS[kind];
}

export function agentEventBadgeLabel(
  event: Pick<AgentEventView, "kind" | "metadata">
): string {
  if (event.kind === "SOURCE_EVENT") {
    const sourceSubtype = [
      event.metadata.subtype,
      event.metadata.eventType,
      event.metadata.type
    ].find((value): value is string => typeof value === "string")
      ?.trim()
      .toUpperCase();
    if (["SKILL", "SKILL_CALL", "SKILL_INVOCATION"].includes(sourceSubtype ?? "")) {
      return "Skill";
    }
  }
  return agentEventLabel(event.kind);
}

export function agentEventTone(kind: AgentEventKind): AgentStatusTone {
  return EVENT_TONES[kind];
}

export function preferredContentPurpose(
  event: Pick<AgentEventView, "kind" | "contentPurposes">
): AgentTextPurpose | null {
  const preferred: AgentTextPurpose[] = event.kind === "TOOL_CALL"
    ? ["TOOL_ARGUMENTS", "RENDERED_CONTENT", "TOOL_RESULT", "SEARCH_TEXT"]
    : event.kind === "TOOL_RESULT"
      ? ["TOOL_RESULT", "RENDERED_CONTENT", "TOOL_ARGUMENTS", "SEARCH_TEXT"]
      : ["RENDERED_CONTENT", "TOOL_ARGUMENTS", "TOOL_RESULT", "SEARCH_TEXT"];
  return preferred.find((purpose) => event.contentPurposes.includes(purpose)) ?? null;
}

export function eventContentUrl(
  event: Pick<AgentEventView, "contentUrl">,
  purpose: AgentTextPurpose
): string | null {
  if (!event.contentUrl) return null;
  const base = event.contentUrl.split("?", 1)[0];
  return `${base}?purpose=${encodeURIComponent(purpose)}`;
}

export function isMirrorEvent(
  event: Pick<AgentEventView, "mirrorOfEventId" | "metadata">
): boolean {
  return Boolean(event.mirrorOfEventId) || event.metadata.mirror === true;
}

export function eventDisplayName(
  event: Pick<AgentEventView, "kind" | "metadata">
): string {
  const nameCandidates = [
    event.metadata.toolName,
    event.metadata.name,
    event.metadata.tool,
    event.metadata.subtype
  ];
  const name = nameCandidates.find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0
  );
  return name?.trim() || agentEventLabel(event.kind);
}

export function rawCaptureStatusMeta(status: RawCaptureStatus): {
  label: string;
  tone: AgentStatusTone;
} {
  const values: Record<RawCaptureStatus, StatusMeta> = {
    CAPTURED: { label: "原始载荷完整", tone: "success" },
    PARTIAL: { label: "原始载荷部分缺失", tone: "warning" },
    NOT_EXPOSED: { label: "来源未暴露", tone: "neutral" },
    UNREADABLE: { label: "原始载荷不可读", tone: "warning" },
    CORRUPT: { label: "原始载荷损坏", tone: "danger" }
  };
  return values[status];
}

export function normalizedCoverageMeta(status: NormalizedCoverage): {
  label: string;
  tone: AgentStatusTone;
} {
  const values: Record<NormalizedCoverage, StatusMeta> = {
    FULL: { label: "规范化完整", tone: "success" },
    PARTIAL: { label: "规范化部分覆盖", tone: "warning" },
    NONE: { label: "仅原始事件", tone: "neutral" },
    UNKNOWN: { label: "覆盖范围未知", tone: "neutral" }
  };
  return values[status];
}

export function attachmentStatusMeta(status: AttachmentStatus): {
  label: string;
  tone: AgentStatusTone;
} {
  const values: Record<AttachmentStatus, StatusMeta> = {
    NOT_APPLICABLE: { label: "无附件", tone: "neutral" },
    PENDING: { label: "附件待同步", tone: "warning" },
    CAPTURED: { label: "附件已采集", tone: "success" },
    MISSING: { label: "附件已缺失", tone: "warning" },
    READ_ERROR: { label: "附件读取失败", tone: "danger" },
    NOT_REGULAR: { label: "不是普通文件", tone: "neutral" },
    STORAGE_FULL: { label: "存储空间不足", tone: "danger" }
  };
  return values[status];
}

export function formatByteLength(value: number | null): string {
  if (value === null) return "大小未知";
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1_024 * 1_024 * 1_024) {
    return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
  }
  return `${(value / (1_024 * 1_024 * 1_024)).toFixed(1)} GiB`;
}

interface MutableResourceTreeNode extends AgentResourceTreeNode {
  childMap: Map<string, MutableResourceTreeNode>;
}

function resourcePathSegments(
  attachment: AgentAttachmentView,
  rootHint: string | null
): { displayPath: string; segments: string[] } {
  const displayPath = attachment.realPath
    ?? attachment.requestedPath
    ?? attachment.filename
    ?? attachment.referenceId;
  const normalized = displayPath.replace(/\\/g, "/");
  let segments = normalized.split("/").filter(Boolean);
  const rootName = rootHint?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1);
  if (rootName) {
    const rootIndex = segments.findIndex(
      (segment) => segment.toLocaleLowerCase() === rootName.toLocaleLowerCase()
    );
    if (rootIndex >= 0) segments = segments.slice(rootIndex + 1);
  }
  if (segments.length === 0) {
    segments = [attachment.filename ?? displayPath];
  } else if (attachment.filename) {
    segments[segments.length - 1] = attachment.filename;
  }
  return { displayPath, segments };
}

function finalizeResourceTree(
  nodes: Iterable<MutableResourceTreeNode>
): AgentResourceTreeNode[] {
  return [...nodes]
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    })
    .map((node) => ({
      id: node.id,
      name: node.name,
      path: node.path,
      kind: node.kind,
      attachment: node.attachment,
      children: finalizeResourceTree(node.childMap.values())
    }));
}

export function buildAgentResourceTree(
  attachments: AgentAttachmentView[],
  rootHint: string | null = null
): AgentResourceTreeNode[] {
  const roots = new Map<string, MutableResourceTreeNode>();
  for (const attachment of attachments) {
    const { displayPath, segments } = resourcePathSegments(attachment, rootHint);
    let children = roots;
    const pathParts: string[] = [];
    segments.forEach((segment, index) => {
      pathParts.push(segment);
      const isFile = index === segments.length - 1;
      const mapKey = isFile
        ? `file:${segment}:${attachment.id}`
        : `folder:${segment}`;
      let node = children.get(mapKey);
      if (!node) {
        node = {
          id: isFile ? attachment.id : `folder:${pathParts.join("/")}`,
          name: segment,
          path: isFile ? displayPath : pathParts.join("/"),
          kind: isFile ? "file" : "folder",
          attachment: isFile ? attachment : null,
          children: [],
          childMap: new Map()
        };
        children.set(mapKey, node);
      }
      children = node.childMap;
    });
  }
  return finalizeResourceTree(roots.values());
}
