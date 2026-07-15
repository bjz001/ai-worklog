"use client";

import type {
  LlmConnectionTestResponse,
  LlmProvider,
  LlmSettingsResponse
} from "@ai-worklog/contracts";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  Surface
} from "@/components/ui/PageElements";
import { StatusChip } from "@/components/ui/StatusChip";
import { useApiResource } from "@/hooks/use-api-resource";
import { mutateApi } from "@/lib/api-client";

type Feedback = { tone: "success" | "error"; message: string } | null;

export function LlmSettingsView() {
  const { data, error, loading, reload } =
    useApiResource<LlmSettingsResponse>("/api/v1/llm-settings");
  const settings = data?.data;
  const [provider, setProvider] = useState<LlmProvider>("DEEPSEEK");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com");
  const [model, setModel] = useState("deepseek-v4-flash");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  function markEdited(): void {
    setFeedback(null);
  }

  useEffect(() => {
    if (!settings) return;
    setProvider(settings.provider);
    setBaseUrl(settings.baseUrl);
    setModel(settings.model);
  }, [settings]);

  const isDirty = useMemo(
    () =>
      Boolean(
        apiKey ||
        (settings &&
          (settings.provider !== provider ||
            settings.baseUrl !== baseUrl.trim() ||
            settings.model !== model.trim()))
      ),
    [apiKey, baseUrl, model, provider, settings]
  );
  const credentialScopeChanged = useMemo(() => {
    if (!settings) return false;
    try {
      return (
        settings.provider !== provider ||
        new URL(settings.baseUrl).origin !== new URL(baseUrl.trim()).origin
      );
    } catch {
      return false;
    }
  }, [baseUrl, provider, settings]);
  const apiKeyRequired = !settings?.hasApiKey || credentialScopeChanged;

  async function save(): Promise<LlmSettingsResponse> {
    const response = await mutateApi<LlmSettingsResponse>(
      "/api/v1/llm-settings",
      {
        method: "PUT",
        body: {
          provider,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          ...(apiKey ? { apiKey } : {})
        }
      }
    );
    setApiKey("");
    await reload();
    return response;
  }

  async function handleSave() {
    setBusy("save");
    setFeedback(null);
    try {
      await save();
      setFeedback({ tone: "success", message: "LLM 配置已安全保存。" });
    } catch (caught) {
      setFeedback({
        tone: "error",
        message: caught instanceof Error ? caught.message : "配置保存失败"
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleTest() {
    setBusy("test");
    setFeedback(null);
    try {
      if (isDirty) await save();
      const response = await mutateApi<LlmConnectionTestResponse>(
        "/api/v1/llm-settings/test",
        { method: "POST", body: {} }
      );
      setFeedback({
        tone: "success",
        message: `连接成功：${response.data.model}，${response.data.latencyMs} ms。`
      });
    } catch (caught) {
      setFeedback({
        tone: "error",
        message: caught instanceof Error ? caught.message : "连接测试失败"
      });
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <><PageHeader title="LLM 设置" description="配置工作总结使用的模型服务" /><LoadingState rows={5} /></>;
  }
  if (error) {
    return <><PageHeader title="LLM 设置" description="配置工作总结使用的模型服务" /><ErrorState error={error} onRetry={reload} /></>;
  }

  return (
    <>
      <PageHeader
        title="LLM 设置"
        description="工作总结将由已验证的模型识别；Skill 候选仍需人工确认"
        actions={
          <StatusChip
            icon={<Icon name={settings?.hasApiKey ? "check" : "warning"} />}
            tone={settings?.hasApiKey ? "success" : "warning"}
          >
            {settings?.hasApiKey ? "API Key 已配置" : "等待配置"}
          </StatusChip>
        }
      />

      <div className="settings-layout">
        <Surface
          className="settings-card"
          title="模型连接"
          description="配置只保存在中心端；API Key 加密后写入 MySQL，页面不会回显"
        >
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <label className="form-field">
              <span>服务商</span>
              <select
                disabled={busy !== null}
                onChange={(event) => {
                  markEdited();
                  setProvider(event.target.value as LlmProvider);
                }}
                value={provider}
              >
                <option value="DEEPSEEK">DeepSeek</option>
                <option value="OPENAI_COMPATIBLE">OpenAI 兼容接口</option>
              </select>
              <small>DeepSeek 使用官方 OpenAI 兼容 Chat Completions 接口。</small>
            </label>

            <label className="form-field">
              <span>Base URL</span>
              <input
                autoCapitalize="none"
                autoComplete="url"
                disabled={busy !== null}
                onChange={(event) => {
                  markEdited();
                  setBaseUrl(event.target.value);
                }}
                required
                spellCheck={false}
                type="url"
                value={baseUrl}
              />
              <small>仅允许公网 HTTPS 地址；DeepSeek 固定使用官方域名。</small>
            </label>

            <label className="form-field">
              <span>模型</span>
              <input
                autoCapitalize="none"
                autoComplete="off"
                disabled={busy !== null}
                onChange={(event) => {
                  markEdited();
                  setModel(event.target.value);
                }}
                required
                spellCheck={false}
                value={model}
              />
            </label>

            <label className="form-field">
              <span>API Key</span>
              <input
                autoCapitalize="none"
                autoComplete="new-password"
                disabled={busy !== null}
                onChange={(event) => {
                  markEdited();
                  setApiKey(event.target.value);
                }}
                placeholder={apiKeyRequired ? "请输入 API Key" : "留空则继续使用已保存的 Key"}
                required={apiKeyRequired}
                spellCheck={false}
                type="password"
                value={apiKey}
              />
              <small>{credentialScopeChanged
                ? "更换服务商或域名时必须填写新 Key，旧 Key 绝不会发送到新域名。"
                : settings?.hasApiKey
                  ? "已保存的 Key 不会回填；输入新值会安全替换。"
                  : "首次配置必须填写，保存后输入框会清空。"}</small>
            </label>

            {feedback ? (
              <div
                className={`form-feedback form-feedback--${feedback.tone}`}
                role={feedback.tone === "error" ? "alert" : "status"}
              >
                <Icon name={feedback.tone === "success" ? "check" : "error"} />
                <span>{feedback.message}</span>
              </div>
            ) : null}

            <div className="form-actions">
              <button
                className="button button--secondary"
                disabled={busy !== null || (apiKeyRequired && !apiKey)}
                onClick={() => void handleTest()}
                type="button"
              >
                <Icon name="refresh" />
                {busy === "test" ? "正在测试…" : "测试连接"}
              </button>
              <button
                className="button button--primary"
                disabled={busy !== null || !isDirty || (apiKeyRequired && !apiKey)}
                type="submit"
              >
                <Icon name="check" />
                {busy === "save" ? "正在保存…" : "保存配置"}
              </button>
            </div>
          </form>
        </Surface>

        <Surface title="总结工作流" description="每日同步后的处理方式">
          <div className="surface__body settings-flow">
            <div><span>1</span><p><strong>本地脱敏与同步</strong><small>Mac 与 Windows 只上传脱敏后的 Prompt 和可见结果。</small></p></div>
            <div><span>2</span><p><strong>LLM 识别工作进展</strong><small>模型只能基于当日证据生成亮点和项目进展。</small></p></div>
            <div><span>3</span><p><strong>证据校验后入库</strong><small>无效证据引用会导致任务保留并等待重试。</small></p></div>
          </div>
        </Surface>
      </div>
    </>
  );
}
