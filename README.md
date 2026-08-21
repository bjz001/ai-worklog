# AI 工作沉淀台

一个面向个人的跨设备 Agent 工作记录工具。Windows 和 macOS 只读采集 Codex、Claude Code、Z.ai ZCode 与 DeepSeek Harness（DSH）的完整会话事件，以不脱敏、不截断的 protocol v2 同步到中心服务，按 Git Remote 归并项目，支持全文搜索、Agent Loop 时间线、工作总结和 Skill 候选。来源未暴露的隐藏内容只标记 `NOT_EXPOSED`，不猜测或补全。

```mermaid
flowchart LR
  W["Windows<br/>四类 Agent"] -->|"原始事件 + 分块 Blob"| A["中心 API"]
  M["macOS<br/>四类 Agent"] -->|"原始事件 + 分块 Blob"| A
  A --> D[("MySQL 8<br/>ai_worklog")]
  D --> U["工作台 / 项目 / 日历<br/>Agent 轨迹 / Skill / 同步中心"]
  D --> K["中央 Worker"]
  K --> L["DeepSeek / OpenAI 兼容 LLM"]
  L --> S["证据化日总结"]
  K --> S2["人工审核的 Skill 候选"]
```

## 已实现

- 连接器 registry 一次自动探测四类来源：Codex 完整 JSONL、Claude Code 内容块/sidechain、DSH JSONL/zstd/SQLite，以及 ZCode Hook spool 与临时 transcript。
- 会话 → 回合 → 事件 → 原始载荷/附件的统一模型，覆盖 system、context、user、assistant、reasoning、tool call/result、search、state、subagent、compaction 和未知来源事件。
- SQLite Outbox、2 MiB JSON 批次、UTF-8 文本分段、1 MiB Blob 分块、事件先入库、ACK 后确认与断点续传。
- 设备独立 Token HMAC 鉴权、请求摘要、幂等批次与事件版本。
- MySQL 8 迁移、UTC `DATETIME(6)`、`utf8mb4`、ngram 中文全文索引。
- 两台设备通过规范化 Git Remote 归并到同一项目。
- 中央 Worker 使用已配置的 DeepSeek / OpenAI 兼容模型识别工作进展；每条结论必须引用合法证据，设备未到齐时标记 `partial`。
- 迟到数据生成新 Revision；人工编辑后不会被静默覆盖。
- 基于重复证据生成 Skill 候选，不会自动写入或发布 Skill。
- “Agent 轨迹”搜索页与“Skill 调用透明视图”式详情页：右侧事件链，左侧上下文、输入/输出、原始载荷与附件；支持 320 / 768 / 1024 / 1440 宽度。

## 环境要求

- Node.js 22+
- npm 10+
- MySQL 8.0+（不支持 MariaDB）
- 生产环境的 HTTPS 域名或可信反向代理

## 快速启动

```bash
npm install
cp .env.example .env.local
# 先编辑 .env.local：填写可连接 MySQL 的管理员账户，
# 并把所有 replace-with-* 换成随机值。两枚设备 Token 必须不同且至少 32 字符。
npm run db:bootstrap
npm run db:seed
npm run llm:key:init
npm run dev
```

打开 `http://127.0.0.1:3000`。构建与生产启动：

```bash
npm run build
npm run start -w @ai-worklog/web
```

`.env.local` 已被 Git 忽略。不要把 MySQL 密码、设备 Token、Token Pepper、LLM 主密钥或工作台密码写入源码。
可用 `openssl rand -hex 32` 生成 Pepper/Token；Windows PowerShell 可执行 `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($b); [Convert]::ToHexString($b)`。首次初始化顺序是：管理员账户建库/迁移/种子数据 → 创建低权限应用账户 → 切换 Web/Worker 运行凭证。

### MySQL 权限

迁移需要管理员账户。平时运行 Web / Worker 只需要 `ai_worklog` 库的 `SELECT, INSERT, UPDATE, DELETE`。可以在管理员凭证仍位于 `.env.local` 时执行：

```bash
APP_DB_USER=ai_worklog_app \
APP_DB_PASSWORD='<long-random-password>' \
node scripts/create-mysql-app-user.mjs
```

创建完成后，把 `.env.local` 的 `MYSQL_USER` / `MYSQL_PASSWORD` 切换为应用账户。不要在生产环境使用 `root`。

生产默认要求 `MYSQL_SSL=true`。如果 MySQL 仅位于可信私网或加密隧道中且暂未启用 TLS，需显式设置 `ALLOW_INSECURE_MYSQL=true`；这是风险确认开关，不会把私网连接变成加密连接。

## Windows 和 Mac 如何汇总

两台机器不共享 SQLite 或直连 MySQL。它们只需要使用：

- 相同的 `AI_WORKLOG_ACCOUNT_ID`；
- 各自不同的 `AI_WORKLOG_DEVICE_ID` 和 `AI_WORKLOG_DEVICE_TOKEN`；
- 相同的 `AI_WORKLOG_SYNC_URL`；默认使用 HTTPS，可信私网 HTTP 需按调度文档显式确认；
- 每个工具/安装独立且稳定的 `SOURCE_INSTANCE_ID`。

`AI_WORKLOG_DEVICE_ID` 必须与该 Token 在中心端绑定的设备 ID 完全一致。`db:seed` 使用 `.env.local` 中的 `MACOS_DEVICE_ID` / `WINDOWS_DEVICE_ID` 建立绑定；默认分别是 `device_macos_demo` / `device_windows_demo`。Mac 使用 `MACOS_DEVICE_TOKEN`，Windows 使用 `WINDOWS_DEVICE_TOKEN`。

项目主键优先来自去凭证后的 Git Remote。例如，Windows 的 `git@github.com:acme/worklog.git` 与 Mac 的 `https://github.com/acme/worklog.git` 会归并为 `github.com/acme/worklog`。
真实日志没有 Git Remote 字段时，采集器会在设备本地用无 shell 的只读 Git 命令解析 `origin`，去除 URL 凭证后再上传规范化 Remote。无 Remote 时保守使用 Git Root/工作路径 HMAC 隔离，目录名只用于展示。

### 设备端配置

推荐在工作台的“同步中心”点击“添加设备”，选择 macOS 或 Windows 后复制页面生成的配置、验证和计划任务命令。设备 Token 只在创建或重新生成配置时显示一次，不会写入可复制命令；执行命令后，再在隐藏输入提示中粘贴 Token。关闭面板前应完成配置，丢失后只能轮换新 Token，且旧 Token 会立即失效。

在目标设备上必须先克隆本仓库并安装 npm 依赖，然后在仓库根目录执行页面命令。页面不会远程操作另一台电脑。

每台机器使用独立配置文件，权限仅限当前用户：

```dotenv
AI_WORKLOG_ACCOUNT_ID=account_demo
AI_WORKLOG_DEVICE_ID=device_macos_demo
AI_WORKLOG_DEVICE_TOKEN=<this-device-token>
AI_WORKLOG_SYNC_URL=https://worklog.example.com/api/v1/sync/batches
AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP=false
AI_WORKLOG_PROTOCOL_VERSION=2
AI_WORKLOG_PATH_HMAC_KEY=<random-per-device-key>
COLLECTOR_DB_PATH=/Users/me/.ai-worklog/collector.sqlite
COLLECTOR_BLOB_ROOT=/Users/me/.ai-worklog/blobs

CODEX_SOURCE_INSTANCE_ID=codex-mac-main
CODEX_SOURCE_PATH=/Users/me/.codex/sessions
CLAUDE_CODE_SOURCE_INSTANCE_ID=claude-mac-main
CLAUDE_CODE_SOURCE_PATH=/Users/me/.claude/projects
ZCODE_SOURCE_INSTANCE_ID=zcode-mac-main
ZCODE_HOOK_SPOOL=/Users/me/.ai-worklog/zcode-spool
DSH_SOURCE_INSTANCE_ID=dsh-mac-main
DSH_HOME=/Users/me/.dsh
```

Windows 将路径改为 `%USERPROFILE%\\.codex\\sessions`、`%USERPROFILE%\\.claude\\projects` 和 `%USERPROFILE%\\.ai-worklog\\collector.sqlite`。
本次 Mac 内网直连方案的 Windows 值为 `AI_WORKLOG_SYNC_URL=http://172.18.209.21:3000/api/v1/sync/batches` 和 `AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP=true`；完整操作以 [README_SCHEDULES.md](./README_SCHEDULES.md) 为准。

当前 Mac 可从已有 `.env.local` 安全生成仓库外的受限配置，再验证：

```bash
npm run collector:configure:macos
bash scripts/schedules/macos/run.sh --validate-only
```

默认一次自动探测四类连接器；也可使用 `--source` 限选：

```bash
npm run collector -- prepare
npm run collector -- prepare --source ZCODE
npm run collector -- sync
npm run collector -- status
```

ZCode 需先幂等安装 Hook：

```bash
npm run collector -- install-zcode-hook
```

采集器默认对非 localhost 地址强制 HTTPS；只有显式开启风险确认时才接受私网 IPv4 HTTP。请不要把设备 Token 放进命令行参数、任务调度器参数或 Git。

## 每日自动同步

macOS launchd 与 Windows Task Scheduler 安装/卸载脚本见 [README_SCHEDULES.md](./README_SCHEDULES.md)。macOS 默认每天 18:00 运行，Windows 默认每天 23:30 运行；密钥只从设备本地的受限配置文件读取。
中央服务所在的 Mac 可按同一文档另外安装 23:40 的有界总结 Worker LaunchAgent；它不会自动执行历史回补。

同步 API 收到 ACK 前，Outbox 不会删除待传数据。断网、进程退出或“数据库已提交但 ACK 丢失”后，下次会安全重传。

## 总结 Worker

同步 HTTP 请求只负责事务提交并立即 ACK，不在请求线程生成总结。发生新增或变更时，同步事务会按账户时区把工作日期登记到持久化 `summary_jobs`。Worker 有三种显式执行范围：

```bash
npm run worker
npm run worker -- 2026-07-14
npm run worker -- --backfill
```

不传参数时始终幂等刷新账户时区中的当天，并且只查询当天与昨天的任务：仅当昨天仍有 `summary_job` 时才一并刷新昨天，因此默认每次最多两个日期。这能处理次日才到达的昨日另一台设备数据并生成新 Revision，同时不会扫描或自动消费更早的历史积压。指定 `YYYY-MM-DD` 时只处理该日。只有显式传入 `--backfill` 才读取完整持久任务队列，并按日期从早到晚每次最多处理 31 日；JSON 输出中的 `bounded` 和 `remainingJobCount` 会说明是否触及上限及本轮后仍待处理的数量，若仍有积压可再次显式执行。这样默认的每日调度不会静默触发无界的付费模型调用。

输入指纹未变化时不生成重复 Revision。任务仅在 LLM 返回严格 JSON、全部 evidenceId 校验通过并成功持久化后，才按 generation 条件清除；未配置、鉴权失败、超时、限流、非法 JSON 或无效证据引用都会保留任务以供重试。在中央服务的调度器/进程守护中将默认的 `npm run worker` 安排在设备同步之后（例如每晚 23:40）。

### LLM 配置

先生成独立的 256 位本机主密钥，再从“LLM 设置”页面保存并测试连接：

```bash
npm run llm:key:init
```

默认使用 DeepSeek 官方 `https://api.deepseek.com` 与 `deepseek-v4-flash`。API Key 使用绑定账户的 AES-256-GCM 密文存入 MySQL；GET API 和页面只返回 `hasApiKey`，不会返回明文、密文、尾号、IV 或认证标签。主密钥不会自动生成；替换 `LLM_SETTINGS_ENCRYPTION_KEY` 前必须先迁移已有密文，否则旧配置无法解密。
更换服务商或 Base URL 的 origin 时必须输入新 Key；系统不会把已保存的 DeepSeek Key 复用到新域名。“测试连接”按账户限制为每分钟 5 次，防止误点或脚本反复发起付费请求。

v2 总结会将未脱敏的用户消息与助手结果兼容投影发送给已配置的外部 LLM。输入仍受模型上下文和证据选择总量上限约束；超出时 API/UI/导出都明确标记 `inputTruncated`。模型输入被标记为不可信证据，不执行其中的命令或链接。LLM API Key 继续以绑定账户的 AES-256-GCM 密文保存；Skill 候选仍由确定性规则生成并保持人工确认。

## API

- `POST /api/v1/sync/batches`：设备 Bearer Token 鉴权的同步接口。
- `PUT /api/v1/sync/blobs/:sha256`、`PUT .../chunks/:index`、`POST .../complete`：设备鉴权的 1 MiB 分块、去重与断点续传。
- `GET /api/v1/agent-runs`：按关键词、来源、日期、项目、事件类型和完整性搜索。
- `GET /api/v1/agent-runs/:id`、`GET /api/v1/agent-runs/:id/events`：会话详情和稳定 cursor 时间线。
- `GET /api/v1/agent-events/:id/content`、`GET /api/v1/blobs/:sha256`：流式读取完整正文、原始载荷与附件。
- `GET /api/v1/dashboard`
- `GET /api/v1/projects`
- `GET /api/v1/prompts`
- `GET /api/v1/calendar?month=YYYY-MM`
- `GET /api/v1/skills`
- `GET /api/v1/sync`
- `POST /api/v1/devices`：登记设备并一次性返回设备凭证。
- `POST /api/v1/devices/:id/token`：撤销旧凭证并一次性返回新凭证。
- `GET /api/v1/summaries?date=YYYY-MM-DD`
- `POST /api/v1/summaries`：手动请求 LLM 生成新的当日总结 Revision。
- `GET /api/v1/privacy`
- `GET /api/v1/llm-settings`
- `PUT /api/v1/llm-settings`
- `POST /api/v1/llm-settings/test`

页面和读 API 使用 `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` 的 Basic Auth；公网或不可信网络部署必须置于 HTTPS 之后。密码默认至少 16 位；只有可信局域网自用且明确接受风险时，才可对私网 HTTP 设置 `DASHBOARD_ALLOW_WEAK_PASSWORD=true`。仅在可信局域网自用时，可以按 [README_SCHEDULES.md](./README_SCHEDULES.md) 显式启用受限的私网 HTTP。同步接口不使用工作台密码，而使用每台设备的独立 Token。

## 安全边界

- protocol v2 将来源实际暴露的 system/context/user/assistant/reasoning/工具原文上传并长期保留，不做正文脱敏、截断或正文级加密。v1 仍保持旧脱敏校验。
- 中心需要做全文搜索与总结，因此这不是“服务器看不到明文”的零知识系统。复制文件正文不进全文索引，但可通过 Blob 下载。
- 历史 Prompt、助手结果和 Skill 全部作为不可信数据，不执行其中的命令、链接或工具调用。
- LLM 写接口要求可信 `APP_BASE_URL` 同源、JSON Content-Type、自定义请求标记与 16 KiB 请求上限；上游地址拒绝私网解析和重定向。
- v2 中心服务验证事件身份、账户/设备/来源所有权、顺序、内容摘要、分段边界与 Blob 引用，不再要求脱敏状态。
- 日志只记录 ID、计数和错误码，不记录 Prompt、Token 或 Git Remote。
- `AI_WORKLOG_BLOB_ROOT` 必须是非根绝对路径；账户目录与对象文件权限分别为 `0700`/`0600`，并以 SHA-256 验证。
- 只在显式开启时允许 localhost/RFC1918 HTTP；此模式下原文和设备 Token 都可能被局域网监听，公网 HTTP 仍拒绝。
- 应用内含鉴权前熔断与有界 MySQL 等待队列；公网部署仍必须在可信反向代理上对 `/api/v1/sync/batches` 按来源 IP 限流。

## 验证

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

真实 Chrome 视口验证脚本位于 `scripts/browser-smoke.mjs`，通过 Chrome DevTools Protocol 检查页面例外、网络失败、交互元素可访问名称并生成截图。

## v2 发布、回补与回退

发布顺序是：先执行数据库迁移，再发布同时接受 v1/v2 的服务端，然后发布 Agent 轨迹 UI，最后更新采集器并安装 ZCode Hook。`0008_agent_trajectories.sql` 只叠加新结构，不改写已有 `0007_llm_summary_prompts.sql` 或未提交的总结提示词工作。

首次 v2 `prepare` 会扫描当前可发现的历史日志，本地指纹游标保证后续增量。已有用户/助手事件继续使用稳定 event ID，只补充 RAW 版本和缺失事件；日志删除、损坏或格式过新时保留现有记录并标记不可回补。

回退时停止 v2 采集器，或在设备端设置 `AI_WORKLOG_PROTOCOL_VERSION=1`。新表保持惰性，不需要破坏性数据库回滚。DSH 解码遵循其 [JSONL session persistence 契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md)；ZCode 采集遵循官方 [Hooks 事件与 `transcript_path` 契约](https://zcode.z.ai/en/docs/hooks)。

## MVP 边界

- 当前是单用户/单账户版，不是团队权限或员工监控系统。
- Skill 采纳、覆盖和回滚写 API 仍保持禁用；候选只用于人工审核。
- 导出/彻底删除 mutation 尚未开放，界面不会伪造成功反馈。
- 生产部署需配置 HTTPS、MySQL 备份/静态加密与保留策略。
- 本地仓库没有 Git Remote 时，MVP 不会仅凭同名目录自动合并 Windows/Mac 项目，以避免误合并。
