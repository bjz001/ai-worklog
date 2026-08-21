"use client";

import type { LlmSettingsResponse } from "@ai-worklog/contracts";
import { useEffect, useId, useMemo, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { LoadingState } from "@/components/ui/PageElements";
import { StatusChip } from "@/components/ui/StatusChip";
import { useApiResource } from "@/hooks/use-api-resource";
import { mutateApi } from "@/lib/api-client";
import {
  buildSummaryPromptUpdate,
  promptDraftIsDirty,
  promptDraftValidationMessage,
  type SummaryPromptKey,
  type SummaryPromptSettings,
  type SummaryPromptView,
  summaryPromptByteLength
} from "./summary-prompt-editor-model";

type PromptSettingsData = Omit<
  LlmSettingsResponse["data"],
  "summaryPrompts"
> &
  SummaryPromptSettings;

type PromptSettingsResponse = { data: PromptSettingsData };

const scopeNames: Record<SummaryPromptKey, string> = {
  daily: "日总结",
  weekly: "周总结",
  monthly: "月总结"
};

export function SummaryPromptEditor({
  scope,
  disabled = false,
  onDirtyChange
}: {
  scope: SummaryPromptKey;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const editorId = useId();
  const panelId = `${editorId}-panel`;
  const textareaId = `${editorId}-instructions`;
  const {
    data,
    error,
    loading,
    reload
  } = useApiResource<PromptSettingsResponse>("/api/v1/llm-settings");
  const [settings, setSettings] = useState<PromptSettingsData | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [restoringDefault, setRestoringDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!data) return;
    setSettings(data.data);
    setDraft(data.data.summaryPrompts[scope].instructions);
    setRestoringDefault(false);
  }, [data, scope]);

  const prompt: SummaryPromptView | null =
    settings?.summaryPrompts[scope] ?? null;
  const dirty = prompt
    ? promptDraftIsDirty({
        draft,
        originalInstructions: prompt.instructions,
        originalIsCustomized: prompt.isCustomized,
        restoringDefault
      })
    : false;
  const validationMessage = useMemo(
    () => promptDraftValidationMessage(draft),
    [draft]
  );
  const byteLength = useMemo(() => summaryPromptByteLength(draft.trim()), [draft]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange]
  );

  function cancelEdits() {
    if (!prompt) return;
    setDraft(prompt.instructions);
    setRestoringDefault(false);
    setFeedback(null);
  }

  function restoreDefault() {
    if (!prompt?.defaultInstructions) return;
    setDraft(prompt.defaultInstructions);
    setRestoringDefault(true);
    setFeedback(null);
  }

  async function save() {
    if (!settings || !prompt || validationMessage) return;
    setSaving(true);
    setFeedback(null);
    try {
      const response = await mutateApi<PromptSettingsResponse>(
        "/api/v1/llm-settings",
        {
          method: "PUT",
          body: buildSummaryPromptUpdate(
            settings,
            scope,
            restoringDefault ? null : draft
          )
        }
      );
      const savedPrompt = response.data.summaryPrompts[scope];
      setSettings(response.data);
      setDraft(savedPrompt.instructions);
      setRestoringDefault(false);
      setFeedback({
        tone: "success",
        message:
          "Prompt 已保存。已有总结不会自动改变，下次生成或重新生成时生效。"
      });
      reload();
    } catch (caught) {
      setFeedback({
        tone: "error",
        message: caught instanceof Error ? caught.message : "Prompt 保存失败"
      });
    } finally {
      setSaving(false);
    }
  }

  const status = loading
    ? { label: "正在加载", tone: "neutral" as const }
    : error
      ? { label: "加载失败", tone: "danger" as const }
      : prompt?.isCustomized
        ? { label: "已自定义", tone: "info" as const }
        : { label: "系统默认", tone: "neutral" as const };

  return (
    <div className="summary-prompt-editor">
      <button
        aria-controls={panelId}
        aria-expanded={expanded}
        className="summary-prompt-editor__disclosure"
        disabled={saving}
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span className="summary-prompt-editor__title">
          <Icon name="code" />
          <span>
            <strong>{scopeNames[scope]} Prompt</strong>
            <small>查看并调整 LLM 的业务归纳要求</small>
          </span>
        </span>
        <span className="summary-prompt-editor__meta">
          {dirty ? <span className="summary-prompt-editor__dirty">尚未保存</span> : null}
          <StatusChip tone={status.tone}>{status.label}</StatusChip>
          <Icon
            className={expanded
              ? "disclosure-icon disclosure-icon--open"
              : "disclosure-icon"}
            name="chevron-right"
          />
        </span>
      </button>

      <div
        aria-label={`${scopeNames[scope]} Prompt 编辑器`}
        className="summary-prompt-editor__panel"
        hidden={!expanded}
        id={panelId}
        role="region"
      >
        {loading ? <LoadingState rows={2} /> : null}
        {error ? (
          <div className="inline-error summary-prompt-editor__error" role="alert">
            <span>总结 Prompt 暂时无法加载，不影响查看已有总结。</span>
            <button
              className="button button--secondary"
              onClick={reload}
              type="button"
            >
              重新加载
            </button>
          </div>
        ) : null}

        {!loading && !error && prompt ? (
          <form
            className="summary-prompt-editor__form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="form-field" htmlFor={textareaId}>
              <span>业务归纳要求</span>
              <textarea
                disabled={disabled || saving}
                id={textareaId}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setRestoringDefault(false);
                  setFeedback(null);
                }}
                rows={8}
                spellCheck={false}
                value={draft}
              />
              <small>
                可以调整总结重点和表达方式；证据安全、引用校验和 JSON
                输出结构由系统固定。
              </small>
            </label>

            <div className="summary-prompt-editor__counter">
              <span className={validationMessage ? "text-danger" : "muted"}>
                {validationMessage ?? `${byteLength} / 4096 个 UTF-8 字节`}
              </span>
              {restoringDefault ? (
                <span className="summary-prompt-editor__pending">
                  保存后恢复系统默认
                </span>
              ) : null}
            </div>

            <section
              aria-labelledby={`${editorId}-effective-title`}
              className="summary-prompt-editor__effective"
            >
              <div>
                <h3 id={`${editorId}-effective-title`}>
                  当前完整生效 Prompt（只读）
                </h3>
                <p>
                  这是服务端实际加入 LLM 请求的 System Prompt；工作证据会在生成时自动附加。
                </p>
              </div>
              {dirty ? (
                <p className="summary-prompt-editor__preview-note">
                  保存后，服务端会重新生成完整生效 Prompt 并在这里更新。
                </p>
              ) : null}
              <pre tabIndex={0}>{prompt.effectivePrompt}</pre>
            </section>

            {feedback ? (
              <div
                className={`form-feedback form-feedback--${feedback.tone}`}
                role={feedback.tone === "error" ? "alert" : "status"}
              >
                <Icon name={feedback.tone === "success" ? "check" : "error"} />
                <span>{feedback.message}</span>
              </div>
            ) : null}

            <div className="summary-prompt-editor__actions">
              <button
                className="button button--text"
                disabled={
                  disabled ||
                  saving ||
                  restoringDefault ||
                  (!prompt.isCustomized && !dirty) ||
                  !prompt.defaultInstructions
                }
                onClick={restoreDefault}
                type="button"
              >
                恢复系统默认
              </button>
              <span className="summary-prompt-editor__action-spacer" />
              <button
                className="button button--secondary"
                disabled={disabled || saving || !dirty}
                onClick={cancelEdits}
                type="button"
              >
                取消修改
              </button>
              <button
                className="button button--primary"
                disabled={disabled || saving || !dirty || Boolean(validationMessage)}
                type="submit"
              >
                <Icon name={saving ? "schedule" : "check"} />
                {saving ? "正在保存…" : "保存 Prompt"}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
