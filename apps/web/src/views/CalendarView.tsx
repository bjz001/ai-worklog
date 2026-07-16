"use client";

import type {
  CalendarDayView,
  CalendarResponse,
  SummaryPeriodType
} from "@ai-worklog/contracts";
import { useMemo, useState } from "react";

import { CalendarSummaryDetail } from "@/components/calendar/CalendarSummaryDetail";
import { PeriodSummaryPanel } from "@/components/calendar/PeriodSummaryPanel";
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
import { useApiResource } from "@/hooks/use-api-resource";
import { collectionState } from "@/lib/api-client";
import { formatNumber, formatWorkDate } from "@/lib/presenters";

const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
type CalendarMode = "DAY" | SummaryPeriodType;

const calendarModes: Array<{ value: CalendarMode; label: string }> = [
  { value: "DAY", label: "日总结" },
  { value: "WEEK", label: "周总结" },
  { value: "MONTH", label: "月总结" }
];

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return `${year} 年 ${month} 月`;
}

function moveMonth(key: string, offset: number): string {
  const [year, month] = key.split("-").map(Number);
  return monthKey(new Date(year, month - 1 + offset, 1));
}

function summaryMeta(status: CalendarDayView["summaryStatus"]) {
  if (status === "complete") return { label: "总结完整", tone: "success" as const, icon: "check" as const };
  if (status === "partial") return { label: "总结不完整", tone: "warning" as const, icon: "warning" as const };
  return { label: "尚无总结", tone: "neutral" as const, icon: "schedule" as const };
}

export function CalendarView() {
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [mode, setMode] = useState<CalendarMode>("DAY");
  const path = `/api/v1/calendar?month=${encodeURIComponent(month)}`;
  const { data, error, loading, reload } = useApiResource<CalendarResponse>(path);
  const { openDrawer } = useDetailDrawer();
  const days = data?.data ?? [];
  const partial = days.some((day) => day.summaryStatus === "partial" || day.hasSyncError);
  const state = collectionState({ loading, error, count: days.length, partial });
  const byDate = useMemo(() => new Map(days.map((day) => [day.date, day])), [days]);
  const [year, monthNumber] = month.split("-").map(Number);
  const count = new Date(year, monthNumber, 0).getDate();
  const leading = new Date(year, monthNumber - 1, 1).getDay();
  const cells = Array.from({ length: leading + count }, (_, index) => {
    if (index < leading) return null;
    const dayNumber = index - leading + 1;
    const date = `${month}-${String(dayNumber).padStart(2, "0")}`;
    return { date, dayNumber, activity: byDate.get(date) };
  });

  const showDay = (date: string, activity?: CalendarDayView) => {
    openDrawer({
      title: formatWorkDate(date),
      subtitle: activity ? `${activity.promptCount} 条 Prompt · ${activity.projectCount} 个项目` : "当天暂无同步记录",
      content: <CalendarSummaryDetail activity={activity} date={date} onGenerated={reload} />
    });
  };

  const actions = (
    <div className="month-switcher" aria-label="月份切换">
      <button aria-label="上个月" className="icon-button" onClick={() => setMonth((value) => moveMonth(value, -1))} type="button"><Icon name="chevron-left" /></button>
      <strong aria-live="polite">{monthLabel(month)}</strong>
      <button aria-label="下个月" className="icon-button" onClick={() => setMonth((value) => moveMonth(value, 1))} type="button"><Icon name="chevron-right" /></button>
    </div>
  );

  const modeTabs = (
    <div aria-label="总结周期" className="tabs calendar-tabs" role="tablist">
      {calendarModes.map((tab) => (
        <button
          aria-controls={`calendar-panel-${tab.value.toLowerCase()}`}
          aria-selected={mode === tab.value}
          className={`tab ${mode === tab.value ? "tab--active" : ""}`}
          id={`calendar-tab-${tab.value.toLowerCase()}`}
          key={tab.value}
          onClick={() => setMode(tab.value)}
          role="tab"
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );

  if (mode !== "DAY") {
    return (
      <>
        <PageHeader description="按日、周、月回顾 Prompt、项目和 LLM 总结" title="日历" />
        <Surface className="calendar-mode-surface">{modeTabs}</Surface>
        <PeriodSummaryPanel key={mode} periodType={mode} />
      </>
    );
  }

  if (state === "loading") {
    return (
      <>
        <PageHeader actions={actions} title="日历" description="按日期回顾 Prompt、项目和总结完整性" />
        <Surface className="calendar-mode-surface">{modeTabs}</Surface>
        <LoadingState rows={5} />
      </>
    );
  }
  if (state === "error" && error) {
    return (
      <>
        <PageHeader actions={actions} title="日历" description="按日期回顾 Prompt、项目和总结完整性" />
        <Surface className="calendar-mode-surface">{modeTabs}</Surface>
        <ErrorState error={error} onRetry={reload} />
      </>
    );
  }

  return (
    <>
      <PageHeader actions={actions} description="同一蓝色色阶表示活跃程度，状态同时使用文字和图标" title="日历" />
      <Surface className="calendar-mode-surface">{modeTabs}</Surface>
      {partial ? <PartialNotice>本月部分日期存在未完成总结或同步异常，可点击日期查看详情。</PartialNotice> : null}
      {state === "empty" ? <EmptyState description="这个月还没有同步到工作记录，可切换月份或前往同步中心。" icon="calendar" title="本月暂无活动" /> : null}
      <Surface
        aria-labelledby="calendar-tab-day"
        className="calendar-surface"
        id="calendar-panel-day"
        role="tabpanel"
        tabIndex={0}
      >
        <div aria-hidden="true" className="calendar-grid calendar-grid--header">
          {weekdays.map((weekday) => <div key={weekday}>{weekday}</div>)}
        </div>
        <div aria-label={`${monthLabel(month)}工作日历`} className="calendar-grid calendar-grid--body" role="group">
          {cells.map((cell, index) => {
            if (!cell) return <div aria-hidden="true" className="calendar-cell calendar-cell--blank" key={`blank-${index}`} />;
            const summary = summaryMeta(cell.activity?.summaryStatus ?? "missing");
            const intensity = cell.activity ? Math.min(3, Math.ceil(cell.activity.promptCount / 5)) : 0;
            return (
              <button
                aria-label={`${cell.date}，${cell.activity?.promptCount ?? 0} 条 Prompt，${summary.label}`}
                className={`calendar-cell activity-${intensity}`}
                key={cell.date}
                onClick={() => showDay(cell.date, cell.activity)}
                type="button"
              >
                <span className="calendar-cell__date">{cell.dayNumber}</span>
                {cell.activity ? (
                  <span className="calendar-cell__content">
                    <strong>{formatNumber(cell.activity.promptCount)} 条 Prompt</strong>
                    <span>{formatNumber(cell.activity.projectCount)} 个项目</span>
                    <span className={`calendar-state calendar-state--${summary.tone}`}><Icon name={cell.activity.hasSyncError ? "warning" : summary.icon} size={14} />{cell.activity.hasSyncError ? "同步异常" : summary.label}</span>
                  </span>
                ) : <span className="calendar-cell__empty">无活动</span>}
              </button>
            );
          })}
        </div>
      </Surface>
    </>
  );
}
