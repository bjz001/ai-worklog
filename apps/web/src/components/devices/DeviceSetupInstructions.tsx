"use client";

import type { DeviceEnrollment, DevicePlatform } from "@ai-worklog/contracts";
import { useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { copyText } from "@/lib/copy-text";
import { buildDeviceSetup, type DeviceSetupMode } from "@/lib/device-setup";

function CopyButton({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async () => {
    try {
      await copyText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };

  return (
    <>
      <button className="button button--secondary device-copy-button" onClick={copy} type="button">
        <Icon name="code" />
        {state === "copied" ? "已复制" : state === "failed" ? "复制失败" : label}
      </button>
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? `${label}成功` : state === "failed" ? `${label}失败，请手动复制` : ""}
      </span>
    </>
  );
}

function CommandBlock({
  description,
  label,
  text
}: {
  description: string;
  label: string;
  text: string;
}) {
  return (
    <section className="device-setup-command">
      <header>
        <div><h3>{label}</h3><p>{description}</p></div>
        <CopyButton label={`复制${label}`} text={text} />
      </header>
      <pre tabIndex={0}><code>{text}</code></pre>
    </section>
  );
}

export function DeviceSetupInstructions({
  enrollment,
  mode,
  platform
}: {
  enrollment: DeviceEnrollment;
  mode: DeviceSetupMode;
  platform: DevicePlatform;
}) {
  const setup = buildDeviceSetup(platform, enrollment, mode);

  return (
    <div className="device-setup-results">
      <div className="device-secret" role="status">
        <strong>设备 Token 仅显示这一次</strong>
        <p>先复制 Token；关闭面板后无法找回，只能重新生成。</p>
        <code>{enrollment.deviceToken}</code>
        <CopyButton label="复制 Token" text={enrollment.deviceToken} />
      </div>

      <section className="drawer-section">
        <h3>设备信息</h3>
        <dl className="definition-list">
          <dt>账号 ID</dt><dd>{enrollment.accountId}</dd>
          <dt>设备 ID</dt><dd>{enrollment.deviceId}</dd>
          <dt>同步地址</dt><dd>{enrollment.syncUrl}</dd>
          <dt>配置文件</dt><dd>{setup.configPath}</dd>
        </dl>
      </section>

      <div className="notice notice--warning device-token-prompt-note">
        <Icon name="warning" />
        <p>
          {mode === "ROTATE"
            ? "命令会安全保留现有来源标识、路径、HMAC 密钥和采集数据库，仅替换在线凭据。"
            : "在项目根目录运行命令，首次配置会创建默认来源路径。"}
          命令显示“设备 Token”隐藏输入后，粘贴上方 Token 并回车。
        </p>
      </div>

      <CommandBlock
        description={mode === "ROTATE"
          ? "保留本地采集身份和历史存储，替换账号、设备、同步地址和 Token。"
          : "写入仅当前用户可读的本机配置。"}
        label="1. 生成配置"
        text={setup.configureCommand}
      />
      <CommandBlock
        description="先检查配置，再执行首次同步。"
        label="2. 验证并同步"
        text={setup.validateCommand}
      />
      <CommandBlock
        description={platform === "MACOS"
          ? "通过后安装每天 18:00 自动同步。"
          : "通过后安装每天 23:30 自动同步。"}
        label="3. 安装定时任务"
        text={setup.installCommand}
      />
    </div>
  );
}
