import { describe, expect, it } from "vitest";

import { ApiRequestError } from "../../lib/api-client";
import {
  buildSummaryPromptUpdate,
  promptDraftIsDirty,
  promptDraftValidationMessage,
  summaryGenerationErrorCopy
} from "./summary-prompt-editor-model";

const settings = {
  provider: "DEEPSEEK" as const,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  summaryPrompts: {
    daily: {
      instructions: "日总结默认要求",
      defaultInstructions: "日总结默认要求",
      effectivePrompt: "日总结完整 Prompt",
      isCustomized: false
    },
    weekly: {
      instructions: "自定义周总结要求",
      defaultInstructions: "周总结默认要求",
      effectivePrompt: "周总结完整 Prompt",
      isCustomized: true
    },
    monthly: {
      instructions: "月总结默认要求",
      defaultInstructions: "月总结默认要求",
      effectivePrompt: "月总结完整 Prompt",
      isCustomized: false
    }
  }
};

describe("summary prompt editor model", () => {
  it("builds a complete settings update without clearing other prompt scopes", () => {
    expect(
      buildSummaryPromptUpdate(settings, "monthly", "  突出业务价值  ")
    ).toEqual({
      provider: "DEEPSEEK",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      summaryPrompts: {
        daily: null,
        weekly: "自定义周总结要求",
        monthly: "突出业务价值"
      }
    });
  });

  it("uses null only for the scope being restored to its system default", () => {
    expect(buildSummaryPromptUpdate(settings, "weekly", null).summaryPrompts)
      .toEqual({
        daily: null,
        weekly: null,
        monthly: null
      });
  });

  it("validates empty, control-character, and UTF-8 byte-limited drafts", () => {
    expect(promptDraftValidationMessage("  ")).toBe("业务归纳要求不能为空。");
    expect(promptDraftValidationMessage("正常\u0000异常")).toBe(
      "业务归纳要求不能包含控制字符。"
    );
    expect(promptDraftValidationMessage("工".repeat(1_366))).toBe(
      "业务归纳要求不能超过 4096 个 UTF-8 字节。"
    );
    expect(promptDraftValidationMessage("突出主要成果")).toBeNull();
  });

  it("distinguishes normal edits from a pending restore-default action", () => {
    expect(promptDraftIsDirty({
      draft: "日总结默认要求",
      originalInstructions: "日总结默认要求",
      originalIsCustomized: false,
      restoringDefault: false
    })).toBe(false);
    expect(promptDraftIsDirty({
      draft: "周总结默认要求",
      originalInstructions: "自定义周总结要求",
      originalIsCustomized: true,
      restoringDefault: true
    })).toBe(true);
  });
});

describe("summary generation error copy", () => {
  it("explains invalid JSON without exposing the upstream response", () => {
    const error = new ApiRequestError({
      status: 502,
      code: "LLM_UPSTREAM_INVALID_JSON",
      message: "raw upstream detail",
      requestId: "request-123"
    });

    expect(summaryGenerationErrorCopy(error)).toEqual({
      title: "LLM 返回的总结不是有效 JSON",
      guidance:
        "请检查自定义归纳要求，避免要求模型输出 Markdown 或解释文字；也可以恢复系统默认后重试。",
      requestId: "request-123"
    });
  });

  it("gives distinct recovery guidance for empty and truncated output", () => {
    expect(summaryGenerationErrorCopy(new ApiRequestError({
      status: 502,
      code: "LLM_UPSTREAM_EMPTY_RESPONSE"
    })).title).toBe("LLM 没有返回总结内容");

    expect(summaryGenerationErrorCopy(new ApiRequestError({
      status: 502,
      code: "LLM_UPSTREAM_OUTPUT_TRUNCATED"
    })).guidance).toContain("缩短业务归纳要求");
  });

  it("keeps a safe fallback for unrelated errors", () => {
    expect(summaryGenerationErrorCopy(new Error("网络暂时不可用"))).toEqual({
      title: "总结生成失败",
      guidance: "网络暂时不可用"
    });
  });
});
