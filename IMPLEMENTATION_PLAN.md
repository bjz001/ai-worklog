# Implementation Plan: AI 工作沉淀台 MVP

## 目标

在空仓库中交付一条可验证的跨设备链路：Windows/macOS 脱敏 fixture 经本地采集与 Outbox 上传，服务端幂等写入 MySQL，按 Git Remote 合并项目，并在 Material 风格工作台中展示 Prompt、日历、规则总结和 Skill 候选。

## 架构决策

- 使用 npm workspaces 管理 TypeScript Monorepo，减少额外构建工具。
- Web 与 API 使用 Next.js，后台规则任务由独立脚本执行；采集器为跨平台 Node CLI。
- 中心数据库使用 MySQL；设备本地队列使用 SQLite。
- API 合同由共享 Zod Schema 定义，采集器、服务端与测试共用。
- 真实凭证只保存在未跟踪的 `.env.local`；包含凭证的需求 Prompt 不进入 Git。
- 远端数据库只做正常迁移与联调；故障注入、并发和删除测试使用隔离测试库。

## Phase 1：安全基础与合同

### Task 1：仓库和配置边界

**验收标准**

- `.env.local`、本地 SQLite、日志和需求 Prompt 被 Git 忽略。
- `.env.example` 只包含占位符。
- 配置加载经过 Schema 校验，生产环境拒绝 root 与空密码。

**验证**

- `git check-ignore .env.local 开发Promot.md`
- 配置单元测试通过。

### Task 2：同步合同、事件身份和脱敏

**验收标准**

- 批次请求、响应和错误格式由共享 Zod Schema 定义。
- Event ID 不依赖 parser 版本或正文。
- API Key、Bearer、Cookie、数据库 URL 和带凭证 Git Remote 在进入 Outbox 前被脱敏。

**验证**

- 先运行失败测试，再实现至通过。

## Phase 2：MySQL 与同步链路

### Task 3：MySQL Schema 与迁移

**验收标准**

- 创建 `accounts`、`devices`、`sync_batches`、`projects`、`sessions`、`collected_events`、`prompt_entries` 等核心表。
- `(account_id,event_id)` 与 `(account_id,device_id,batch_id)` 使用数据库唯一约束。
- 所有时间按 UTC 保存，字符集为 `utf8mb4`。

**验证**

- 迁移可重复运行。
- 远端 `ai_worklog` 健康检查通过。

### Task 4：幂等 Ingest API

**验收标准**

- `POST /api/v1/sync/batches` 校验设备令牌、协议与 Payload Hash。
- 首次提交成功；同批次同内容重放返回原结果；同批次不同内容返回 409。
- 账户与设备来自认证上下文，不信任请求体。

**验证**

- API 合同测试和数据库集成测试通过。

### Task 5：Collector Fixture 与 Outbox

**验收标准**

- Windows/macOS 两份 fixture 经过同一连接器标准化。
- 本地 SQLite 保存不可变批次，收到 ACK 后才标记完成。
- 两台设备不同本地路径、同一 Git Remote 被归入同一项目。

**验证**

- 重放三次数据不增长。
- ACK 丢失后重试不重复。

## Phase 3：真实数据工作台

### Task 6：查询 API 与 AppShell

**验收标准**

- Dashboard、项目、Prompt、日历、Skill、同步、隐私页面均读取统一 DTO。
- 不在 JSX 中硬编码业务数据。
- 设计 Token、导航、顶部工具栏和右侧详情抽屉符合 Gmail/Material 规范。

**验证**

- 类型检查、组件测试和构建通过。

### Task 7：Prompt、项目与日历下钻

**验收标准**

- Prompt 支持搜索、项目/设备/来源筛选和分页。
- 日历日期在两次点击内下钻到证据 Prompt。
- 项目归类展示 Git Remote 依据和设备来源。

**验证**

- Playwright 主流程通过。

## Phase 4：总结、Skill 与调度

### Task 8：规则总结与 Skill 候选

**验收标准**

- 规则总结区分事实、观察和信息不足，并关联 Evidence ID。
- 部分设备缺失时标记 `partial`。
- Skill 只生成候选和 Diff，不写真实目录。

**验证**

- 总结证据、输入指纹和 Skill 安全测试通过。

### Task 9：跨平台定时与运行文档

**验收标准**

- 提供 macOS launchd 和 Windows Task Scheduler 安装/卸载脚本。
- README 说明部署、配对、同步、迁移和故障排查。

**验证**

- 脚本 dry-run 和 CLI 状态命令通过。

## Final Checkpoint

- 单元测试、集成测试、类型检查、Lint、构建全部通过。
- 浏览器控制台无错误，1440/1280/1024 三个桌面视口完成截图验证。
- 对改动执行正确性、可读性、架构、安全和性能五轴审查。
- 不提交真实凭证、需求 Prompt、环境文件、数据库文件或构建产物。

## 明确非目标

- 多人组织、计费、移动端、实时监听、向量搜索、自动执行历史 Prompt、自动安装 Skill。
- 第一版不依赖外部 LLM；先交付可追溯的规则总结。
