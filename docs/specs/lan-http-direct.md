# Spec: 可信局域网内直接 HTTP 同步

## Objective

让 Windows 采集器通过 `http://172.18.209.21:3000/api/v1/sync/batches`
同步到 Mac 中心端，不使用 Nginx、Docker、证书或本地 CA。

## Boundaries

- 服务只绑定 `172.18.209.21`，不绑定 `0.0.0.0`，不做公网端口映射。
- Dashboard 继续使用 Basic Auth，同步接口继续使用独立设备 Token。
- 非 localhost 的 HTTP 必须通过 `AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP=true`
  显式启用，且目标只能是 RFC1918 私网 IPv4。
- Windows 不连接 MySQL，只访问 Mac 的同步 API。
- 局域网 HTTP 是明文传输；如果网络不再可信，必须重新启用 HTTPS。

## Implementation

- 使用 Next.js 内置生产服务器监听固定 IP 和 3000 端口。
- macOS LaunchAgent 在当前用户登录后常驻服务，失败后自动重启。
- `.env.local` 的 `APP_BASE_URL` 更新为 LAN origin，文件继续保持 mode 0600。
- Mac 与 Windows 的采集调度器只在显式开关为 true 且目标是私网 IPv4 时接受 HTTP。

## Success Criteria

- Mac 登录后 `com.ai-worklog.web` 监听 `172.18.209.21:3000`。
- 未认证访问 Dashboard 返回 401，带现有 Dashboard 凭据访问返回 200。
- Windows dry-run 通过，首次真实同步清空现有 Outbox 后再安装 23:30 计划任务。
- 服务不监听公网/所有接口，Git 中没有新增任何凭据。

## Rollback

1. 执行 `bash scripts/schedules/macos-web/uninstall.sh`。
2. 将 `.env.local` 的 `APP_BASE_URL` 恢复为 `http://127.0.0.1:3000`。
3. Windows 暂停计划任务；Outbox 保留，恢复服务后继续重试。
