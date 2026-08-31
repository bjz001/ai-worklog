import type { AgentSourceType } from "@ai-worklog/contracts";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export type DeviceStatus =
  | "NOT_CONFIGURED"
  | "WAITING"
  | "SYNCING"
  | "SUCCESS"
  | "PARTIAL"
  | "OFFLINE"
  | "FAILED";

export type StatusIconName =
  | "settings"
  | "schedule"
  | "sync"
  | "check"
  | "warning"
  | "offline"
  | "error";

export function formatDateTime(
  value: string | null,
  timeZone?: string
): string {
  if (!value) return "尚未同步";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";

  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone
  }).format(date);
}

export function formatWorkDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short"
  }).format(date);
}

export function formatSource(source: AgentSourceType): string {
  return {
    CODEX: "Codex",
    CLAUDE_CODE: "Claude Code",
    ZCODE: "ZCode",
    DSH: "DSH"
  }[source];
}

export function deviceStatusMeta(status: DeviceStatus): {
  label: string;
  tone: Tone;
  icon: StatusIconName;
} {
  const statuses: Record<
    DeviceStatus,
    { label: string; tone: Tone; icon: StatusIconName }
  > = {
    NOT_CONFIGURED: { label: "未配置", tone: "neutral", icon: "settings" },
    WAITING: { label: "等待同步", tone: "neutral", icon: "schedule" },
    SYNCING: { label: "同步中", tone: "info", icon: "sync" },
    SUCCESS: { label: "同步成功", tone: "success", icon: "check" },
    PARTIAL: { label: "部分成功", tone: "warning", icon: "warning" },
    OFFLINE: { label: "设备离线", tone: "neutral", icon: "offline" },
    FAILED: { label: "同步失败", tone: "danger", icon: "error" }
  };

  return statuses[status];
}

export function summarizeText(value: string, maxLength = 96): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}
