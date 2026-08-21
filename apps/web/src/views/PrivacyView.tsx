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
  const needsAttention = Boolean(privacy?.pendingDeletionCount);
  const state = collectionState({
    loading,
    error,
    count: privacy ? 1 : 0,
    partial: needsAttention
  });

  if (state === "loading") return <><PageHeader title="数据与隐私" description="查看原始轨迹、保留与删除状态" /><LoadingState rows={5} /></>;
  if (state === "error" && error) return <><PageHeader title="数据与隐私" description="查看原始轨迹、保留与删除状态" /><ErrorState error={error} onRetry={reload} /></>;
  if (state === "empty" || !privacy) return <><PageHeader title="数据与隐私" description="查看原始轨迹、保留与删除状态" /><EmptyState description="隐私配置尚未初始化，请稍后刷新或检查中心服务。" icon="shield" title="暂无隐私配置" /></>;

  return (
    <>
      <PageHeader description="v2 保存来源实际暴露的未脱敏完整轨迹；设备 Token 和 LLM API Key 仍独立保护" title="数据与隐私" />
      {needsAttention ? (
        <PartialNotice>
          {`${privacy.pendingDeletionCount} 项删除任务仍在处理中。`}
        </PartialNotice>
      ) : null}

      <Surface className="surface--primary" title="隐私概览" description="当前中心端数据处理边界">
        <div className="surface__body metrics">
          <Metric label="内容协议" value={privacy.redactionVersion} helper="v1 保持脱敏校验，v2 不做脱敏" />
          <Metric label="数据保留" value={privacy.retentionDays === null ? "长期保留" : `${formatNumber(privacy.retentionDays)} 天`} helper="完整 Blob 与轨迹长期保留" />
          <Metric label="待删除" value={formatNumber(privacy.pendingDeletionCount)} helper="包含派生数据清理" />
        </div>
      </Surface>

      <div className="page-grid page-grid--two privacy-grid">
        <Surface title="内容边界" description="完整采集与凭证保护的分工">
          <div className="simple-list">
            <div className="simple-row">
              <div className="device-name"><span className="device-icon"><Icon name="shield" /></span><div className="simple-row__copy"><strong>设备身份与账户隔离</strong><span>同步、补传与 Blob 下载都校验账户所有权</span></div></div>
              <StatusChip tone="success" icon={<Icon name="check" />}>已启用</StatusChip>
            </div>
            <div className="simple-row">
              <div className="device-name"><span className="device-icon"><Icon name="code" /></span><div className="simple-row__copy"><strong>v2 原始轨迹</strong><span>system/context/reasoning/工具等正文不脱敏、不截断、不正文加密</span></div></div>
              <StatusChip tone="warning" icon={<Icon name="warning" />}>{privacy.rawContentStored ? "完整保存" : "未开启"}</StatusChip>
            </div>
            <div className="simple-row">
              <div className="device-name"><span className="device-icon"><Icon name="skill" /></span><div className="simple-row__copy"><strong>凭证独立保护</strong><span>设备 Token 不入轨迹，LLM API Key 继续加密保存</span></div></div>
              <StatusChip tone="success" icon={<Icon name="check" />}>已保护</StatusChip>
            </div>
          </div>
        </Surface>

        <Surface title="导出与删除" description="敏感操作需要后端二次确认和审计">
          <div className="surface__body stack">
            <div className="privacy-action">
              <span className="privacy-action__icon"><Icon name="download" /></span>
              <div><strong>导出原始轨迹</strong><p className="muted">{privacy.exportReady ? "当前数据已经可以生成导出包。" : "导出服务正在准备，请稍后再试。"}</p></div>
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
