"use client";

import type { SkillCandidateView, SkillsResponse } from "@ai-worklog/contracts";
import { useMemo, useState } from "react";

import { useDetailDrawer } from "@/components/shell/DrawerContext";
import { Icon } from "@/components/ui/Icon";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  PartialNotice,
  Surface
} from "@/components/ui/PageElements";
import { StatusChip } from "@/components/ui/StatusChip";
import { useApiResource } from "@/hooks/use-api-resource";
import { collectionState } from "@/lib/api-client";
import { formatNumber, summarizeText } from "@/lib/presenters";

type SkillStatusFilter = "all" | SkillCandidateView["status"];

const statusLabels: Record<SkillCandidateView["status"], string> = {
  candidate: "待审核",
  ignored: "已忽略",
  accepted: "已采纳"
};

const tabs: Array<{ value: SkillStatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "candidate", label: "候选" },
  { value: "accepted", label: "已采纳" },
  { value: "ignored", label: "已忽略" }
];

export function SkillsView() {
  const { data, error, loading, reload } =
    useApiResource<SkillsResponse>("/api/v1/skills");
  const { openDrawer } = useDetailDrawer();
  const [filter, setFilter] = useState<SkillStatusFilter>("all");
  const skills = data?.data ?? [];
  const incomplete = skills.some((skill) => skill.evidenceCount === 0);
  const state = collectionState({ loading, error, count: skills.length, partial: incomplete });
  const visibleSkills = useMemo(
    () => filter === "all" ? skills : skills.filter((skill) => skill.status === filter),
    [filter, skills]
  );

  const showSkill = (skill: SkillCandidateView) => {
    openDrawer({
      title: skill.name,
      subtitle: `${statusLabels[skill.status]} · ${formatNumber(skill.evidenceCount)} 条证据`,
      content: (
        <div className="stack">
          <section className="drawer-section">
            <h3>用途说明</h3>
            <p>{skill.description}</p>
          </section>
          <section className="drawer-section">
            <h3>建议变更</h3>
            {skill.diff.length > 0 ? (
              <div aria-label="Skill 变更对比" className="diff">
                {skill.diff.map((line, index) => {
                  const marker = line.type === "add" ? "+" : line.type === "remove" ? "−" : " ";
                  return <div className={`diff-line diff-line--${line.type}`} key={`${line.text}-${index}`}><span aria-hidden="true">{marker}</span><code>{line.text}</code></div>;
                })}
              </div>
            ) : <p className="muted">当前候选还没有可展示的补丁内容。</p>}
          </section>
          <section className="drawer-section">
            <h3>来源证据</h3>
            {skill.evidenceIds.length > 0 ? (
              <ul className="drawer-list">{skill.evidenceIds.map((id) => <li key={id}><Icon name="evidence" size={16} />{id}</li>)}</ul>
            ) : <p className="muted">缺少来源证据，暂不能采纳。</p>}
          </section>
          <div className="stack stack--tight">
            <div className="inline-actions">
              <button className="button button--primary" disabled type="button">采纳候选</button>
              <button className="button button--secondary" disabled type="button">忽略</button>
            </div>
            <small className="muted">写入与审核 API 接通前，候选操作保持禁用，系统不会修改真实 Skill 目录。</small>
          </div>
        </div>
      )
    });
  };

  if (state === "loading") return <><PageHeader title="Skill 中心" description="用真实证据沉淀可复用工作方法" /><LoadingState rows={6} /></>;
  if (state === "error" && error) return <><PageHeader title="Skill 中心" description="用真实证据沉淀可复用工作方法" /><ErrorState error={error} onRetry={reload} /></>;
  if (state === "empty") return <><PageHeader title="Skill 中心" description="用真实证据沉淀可复用工作方法" /><EmptyState description="系统会根据重复任务模式和人工标记生成带证据的 Skill 候选。" icon="skill" title="暂无 Skill 候选" /></>;

  return (
    <>
      <PageHeader description="每项候选都保留证据、Diff 与人工审核边界" title="Skill 中心" />
      {incomplete ? <PartialNotice>部分候选缺少来源证据，已禁止采纳，请等待更多工作记录或人工补充。</PartialNotice> : null}
      <Surface>
        <div aria-label="Skill 状态筛选" className="tabs" role="tablist">
          {tabs.map((tab) => (
            <button aria-selected={filter === tab.value} className={`tab ${filter === tab.value ? "tab--active" : ""}`} key={tab.value} onClick={() => setFilter(tab.value)} role="tab" type="button">{tab.label}</button>
          ))}
        </div>
        {visibleSkills.length === 0 ? (
          <EmptyState description="当前状态下没有 Skill，可切换到其他页签。" icon="filter" title="没有匹配的 Skill" />
        ) : (
          <div className="inbox-list skill-list">
            {visibleSkills.map((skill) => (
              <button className="inbox-row" key={skill.id} onClick={() => showSkill(skill)} type="button">
                <div className="inbox-row__primary"><strong>{skill.name}</strong><span>{statusLabels[skill.status]}</span></div>
                <div className="inbox-row__summary"><strong>{summarizeText(skill.description, 100)}</strong><span>{skill.diff.length} 行建议变更</span></div>
                <div className="inbox-row__meta"><StatusChip tone={skill.evidenceCount > 0 ? "info" : "warning"} icon={<Icon name={skill.evidenceCount > 0 ? "evidence" : "warning"} />}>{skill.evidenceCount} 条证据</StatusChip></div>
                <Icon name="chevron-right" />
              </button>
            ))}
          </div>
        )}
      </Surface>
    </>
  );
}
