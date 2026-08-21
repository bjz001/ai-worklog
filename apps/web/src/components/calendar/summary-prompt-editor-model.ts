import type { LlmProvider } from "@ai-worklog/contracts";

export type SummaryPromptKey = "daily" | "weekly" | "monthly";

export interface SummaryPromptView {
  instructions: string;
  defaultInstructions: string;
  effectivePrompt: string;
  isCustomized: boolean;
}

export interface SummaryPromptSettings {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  summaryPrompts: Record<SummaryPromptKey, SummaryPromptView>;
}

export const SUMMARY_PROMPT_MAX_BYTES = 4_096;

export function summaryPromptByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function promptDraftValidationMessage(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "业务归纳要求不能为空。";
  if (Array.from(trimmed).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
      codePoint === 127
    );
  })) {
    return "业务归纳要求不能包含控制字符。";
  }
  if (summaryPromptByteLength(trimmed) > SUMMARY_PROMPT_MAX_BYTES) {
    return "业务归纳要求不能超过 4096 个 UTF-8 字节。";
  }
  return null;
}

export function promptDraftIsDirty(options: {
  draft: string;
  originalInstructions: string;
  originalIsCustomized: boolean;
  restoringDefault: boolean;
}): boolean {
  if (options.restoringDefault) return options.originalIsCustomized;
  return options.draft.trim() !== options.originalInstructions.trim();
}

export function buildSummaryPromptUpdate(
  settings: SummaryPromptSettings,
  scope: SummaryPromptKey,
  instructions: string | null
) {
  const summaryPrompts = Object.fromEntries(
    (["daily", "weekly", "monthly"] as const).map((key) => [
      key,
      settings.summaryPrompts[key].isCustomized
        ? settings.summaryPrompts[key].instructions
        : null
    ])
  ) as Record<SummaryPromptKey, string | null>;
  summaryPrompts[scope] = instructions === null ? null : instructions.trim();

  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    summaryPrompts
  };
}

export interface SummaryGenerationErrorCopy {
  title: string;
  guidance: string;
  requestId?: string;
}

const generationErrorCopy: Record<
  string,
  Pick<SummaryGenerationErrorCopy, "title" | "guidance">
> = {
  LLM_UPSTREAM_OUTPUT_TRUNCATED: {
    title: "LLM 输出被截断，未形成完整总结",
    guidance: "请缩短业务归纳要求后重试；系统仍会自动控制证据数量和长度。"
  },
  LLM_UPSTREAM_EMPTY_RESPONSE: {
    title: "LLM 没有返回总结内容",
    guidance: "请先在 LLM 设置中测试连接，确认当前模型可用后再重试。"
  },
  LLM_UPSTREAM_INVALID_JSON: {
    title: "LLM 返回的总结不是有效 JSON",
    guidance:
      "请检查自定义归纳要求，避免要求模型输出 Markdown 或解释文字；也可以恢复系统默认后重试。"
  },
  LLM_UPSTREAM_INVALID_SCHEMA: {
    title: "LLM 返回的内容不符合总结结构",
    guidance:
      "请删除会改变字段或输出格式的自定义要求，或恢复系统默认后重新生成。"
  },
  LLM_UPSTREAM_INVALID_RESPONSE: {
    title: "LLM 返回了无法识别的响应",
    guidance: "请测试模型连接并检查完整生效 Prompt；问题持续时可凭请求 ID 排查服务日志。"
  },
  LLM_SUMMARY_INVALID_EVIDENCE: {
    title: "LLM 使用了不存在的证据引用",
    guidance: "请恢复系统默认 Prompt 或重试；系统不会保存无法核验的总结。"
  },
  LLM_UPSTREAM_RATE_LIMITED: {
    title: "LLM 服务当前限流",
    guidance: "请稍后再试，不需要重复修改 Prompt。"
  }
};

function errorField(error: unknown, field: "code" | "message" | "requestId") {
  if (!error || typeof error !== "object" || !(field in error)) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function summaryGenerationErrorCopy(
  error: unknown
): SummaryGenerationErrorCopy {
  const code = errorField(error, "code");
  const known = code ? generationErrorCopy[code] : undefined;
  const copy = known ?? {
    title: "总结生成失败",
    guidance: errorField(error, "message") ?? "请稍后重试。"
  };
  const requestId = errorField(error, "requestId");
  return {
    ...copy,
    ...(requestId ? { requestId } : {})
  };
}
