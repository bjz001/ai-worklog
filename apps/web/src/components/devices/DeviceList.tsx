import type { DeviceView } from "@ai-worklog/contracts";

import { Icon } from "@/components/ui/Icon";
import { StatusChip } from "@/components/ui/StatusChip";
import { deviceStatusMeta, formatDateTime, formatNumber } from "@/lib/presenters";

export function DeviceList({
  devices,
  onConfigure
}: {
  devices: DeviceView[];
  onConfigure: (device: DeviceView) => void;
}) {
  return (
    <div className="simple-list">
      {devices.map((device) => {
        const status = deviceStatusMeta(device.status);
        const supported = device.os === "MACOS" || device.os === "WINDOWS";
        return (
          <div className="simple-row device-row" key={device.id}>
            <div className="device-name">
              <span className="device-icon"><Icon name="device" /></span>
              <div className="simple-row__copy">
                <strong>{device.name}</strong>
                <span>{device.os === "MACOS" ? "macOS" : device.os === "WINDOWS" ? "Windows" : "其他系统"} · {formatNumber(device.promptCount)} 条 Prompt</span>
              </div>
            </div>
            <div className="device-row__actions">
              <div className="device-status">
                <StatusChip tone={status.tone} icon={<Icon name={status.icon} />}>{status.label}</StatusChip>
                <span className="muted">{formatDateTime(device.lastSyncAt)}</span>
              </div>
              {supported ? (
                <button
                  aria-label={`${device.status === "NOT_CONFIGURED" ? "生成" : "重新生成"} ${device.name} 的配置`}
                  className="button button--text device-configure-button"
                  onClick={() => onConfigure(device)}
                  type="button"
                >
                  {device.status === "NOT_CONFIGURED" ? "生成配置" : "重新生成配置"}
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
