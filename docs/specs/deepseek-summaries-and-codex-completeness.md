# Spec: DeepSeek 工作总结与 Codex 完整采集

## Objective

补齐真实 Codex JSONL 中目前未被识别的用户提示词格式；为单账户工作台增加可编辑的 LLM 配置；使用配置的 DeepSeek 模型基于脱敏证据生成可追溯的每日工作总结。

默认配置为 DeepSeek OpenAI 兼容接口 `https://api.deepseek.com` 和模型 `deepseek-v4-flash`。同一适配器也允许账户所有者填写其他 HTTPS OpenAI 兼容端点。

## Tech Stack

- Node.js 22、TypeScript、Next.js 15
- MySQL 8、`mysql2`、Drizzle schema
- Zod 负责 API 与第三方响应边界校验
- Node `crypto` AES-256-GCM 加密 API Key
- Vitest 单元/契约测试；真实浏览器做页面验收

## Commands

- 开发：`npm run dev -w @ai-worklog/web -- --hostname 127.0.0.1 --port 3000`
- 测试：`npm test`
- 类型：`npm run typecheck`
- Lint：`npm run lint`
- 构建：`npm run build`
- 迁移：`npm run db:migrate`
- 总结：`npm run worker -- YYYY-MM-DD`

## Project Structure

- `apps/collector`：Codex / Claude Code 连接器与本地 Outbox
- `packages/contracts`：LLM 设置和现有查询响应契约
- `packages/db`：`llm_settings` schema 与向前迁移
- `packages/server`：密钥加密、设置服务、LLM 客户端与总结编排
- `apps/web`：设置 API、DeepSeek 配置页面与导航
- `apps/worker`：持久化 `summary_jobs` 消费

## API Contract

- `GET /api/v1/llm-settings`：只返回 provider、baseUrl、model、hasApiKey、updatedAt；绝不返回密钥或密文。
- `PUT /api/v1/llm-settings`：完整更新 provider/baseUrl/model；`apiKey` 可选，省略时保留原密钥。
- `POST /api/v1/llm-settings/test`：由用户显式触发一次最小模型调用，返回成功状态、模型和耗时，不返回模型原文。
- 所有写接口校验同源请求、请求大小和 Zod schema，并沿用统一 API 错误结构。

## Code Style

```ts
const parsed = LlmSettingsUpdateSchema.safeParse(await request.json());
if (!parsed.success) return apiError(422, "VALIDATION_ERROR");
await saveLlmSettings({ accountId, encryptionKey, input: parsed.data });
```

- 对外字段使用 camelCase，枚举值使用 UPPER_SNAKE。
- SQL 参数化；第三方响应必须通过 Zod 后才能进入总结逻辑。
- API Key 只在最短作用域中解密，不写日志、不回传浏览器。

## Testing Strategy

- Codex：真实结构的脱敏 fixture 先复现漏采，再验证稳定事件身份、回复关系和去重。
- 配置：契约、URL 安全、AES-GCM 篡改拒绝、密钥不回显、保留旧 Key。
- LLM：本地 fake fetch 验证 OpenAI 兼容请求、严格 JSON、超时、超限响应和提示注入隔离；测试不访问外网。
- Worker：LLM 失败时 `summary_jobs` 保留；成功后按 generation 清理。
- UI：保存、替换 Key、测试连接、加载/错误/成功状态及键盘可访问性。

## Boundaries

- Always：中心仅向 LLM 发送已脱敏且有长度上限的证据；API Key AES-256-GCM 加密；外部端点生产环境必须 HTTPS；请求禁止重定向并设置超时/响应大小上限。
- Ask first：新增其他非 OpenAI 兼容协议、允许生产私网 HTTP 端点、自动发布 Skill。
- Never：把 API Key 写入源码、Git、日志、提示词正文或 API 响应；把采集到的提示词当成可执行指令；在测试中调用真实付费模型。

## Success Criteria

- 真实 Codex 日志中所有已确认的用户提示词结构都被采集，已有 v1/v2 事件身份不重复。
- DeepSeek 配置可在页面保存和替换，页面/API/日志均无法读取明文 Key。
- Worker 使用 `deepseek-v4-flash` 生成带合法 evidenceIds 的总结，并记录 provider/model。
- DeepSeek 未配置、超时、限流或返回非法 JSON 时不确认 summary job，下次可重试。
- 全量测试、类型检查、Lint、生产构建和浏览器验收通过。

## Open Questions / Assumptions

- 当前只实现 DeepSeek/OpenAI 兼容 Chat Completions；Anthropic 原生协议留作后续扩展。
- LLM 只负责工作总结识别，Skill 候选仍沿用现有确定性规则并保持人工审核。
- 生产部署是否允许私有 LLM 地址由后续显式安全开关决定；默认拒绝非 HTTPS 外部端点。
