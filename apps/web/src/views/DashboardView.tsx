"use client";

import type { DashboardResponse, EvidenceView } from "@ai-worklog/contracts";
import Link from "next/link";

import { useDetailDrawer } from "@/components/shell/DrawerContext";
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
import {
  deviceStatusMeta,
  formatDateTime,
  formatNumber,
  formatWorkDate,
  summarizeText
} from "@/lib/presenters";

export function DashboardView() {
  const { data, error, loading, reload } =
    useApiResource<DashboardResponse>("/api/v1/dashboard");
  const { openDrawer } = useDetailDrawer();
  const dashboard = data?.data;
  const itemCount = dashboard
    ? dashboard.devices.length + dashboard.projects.length + (dashboard.summary ? 1 : 0)
    : 0;
  const partial = Boolean(
    dashboard?.summary?.status === "partial" ||
      dashboard?.devices.some((device) =>
        ["PARTIAL", "FAILED", "OFFLINE"].includes(device.status)
      )
  );
  const state = collectionState({ loading, error, count: itemCount, partial });

  const showEvidence = (evidence: EvidenceView) => {
    openDrawer({
      title: evidence.projectName,
      subtitle: formatDateTime(evidence.occurredAt),
      content: (
        <div className="stack">
          <section className="drawer-section">
            <h3>来源摘录</h3>
            <p>{evidence.excerpt}</p>
          </section>
          <section className="drawer-section">
            <h3>证据信息</h3>
            <dl className="definition-list">
              <dt>证据 ID</dt><dd>{evidence.id}</dd>
              <dt>所属项目</dt><dd>{evidence.projectName}</dd>
              <dt>发生时间</dt><dd>{formatDateTime(evidence.occurredAt)}</dd>
            </dl>
          </section>
        </div>
      )
    });
  };

  if (state === "loading") {
    return <><PageHeader title="工作台" description="正在汇总跨设备工作记录" /><LoadingState rows={6} /></>;
  }
  if (state === "error" && error) {
    return <><PageHeader title="工作台" description="集中查看每天的工作进展" /><ErrorState error={error} onRetry={reload} /></>;
  }
  if (state === "empty" || !dashboard) {
    return (
      <>
        <PageHeader title="工作台" description="集中查看每天的工作进展" />
        <EmptyState
          action={<Link className="button button--primary" href="/sync">配置数据源</Link>}
          description="完成设备配对并执行首次同步后，这里会展示总结、项目与同步状态。"
          icon="sync"
          title="还没有同步数据"
        />
      </>
    );
  }

  const evidenceById = new Map(
    dashboard.summary?.evidence.map((item) => [item.id, item]) ?? []
  );

  return (
    <>
      <PageHeader
        actions={
          <Link className="button button--secondary" href="/calendar">
            <Icon name="calendar" />查看日历
          </Link>
        }
        description="先看工作结论，再追溯项目、Prompt 与设备证据"
        title="工作台"
      />

      {dashboard.fixtureMode ? (
        <div className="notice" role="status">
          <Icon name="info" />
          <div><strong>演示数据模式</strong><p>当前页面使用脱敏 fixture，用于验证完整工作流。</p></div>
        </div>
      ) : null}
      {partial ? (
        <PartialNotice>
          部分设备尚未完成同步，当前总结会保留不完整标记，迟到数据到达后可重新生成。
        </PartialNotice>
      ) : null}

      <div className="dashboard-grid">
        <Surface className="surface--primary" title="今日工作总结" description={dashboard.summary ? formatWorkDate(dashboard.summary.workDate) : "等待首份总结"}>
          <div className="surface__body stack">
            {dashboard.summary ? (
              <>
                <div className="inline-actions">
                  <StatusChip tone={dashboard.summary.status === "complete" ? "success" : "warning"} icon={<Icon name={dashboard.summary.status === "complete" ? "check" : "warning"} />}>
                    {dashboard.summary.status === "complete" ? "总结完整" : "数据不完整"}
                  </StatusChip>
                  <span className="muted">{dashboard.summary.completenessNote}</span>
                </div>
                <section className="summary-section">
                  <h3>今日工作记录</h3>
                  <ul className="summary-list">
                    {dashboard.summary.highlights.map((highlight, index) => (
                      <li key={`${highlight.text}-${index}`}>
                        <span>
                          {highlight.text}
                          {highlight.evidenceIds.map((evidenceId) => {
                            const evidence = evidenceById.get(evidenceId);
                            return evidence ? (
                              <button className="text-button evidence-link" key={evidenceId} onClick={() => showEvidence(evidence)} type="button">
                                查看证据
                              </button>
                            ) : null;
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section className="summary-section">
                  <h3>项目进展</h3>
                  <ul className="summary-list">
                    {dashboard.summary.projectProgress.map((progress, index) => (
                      <li key={`${progress.text}-${index}`}>{progress.text}</li>
                    ))}
                  </ul>
                </section>
              </>
            ) : (
              <EmptyState description="同步完成后会按证据生成可追溯的工作总结。" icon="prompt" title="今天还没有总结" />
            )}
          </div>
        </Surface>

        <div className="stack">
          <Surface title="今日概览">
            <div className="surface__body metrics">
              <Metric label="活跃项目" value={formatNumber(dashboard.projects.length)} />
              <Metric label="已连接设备" value={formatNumber(dashboard.devices.length)} />
              <Metric label="待审核 Skill" value={formatNumber(dashboard.pendingSkillCount)} />
            </div>
          </Surface>
          <Surface title="Skill 待办" description="从重复工作模式中提炼">
            <div className="surface__body stack stack--tight">
              <strong>{dashboard.pendingSkillCount > 0 ? `${dashboard.pendingSkillCount} 个候选等待审核` : "暂无待审核候选"}</strong>
              <span className="muted">只有经过你确认后，Skill 才会进入发布流程。</span>
              <Link className="button button--text" href="/skills">前往 Skill 中心<Icon name="chevron-right" /></Link>
            </div>
          </Surface>
        </div>
      </div>

      <div className="page-grid page-grid--two dashboard-lower-grid">
        <Surface title="活跃项目" description="按最近活动排序">
          <div className="simple-list">
            {dashboard.projects.slice(0, 5).map((project) => (
              <Link className="simple-row" href={`/projects?project=${encodeURIComponent(project.id)}`} key={project.id}>
                <div className="simple-row__copy">
                  <strong>{project.name}</strong>
                  <span>{project.recentPrompt ? summarizeText(project.recentPrompt, 72) : "尚无 Prompt 摘要"}</span>
                </div>
                <span className="inline-actions"><span className="muted">{project.promptCount} 条</span><Icon name="chevron-right" /></span>
              </Link>
            ))}
          </div>
        </Surface>
        <Surface title="设备同步" description="Windows 与 macOS 独立采集">
          <div className="simple-list">
            {dashboard.devices.map((device) => {
              const status = deviceStatusMeta(device.status);
              return (
                <div className="simple-row" key={device.id}>
                  <div className="device-name">
                    <span className="device-icon"><Icon name="device" /></span>
                    <div className="simple-row__copy">
                      <strong>{device.name}</strong>
                      <span>{device.os === "MACOS" ? "macOS" : device.os === "WINDOWS" ? "Windows" : "其他系统"} · {formatDateTime(device.lastSyncAt)}</span>
                    </div>
                  </div>
                  <StatusChip tone={status.tone} icon={<Icon name={status.icon} />}>{status.label}</StatusChip>
                </div>
              );
            })}
          </div>
        </Surface>
      </div>
    </>
  );
}
