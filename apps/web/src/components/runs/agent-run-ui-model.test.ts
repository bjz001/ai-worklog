import { describe, expect, it } from "vitest";

import {
  agentEventBadgeLabel,
  agentEventLabel,
  agentSourceLabel,
  buildAgentResourceTree,
  eventContentUrl,
  eventDisplayName,
  formatByteLength,
  isMirrorEvent,
  preferredContentPurpose,
  rawCaptureStatusMeta
} from "./agent-run-ui-model";

describe("Agent run UI model", () => {
  it("labels all four Agent sources", () => {
    expect(agentSourceLabel("CODEX")).toBe("Codex");
    expect(agentSourceLabel("CLAUDE_CODE")).toBe("Claude Code");
    expect(agentSourceLabel("ZCODE")).toBe("Z.ai ZCode");
    expect(agentSourceLabel("DSH")).toBe("DeepSeek Harness");
  });

  it("selects tool arguments and results before generic rendered content", () => {
    expect(preferredContentPurpose({
      kind: "TOOL_CALL",
      contentPurposes: ["RENDERED_CONTENT", "TOOL_ARGUMENTS", "RAW_PAYLOAD"]
    })).toBe("TOOL_ARGUMENTS");
    expect(preferredContentPurpose({
      kind: "TOOL_RESULT",
      contentPurposes: ["RENDERED_CONTENT", "TOOL_RESULT"]
    })).toBe("TOOL_RESULT");
    expect(preferredContentPurpose({
      kind: "ASSISTANT",
      contentPurposes: ["RAW_PAYLOAD"]
    })).toBeNull();
  });

  it("constructs a purpose-specific content URL", () => {
    expect(eventContentUrl(
      { contentUrl: "/api/v1/agent-events/event-1/content?purpose=RAW_PAYLOAD" },
      "TOOL_ARGUMENTS"
    )).toBe("/api/v1/agent-events/event-1/content?purpose=TOOL_ARGUMENTS");
  });

  it("identifies mirror events and prefers source-provided names", () => {
    expect(isMirrorEvent({ mirrorOfEventId: "abc", metadata: {} })).toBe(true);
    expect(isMirrorEvent({ mirrorOfEventId: null, metadata: { mirror: true } })).toBe(true);
    expect(eventDisplayName({ kind: "TOOL_CALL", metadata: { toolName: "pwsh" } })).toBe("pwsh");
    expect(eventDisplayName({ kind: "ASSISTANT", metadata: {} })).toBe(agentEventLabel("ASSISTANT"));
  });

  it("uses a semantic Skill badge for source-exposed skill events", () => {
    expect(agentEventBadgeLabel({
      kind: "SOURCE_EVENT",
      metadata: { subtype: "SKILL" }
    })).toBe("Skill");
    expect(agentEventBadgeLabel({
      kind: "TOOL_CALL",
      metadata: { toolName: "pwsh" }
    })).toBe("Tool");
  });

  it("builds an attachment hierarchy relative to the run resource root", () => {
    const baseAttachment = {
      id: "attachment-1",
      referenceId: "a".repeat(64),
      purpose: "ATTACHMENT" as const,
      filename: "route.py",
      requestedPath: "D:\\skills\\personal-map\\scripts\\route.py",
      realPath: "D:\\skills\\personal-map\\scripts\\route.py",
      byteLength: 12,
      sha256: "b".repeat(64),
      mediaType: "text/x-python",
      status: "CAPTURED" as const,
      failureReason: null,
      downloadUrl: "/api/v1/blobs/blob-1"
    };
    const tree = buildAgentResourceTree([
      baseAttachment,
      {
        ...baseAttachment,
        id: "attachment-2",
        referenceId: "c".repeat(64),
        filename: "SKILL.md",
        requestedPath: "D:\\skills\\personal-map\\SKILL.md",
        realPath: "D:\\skills\\personal-map\\SKILL.md"
      }
    ], "/personal-map");

    expect(tree.map((node) => [node.kind, node.name])).toEqual([
      ["folder", "scripts"],
      ["file", "SKILL.md"]
    ]);
    expect(tree[0]?.children[0]?.attachment?.filename).toBe("route.py");
  });

  it("presents completeness and byte values without hiding loss", () => {
    expect(rawCaptureStatusMeta("NOT_EXPOSED").label).toBe("来源未暴露");
    expect(formatByteLength(0)).toBe("0 B");
    expect(formatByteLength(1_536)).toBe("1.5 KiB");
    expect(formatByteLength(null)).toBe("大小未知");
  });
});
