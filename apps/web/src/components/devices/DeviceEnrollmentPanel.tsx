"use client";

import {
  DeviceEnrollmentResponseSchema,
  type DeviceEnrollmentResponse,
  type DevicePlatform,
  type DeviceView
} from "@ai-worklog/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { ApiRequestError, mutateApi } from "@/lib/api-client";

import { DeviceSetupInstructions } from "./DeviceSetupInstructions";

export function DeviceEnrollmentPanel({
  device,
  onComplete
}: {
  device?: DeviceView;
  onComplete: () => void;
}) {
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<DevicePlatform>("MACOS");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DeviceEnrollmentResponse["data"] | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const rotating = Boolean(device && device.status !== "NOT_CONFIGURED");

  useEffect(() => () => requestRef.current?.abort(), []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (rotating && !confirmed) return;
    setSubmitting(true);
    setError("");
    const controller = new AbortController();
    requestRef.current = controller;

    try {
      const payload = await mutateApi<unknown>(
        device ? `/api/v1/devices/${encodeURIComponent(device.id)}/token` : "/api/v1/devices",
        {
          body: device ? {} : { name: name.trim(), platform },
          method: "POST",
          signal: controller.signal
        }
      );
      const parsed = DeviceEnrollmentResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("INVALID_RESPONSE");
      const response = parsed.data.data;
      const expectedPlatform = device?.os ?? platform;
      if (
        response.enrollment.deviceId !== response.device.id ||
        response.device.os !== expectedPlatform ||
        (device && response.device.id !== device.id)
      ) {
        throw new Error("INVALID_RESPONSE");
      }
      setResult(response);
      onComplete();
    } catch (requestError) {
      if (controller.signal.aborted) return;
      setError(
        requestError instanceof ApiRequestError
          ? requestError.message
          : "配置生成失败，请稍后重试。"
      );
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  };

  if (result) {
    const resultPlatform = result.device.os === "WINDOWS" ? "WINDOWS" : "MACOS";
    return (
      <DeviceSetupInstructions
        enrollment={result.enrollment}
        mode={device ? "ROTATE" : "INITIAL"}
        platform={resultPlatform}
      />
    );
  }

  if (device?.os === "OTHER") {
    return <p className="form-feedback form-feedback--error" role="alert">当前仅支持 macOS 和 Windows 采集器。</p>;
  }

  return (
    <form className="device-enrollment-form" onSubmit={submit}>
      {device ? (
        <section className="device-enrollment-target">
          <h3>{device.name}</h3>
          <p className="muted">{device.os === "WINDOWS" ? "Windows" : "macOS"} · 设备 ID {device.id}</p>
        </section>
      ) : (
        <>
          <label className="form-field">
            <span>设备名称</span>
            <input
              autoComplete="off"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：办公室 Windows"
              required
              value={name}
            />
          </label>
          <label className="form-field">
            <span>操作系统</span>
            <select onChange={(event) => setPlatform(event.target.value as DevicePlatform)} value={platform}>
              <option value="MACOS">macOS</option>
              <option value="WINDOWS">Windows</option>
            </select>
          </label>
        </>
      )}

      {rotating ? (
        <div className="device-rotation-warning" role="alert">
          <div><Icon name="warning" /><p><strong>原 Token 会立即失效</strong><span>这台设备的旧配置将无法继续同步，必须完成新配置。</span></p></div>
          <label><input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />我了解并要重新生成凭证</label>
        </div>
      ) : null}

      <p aria-live="polite" className={error ? "form-feedback form-feedback--error" : "sr-only"} role={error ? "alert" : "status"}>
        {error || (submitting ? "正在生成一次性设备凭证…" : "")}
      </p>
      <div className="form-actions">
        <button className="button button--primary" disabled={submitting || (!device && !name.trim()) || (rotating && !confirmed)} type="submit">
          <Icon name={submitting ? "sync" : "device"} />
          {submitting ? "正在生成…" : rotating ? "确认重新生成" : "生成在线配置"}
        </button>
      </div>
    </form>
  );
}
