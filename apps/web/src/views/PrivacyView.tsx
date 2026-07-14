"use client";

import type { PrivacyResponse } from "@ai-worklog/contracts";

import { Icon } from "@/components/ui/Icon";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Metric,
  PageHeader,
  PartialNotice,
  Surface
} from "@/components/ui/PageElements";
import { StatusChip } from "@/components/ui/StatusChip";
import { useApiResource } from "@/hooks/use-api-resource";
import { collectionState } from "@/lib/api-client";
import { formatNumber } from "@/lib/presenters";

export function PrivacyView() {
  const { data, error, loading, reload } =
    useApiResource<PrivacyResponse>("/api/v1/privacy");
  const privacy = data?.data;
  const needsAttention = Boolean(privacy?.rawContentStored || privacy?.pendingDeletionCount);
  const state = collectionState({
    loading,
    error,
    count: privacy ? 1 : 0,
    partial: needsAttention
  });

  if (state === "loading") return <><PageHeader title="数据与隐私" description="查看脱敏、保留与删除状态" /><LoadingState rows={5} /></>;
  if (state === "error" && error) return <><PageHeader title="数据与隐私" description="查看脱敏、保留与删除状态" /><ErrorState error={error} onRetry={reload} /></>;
  if (state === "empty" || !privacy) return <><PageHeader title="数据与隐私" description="查看脱敏、保留与删除状态" /><EmptyState description="隐私配置尚未初始化，请稍后刷新或检查中心服务。" icon="shield" title="暂无隐私配置" /></>;

  return (
    <>
      <PageHeader description="原始内容默认留在设备端，中心仅保存脱敏后的可搜索内容" title="数据与隐私" />
      {needsAttention ? (
        <PartialNotice>
          {privacy.rawContentStored ? "当前配置允许保存原始内容，请确认这符合你的隐私预期。" : `${privacy.pendingDeletionCount} 项删除任务仍在处理中。`}
        </PartialNotice>
      ) : null}

      <Surface className="surface--primary" title="隐私概览" description="当前中心端数据处理边界">
        <div className="surface__body metrics">
          <Metric label="脱敏规则版本" value={privacy.redactionVersion} helper="上传前在本机执行" />
          <Metric label="数据保留" value={privacy.retentionDays === null ? "长期保留" : `${formatNumber(privacy.retentionDays)} 天`} helper="MVP 尚未启用自动清理" />
          <Metric label="待删除" value={formatNumber(privacy.pendingDeletionCount)} helper="包含派生数据清理" />
        </div>
      </Surface>

      <div className="page-grid page-grid--two privacy-grid">
        <Surface title="内容保护" description="进入中心数据库前的安全控制">
          <div className="simple-list">
            <div className="simple-row">
              <div className="device-name"><span className="device-icon"><Icon name="shield" /></span><div className="simple-row__copy"><strong>本地脱敏</strong><span>密钥、Cookie、凭证 Remote 和敏感路径不会上传</span></div></div>
              <StatusChip tone="success" icon={<Icon name="check" />}>已启用</StatusChip>
            </div>
            <div className="simple-row">
              <div className="device-name"><span className="device-icon"><Icon name="code" /></span><div className="simple-row__copy"><strong>原始内容保存</strong><span>原始 Prompt 是否进入中心存储</span></div></div>
              <StatusChip tone={privacy.rawContentStored ? "warning" : "success"} icon={<Icon name={privacy.rawContentStored ? "warning" : "check"} />}>{privacy.rawContentStored ? "已开启" : "未开启"}</StatusChip>
            </div>
            <div className="simple-row">
              <div className="device-name"><span className="device-icon"><Icon name="skill" /></span><div className="simple-row__copy"><strong>Skill 人工确认</strong><span>候选不会自动写入、执行或发布</span></div></div>
              <StatusChip tone="success" icon={<Icon name="check" />}>强制确认</StatusChip>
            </div>
          </div>
        </Surface>

        <Surface title="导出与删除" description="敏感操作需要后端二次确认和审计">
          <div className="surface__body stack">
            <div className="privacy-action">
              <span className="privacy-action__icon"><Icon name="download" /></span>
              <div><strong>导出脱敏数据</strong><p className="muted">{privacy.exportReady ? "当前数据已经可以生成导出包。" : "导出服务正在准备，请稍后再试。"}</p></div>
              <button className="button button--secondary" disabled type="button">导出</button>
            </div>
            <div className="privacy-action privacy-action--danger">
              <span className="privacy-action__icon"><Icon name="delete" /></span>
              <div><strong>彻底删除数据</strong><p className="muted">同时清理搜索、总结、Skill 派生与缓存。</p></div>
              <button className="button button--danger" disabled type="button">删除</button>
            </div>
            <small className="muted">导出与删除 mutation 接通前保持禁用，避免产生虚假的成功反馈。</small>
          </div>
        </Surface>
      </div>
    </>
  );
}
