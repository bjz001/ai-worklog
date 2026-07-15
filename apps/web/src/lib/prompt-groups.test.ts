import type { PromptView } from "@ai-worklog/contracts";
import { describe, expect, it } from "vitest";

import { groupPromptsByProject } from "./prompt-groups";

function prompt(
  id: string,
  projectId: string | null,
  projectName: string
): PromptView {
  return {
    id,
    content: `Prompt ${id}`,
    resultExcerpt: null,
    projectId,
    projectName,
    deviceId: "device-1",
    deviceName: "Mac",
    sourceType: "CODEX",
    occurredAt: "2026-07-15T08:00:00.000Z",
    workDate: "2026-07-15",
    tags: [],
    isFavorite: false
  };
}

describe("groupPromptsByProject", () => {
  it("groups the current page by project ID while preserving first-seen order", () => {
    const groups = groupPromptsByProject([
      prompt("a-latest", "project-a", "同名项目"),
      prompt("b-latest", "project-b", "同名项目"),
      prompt("a-older", "project-a", "同名项目"),
      prompt("unknown-latest", null, "未分类项目"),
      prompt("unknown-older", null, "未分类项目")
    ]);

    expect(groups.map((group) => group.projectId)).toEqual([
      "project-a",
      "project-b",
      null
    ]);
    expect(groups.map((group) => group.prompts.map((item) => item.id))).toEqual([
      ["a-latest", "a-older"],
      ["b-latest"],
      ["unknown-latest", "unknown-older"]
    ]);
  });

  it("keeps unclassified prompts separate from a real project with the same label", () => {
    const groups = groupPromptsByProject([
      prompt("real", "project-unclassified", "未分类项目"),
      prompt("unknown", null, "未分类项目")
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.key)).toEqual([
      "project:project-unclassified",
      "unclassified"
    ]);
  });

  it("returns no groups for an empty page", () => {
    expect(groupPromptsByProject([])).toEqual([]);
  });
});
