# AI Worklog 每日采集与同步

这套脚本在 macOS 和 Windows 的本地时区每天 23:30 按固定顺序执行三步：采集 Codex、采集 Claude Code，最后将本地 Outbox 中的待同步批次以有界批量发送到中央 API。两种本地数据源都使用同一个本机 `AI_WORKLOG_DEVICE_ID`，但使用不同的 source instance 和路径。采集器在写入 Outbox 前脱敏。

中央服务所在的 Mac 可另外安装一个每天 23:40 的总结 Worker LaunchAgent。该任务永远调用无参数的有界默认模式，最多处理当天与有待处理任务的昨天；它不会自动传入历史回补参数。

两台机器使用同一个账号和 API，但必须使用不同的 `AI_WORKLOG_DEVICE_ID`、两组 source instance 以及设备令牌。这样 Windows 和 macOS 的数据会汇总到同一账号，同时仍能区分设备和工具来源。

采集调度器不读取项目的 `.env.local`，也不将令牌写入 plist 或 Task Scheduler 参数。它们只引用仓库外的专用配置文件；配置按数据解析，不会被 shell 或 PowerShell 执行。中央 Worker 在项目根目录中运行，由应用自身读取权限受限的 `.env.local`；Worker plist 与命令行只包含脚本、项目根目录和 Node.js 的绝对路径，不包含 MySQL 或 LLM 凭证。

## 准备配置

先在项目根目录执行 `npm install`。复制 [collector.env.example](./scripts/schedules/collector.env.example) 到仓库外，然后填写本机配置：

- `AI_WORKLOG_ACCOUNT_ID`：两台机器保持一致。
- `AI_WORKLOG_DEVICE_ID`：每台机器唯一。
- 该 ID 必须与中心端 Token 的绑定一致：默认 Seed 中 Mac 为 `device_macos_demo` + `MACOS_DEVICE_TOKEN`，Windows 为 `device_windows_demo` + `WINDOWS_DEVICE_TOKEN`；自定义时使用 `MACOS_DEVICE_ID` / `WINDOWS_DEVICE_ID` 后重新 Seed。
- `CODEX_SOURCE_INSTANCE_ID`：本机 Codex 数据源的唯一标识。
- `CODEX_SOURCE_PATH`：本机明确授权的 `.jsonl` 文件或目录的绝对路径。
- `CLAUDE_CODE_SOURCE_INSTANCE_ID`：本机 Claude Code 数据源的唯一标识，不能与 Codex 的标识相同。
- `CLAUDE_CODE_SOURCE_PATH`：本机明确授权的 Claude Code `.jsonl` 文件或目录的绝对路径，不能与 Codex 路径相同。
- `AI_WORKLOG_PATH_HMAC_KEY`：用于不可逆标识本地路径的随机值。
- `COLLECTOR_DB_PATH`：本机 SQLite Outbox 绝对路径。
- `AI_WORKLOG_SYNC_URL`：两台机器指向同一个同步端点。
- `AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP`：仅当中心服务位于可信 RFC1918 私网且使用 HTTP 时设为 `true`；公网地址仍会被拒绝。
- `AI_WORKLOG_DEVICE_TOKEN`：每台机器独立的令牌。
- `NODE_BINARY`：Node.js 可执行文件的绝对路径，推荐填写。

配置文件不支持 `export`、变量展开或多行值。如果值两端使用同类引号，解析器会去掉外层引号，但不会执行其中内容。

## 中央 Mac Web（无 Nginx、无证书）

可信局域网内自用时，中央 Mac 可以让 Next.js 直接监听固定地址 `http://172.18.209.21:3000`，不需要 Nginx、Docker、证书或本地 CA。该 IP 应由路由器做 DHCP 保留；服务只绑定这个 IP，不绑定 `0.0.0.0`，也不要把 3000 端口映射到公网。

先安全更新 `.env.local` 的 `APP_BASE_URL`，再重建 Web 与 Mac 采集器配置：

```bash
npm run lan:http:configure -- --host 172.18.209.21 --port 3000
npm run collector:configure:macos
chmod 600 .env.local
npm run build
bash scripts/schedules/macos-runtime/deploy.sh \
  --node "$(command -v node)" --dry-run
bash scripts/schedules/macos-runtime/deploy.sh \
  --node "$(command -v node)"
```

macOS 不允许后台 LaunchAgent 直接读取 Desktop 等隐私目录，因此部署脚本会把只用于运行的副本同步到 `~/Library/Application Support/AIWorklog/app`。开发和 Git 仍在原仓库；每次拉取代码、改配置或重新构建后，再运行一次部署脚本。部署器先取得独占部署锁并拒绝软链接目标，再在同一目录完成临时副本与 Web 配置校验；切换前会占用采集器和 Worker 共用的互斥锁、临时禁用新触发，仅停止 Web，随后恢复服务和调度。若新 Web 未能返回预期的 `401`，会回滚旧副本。采集器或 Worker 正在执行时，部署器无法取得互斥锁并会安全退出，不会中断当次任务。

从运行副本验证并安装登录后常驻的 LaunchAgent：

```bash
RUNTIME="$HOME/Library/Application Support/AIWorklog/app"
bash "$RUNTIME/scripts/schedules/macos-web/run.sh" \
  --node "$(command -v node)" --validate-only
bash "$RUNTIME/scripts/schedules/macos-web/install.sh" \
  --node "$(command -v node)" --dry-run
bash "$RUNTIME/scripts/schedules/macos-web/install.sh" \
  --node "$(command -v node)"
```

未带 Dashboard Basic Auth 访问 `http://172.18.209.21:3000/` 应返回 `401`。`com.ai-worklog.web` 在当前 macOS 用户登录后保持常驻；日志位于 `~/Library/Logs/AIWorklog/web-service.log` 和 `web-service-error.log`。卸载不会删除 `.env.local`、数据库或日志：

```bash
RUNTIME="$HOME/Library/Application Support/AIWorklog/app"
bash "$RUNTIME/scripts/schedules/macos-web/uninstall.sh" --dry-run
bash "$RUNTIME/scripts/schedules/macos-web/uninstall.sh"
```

此模式是局域网明文传输，设备 Token 和同步内容不会被 TLS 加密。只应在你信任的家庭/办公内网使用；网络不可信或需要公网访问时应改回 HTTPS。

## macOS（launchd）

若中心服务与当前 Mac 共用本项目的 `.env.local`，可以直接生成配置（不会回显令牌）：

```bash
npm run collector:configure:macos
RUNTIME="$HOME/Library/Application Support/AIWorklog/app"
bash "$RUNTIME/scripts/schedules/macos/run.sh" --validate-only
```

否则按下面步骤手工创建。

创建私有配置：

```bash
mkdir -p "$HOME/.config/ai-worklog"
install -m 600 scripts/schedules/collector.env.example \
  "$HOME/.config/ai-worklog/collector.env"
# 然后编辑 ~/.config/ai-worklog/collector.env，替换所有占位值
```

先做无网络、无采集的验证，再安装 LaunchAgent：

```bash
RUNTIME="$HOME/Library/Application Support/AIWorklog/app"
bash "$RUNTIME/scripts/schedules/macos/run.sh" \
  --config "$HOME/.config/ai-worklog/collector.env" --dry-run
bash "$RUNTIME/scripts/schedules/macos/install.sh" \
  --config "$HOME/.config/ai-worklog/collector.env" --dry-run
bash "$RUNTIME/scripts/schedules/macos/install.sh" \
  --config "$HOME/.config/ai-worklog/collector.env"
```

手动执行一次采集和同步：

```bash
RUNTIME="$HOME/Library/Application Support/AIWorklog/app"
bash "$RUNTIME/scripts/schedules/macos/run.sh" \
  --config "$HOME/.config/ai-worklog/collector.env"
```

安全日志在 `~/Library/Logs/AIWorklog/`，只记录阶段、状态和 UTC 时间，不记录令牌、提示词正文或响应正文。卸载：

```bash
RUNTIME="$HOME/Library/Application Support/AIWorklog/app"
bash "$RUNTIME/scripts/schedules/macos/uninstall.sh" --dry-run
bash "$RUNTIME/scripts/schedules/macos/uninstall.sh"
```

## 中央 Mac 总结 Worker（launchd）

只在运行中央 Web/Worker 和 MySQL 连接配置的 Mac 上安装。先在项目根目录安装依赖，确认 `.env.local` 由当前用户所有，并禁止组和其他用户读取：

```bash
npm install
chmod 600 .env.local
```

以下验证和 dry-run 只检查文件、权限、项目路径和 Node.js 绝对路径，不连接 MySQL、不调用 LLM，也不启动 Worker：

```bash
RUNTIME="$HOME/Library/Application Support/AIWorklog/app"
bash "$RUNTIME/scripts/schedules/macos-worker/run.sh" \
  --node "$(command -v node)" --validate-only
bash "$RUNTIME/scripts/schedules/macos-worker/run.sh" \
  --node "$(command -v node)" --dry-run
bash "$RUNTIME/scripts/schedules/macos-worker/install.sh" \
  --node "$(command -v node)" --dry-run
```

确认输出为成功状态后再安装每天 23:40 的 LaunchAgent：

```bash
RUNTIME="$HOME/Library/Application Support/AIWorklog/app"
bash "$RUNTIME/scripts/schedules/macos-worker/install.sh" \
  --node "$(command -v node)"
```

安装器会把当前项目根目录写入 `WorkingDirectory`，并把当前 Node.js 可执行文件的绝对路径写入 plist，因此不依赖 launchd 的最小 `PATH`。每次调度只执行无参数 Worker，并使用 `~/Library/Caches/AIWorklog/worker-schedule.lock` 防止重叠运行。标准输出与错误日志分别写入 `~/Library/Logs/AIWorklog/worker-schedule.log` 和 `worker-schedule-error.log`，只包含阶段、状态和 UTC 时间。

移动项目目录或更换 Node.js 后必须重新安装。卸载不会删除 `.env.local`、数据库或日志：

```bash
RUNTIME="$HOME/Library/Application Support/AIWorklog/app"
bash "$RUNTIME/scripts/schedules/macos-worker/uninstall.sh" --dry-run
bash "$RUNTIME/scripts/schedules/macos-worker/uninstall.sh"
```

## Windows（Task Scheduler）

在普通用户 PowerShell 中创建配置并收紧 ACL：

```powershell
$Config = Join-Path $env:LOCALAPPDATA "AIWorklog\collector.env"
New-Item -ItemType Directory -Path (Split-Path $Config) -Force | Out-Null
Copy-Item ".\scripts\schedules\collector.env.example" $Config
$CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $Config /inheritance:r | Out-Null
icacls $Config /grant:r "*$($CurrentSid):(R,W)" "*S-1-5-18:(R)" "*S-1-5-32-544:(R)" | Out-Null
# 然后编辑 $Config，替换所有占位值
```

在现有 `collector.env` 中设置：

```text
AI_WORKLOG_SYNC_URL=http://172.18.209.21:3000/api/v1/sync/batches
AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP=true
```

该显式开关只允许 RFC1918 私网 IPv4；即使设为 `true`，公网 HTTP 仍会被拒绝。

配置文件的所有者必须是当前用户，具有读权限的身份只能是当前用户、SYSTEM 和 Administrators。然后验证并安装每天 23:30 的任务：

```powershell
& ".\scripts\schedules\windows\Run.ps1" -ConfigPath $Config -DryRun
& ".\scripts\schedules\windows\Run.ps1" -ConfigPath $Config
& ".\scripts\schedules\windows\Install.ps1" -ConfigPath $Config -DryRun
& ".\scripts\schedules\windows\Install.ps1" -ConfigPath $Config
```

先完成一次真实同步，确认已有 Outbox 批次上传成功，再安装计划任务。Windows 不需要 MySQL、Nginx、证书或 Docker；它只向 Mac 的 HTTP API 上传脱敏后的批次。

该任务以当前用户的有限权限运行，不会请求管理员权限。当 23:30 时用户未登录，任务会在下次可用时尝试执行。安全日志在 `%LOCALAPPDATA%\AIWorklog\logs\schedule.log`。卸载：

```powershell
& ".\scripts\schedules\windows\Uninstall.ps1" -DryRun
& ".\scripts\schedules\windows\Uninstall.ps1"
```

## 运行特性与排查

- 配置校验失败时只输出通用状态，不回显配置行或值。
- 同一台机器不会并发运行多个采集任务。
- 每次严格尝试 `CODEX prepare` 一次、`CLAUDE_CODE prepare` 一次、`sync` 一次。单个来源或文件失败不会阻止另一来源，也不会阻止已有 Outbox 的同步。
- 任一阶段失败时，调度最终记录 `partial` 并以非零状态退出。
- 上传失败的批次保留在本地 Outbox，下次运行继续重试。
- 移动项目目录、Node.js 路径或配置文件后，需重新执行安装脚本。
- 卸载仅删除调度任务，不删除配置、Outbox 和日志。
- 中央 Mac Worker 使用独立的内核文件锁；重叠调度会安全跳过，进程正常退出或崩溃后锁都由内核自动释放，保留的空锁文件可安全复用。
- 中央 Mac Worker 永远走默认有界模式；历史回补必须由操作者在项目根目录手动显式执行。
- Mac 睡眠、退出登录、IP 改变或不在线时，Windows 同步会失败但 Outbox 会保留，下次继续幂等重试。

静态校验（不连接远程、不启动 Docker）：

```bash
bash scripts/schedules/tests/static-test.sh
```
