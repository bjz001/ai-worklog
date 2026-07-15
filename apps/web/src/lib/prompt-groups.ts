import type { PromptView } from "@ai-worklog/contracts";

export interface PromptProjectGroup {
  key: string;
  projectId: string | null;
  projectName: string;
  prompts: PromptView[];
}

export function groupPromptsByProject(
  prompts: readonly PromptView[]
): PromptProjectGroup[] {
  const groups = new Map<string, PromptProjectGroup>();

  for (const prompt of prompts) {
    const key = prompt.projectId === null
      ? "unclassified"
      : `project:${prompt.projectId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.prompts.push(prompt);
      continue;
    }

    groups.set(key, {
      key,
      projectId: prompt.projectId,
      projectName: prompt.projectName,
      prompts: [prompt]
    });
  }

  return [...groups.values()];
}
