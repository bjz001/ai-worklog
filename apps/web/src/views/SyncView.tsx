"use client";

import type { DeviceView, SyncResponse, SyncRunView } from "@ai-worklog/contracts";

import { DeviceEnrollmentPanel } from "@/components/devices/DeviceEnrollmentPanel";
import { DeviceList } from "@/components/devices/DeviceList";
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
import { formatDateTime, formatNumber } from "@/lib/presenters";

function runStatusMeta(status: SyncRunView["status"]) {
  if (status === "SUCCESS") return { label: "成功", tone: "success" as const, icon: "check" as const };
  if (status === "PARTIAL") return { label: "部分成功", tone: "warning" as const, icon: "warning" as const };
  return { label: "失败", tone: "danger" as const, icon: "error" as const };
}

export function SyncView() {
  const { data, error, loading, reload } = useApiResource<SyncResponse>("/api/v1/sync");
  const { openDrawer } = useDetailDrawer();
  const sync = data?.data;
  const count = sync ? sync.devices.length + sync.runs.length : 0;
  const partial = Boolean(
    sync?.devices.some((device) => ["PARTIAL", "FAILED", "OFFLINE"].includes(device.status)) ||
      sync?.runs.some((run) => run.status !== "SUCCESS")
  );
  const state = collectionState({ loading, error, count, partial });
  const deviceNames = new Map(sync?.devices.map((device) => [device.id, device.name]) ?? []);

  const showEnrollment = (device?: DeviceView) => {
    openDrawer({
      title: device ? `${device.name} · ${device.status === "NOT_CONFIGURED" ? "生成配置" : "重新生成配置"}` : "添加同步设备",
      subtitle: device ? "新 Token 只会显示一次" : "登记 macOS 或 Windows 采集器",
      content: <DeviceEnrollmentPanel device={device} onComplete={reload} />
    });
  };

  const showRun = (run: SyncRunView) => {
    const status = runStatusMeta(run.status);
    openDrawer({
      title: deviceNames.get(run.deviceId) ?? "未知设备",
      subtitle: `${status.label} · ${formatDateTime(run.startedAt)}`,
      content: (
        <div className="stack">
          <section className="drawer-section">
            <StatusChip tone={status.tone} icon={<Icon name={status.icon} />}>{status.label}</StatusChip>
          </section>
          <section className="drawer-section">
            <h3>同步统计</h3>
            <div className="metrics">
              <Metric label="接收" value={formatNumber(run.receivedCount)} />
              <Metric label="新增" value={formatNumber(run.insertedCount)} />
              <Metric label="去重" value={formatNumber(run.duplicateCount)} />
            </div>
          </section>
          <section className="drawer-section">
            <h3>运行信息</h3>
            <dl className="definition-list">
              <dt>运行 ID</dt><dd>{run.id}</dd>
              <dt>开始时间</dt><dd>{formatDateTime(run.startedAt)}</dd>
              <dt>完成时间</dt><dd>{formatDateTime(run.completedAt)}</dd>
              <dt>错误码</dt><dd>{run.errorCode ?? "无"}</dd>
            </dl>
          </section>
        </div>
      )
    });
  };

  if (state === "loading") return <><PageHeader title="同步中心" description="管理设备、数据源与增量同步状态" /><LoadingState rows={6} /></>;
  if (state === "error" && error) return <><PageHeader title="同步中心" description="管理设备、数据源与增量同步状态" /><ErrorState error={error} onRetry={reload} /></>;
  if (state === "empty" || !sync) return <><PageHeader title="同步中心" description="管理设备、数据源与增量同步状态" /><EmptyState action={<button className="button button--primary" onClick={() => showEnrollment()} type="button"><Icon name="device" />添加设备</button>} description="在线登记 Windows 或 macOS 设备，再按指引完成首次同步。" icon="sync" title="尚未连接设备" /></>;

  return (
    <>
      <PageHeader
        actions={<><button className="button button--secondary" onClick={() => showEnrollment()} type="button"><Icon name="device" />添加设备</button><button className="button button--primary" onClick={reload} type="button"><Icon name="refresh" />刷新状态</button></>}
        description="每台设备独立采集与补传，单机失败不会阻断其他设备"
        title="同步中心"
      />
      {partial ? <PartialNotice>部分设备离线或最近运行未完全成功，其他设备的数据仍可正常浏览。</PartialNotice> : null}

      <Surface className="sync-callout" description="采集器只读本机记录；仅上传完整、不脱敏的用户 Prompt。" title="立即同步" >
        <div className="surface__body sync-callout__body" id="run-now">
          <div><strong>在对应设备执行采集器同步</strong><p className="muted">当前中心端展示同步状态；设备端使用 <code>collector sync</code> 发起上传。</p></div>
          <button className="button button--secondary" onClick={reload} type="button"><Icon name="sync" />检查最新结果</button>
        </div>
      </Surface>

      <div className="page-grid page-grid--two sync-grid">
        <Surface title="设备" description={`${formatNumber(sync.devices.length)} 台已登记设备`}>
          <DeviceList devices={sync.devices} onConfigure={showEnrollment} />
        </Surface>

        <Surface title="最近运行" description="日志不展示 Prompt 正文或敏感路径">
          <div className="simple-list">
            {sync.runs.map((run) => {
              const status = runStatusMeta(run.status);
              return (
                <button className="simple-row simple-row--button" key={run.id} onClick={() => showRun(run)} type="button">
                  <div className="simple-row__copy"><strong>{deviceNames.get(run.deviceId) ?? "未知设备"}</strong><span>{formatDateTime(run.startedAt)} · 新增 {formatNumber(run.insertedCount)} 条</span></div>
                  <span className="inline-actions"><StatusChip tone={status.tone} icon={<Icon name={status.icon} />}>{status.label}</StatusChip><Icon name="chevron-right" /></span>
                </button>
              );
            })}
          </div>
        </Surface>
      </div>
    </>
  );
}
