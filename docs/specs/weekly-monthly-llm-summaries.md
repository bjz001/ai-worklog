# Spec: LLM 周总结、月总结与导出

## Objective

在现有日总结基础上新增周总结和月总结，让用户能快速回答“本周 / 本月主要完成了什么”，而不是继续阅读逐条 Prompt。所有总结必须由账号在“LLM 设置”中配置并验证的模型生成，事实来源必须是对应周期内已脱敏的 Prompt 与 AI 可见回答。

默认产品约定：

- 周期按账号时区计算；周为周一至周日，月为自然月。
- 日、周、月总结均可手动生成或重新生成。
- 周/月总结按项目和日期归纳主要成果，不输出逐 Prompt 流水账。
- 历史周期可以前后切换；无 Prompt 的周期不调用 LLM。
- 导出格式首期为 UTF-8 Markdown，日、周、月总结均支持下载。
- 周/月总结首期按需生成，不加入自动定时调用，避免无意增加模型费用。

## Tech Stack

- Next.js 15、React 19、TypeScript、Zod
- MySQL 8、mysql2、Drizzle schema
- Vitest、ESLint
- 已有 OpenAI-compatible / DeepSeek JSON LLM 客户端

## API Contract

- `GET /api/v1/period-summaries?periodType=WEEK|MONTH&periodStart=YYYY-MM-DD`
  - 读取指定规范周期的最新总结和活动统计。
- `POST /api/v1/period-summaries`
  - 请求体为 `{ periodType, periodStart }`；严格校验周一或月初。
  - 使用已配置 LLM 基于原始 Prompt / 回答生成新 revision。
- `GET /api/v1/period-summaries/export?periodType=...&periodStart=...`
  - 导出已存在的周期总结 Markdown；不存在时返回 404，不隐式调用 LLM。
- `GET /api/v1/summaries/export?date=YYYY-MM-DD`
  - 导出已存在的日总结 Markdown。

所有查询按服务端账号身份隔离；错误沿用现有结构化 API 错误格式。导出响应使用 `text/markdown; charset=utf-8`、`Content-Disposition: attachment` 和 `Cache-Control: no-store`。

## Data Model

- 新增 `period_summaries`：账号、周期类型、开始/结束日期、时区、revision、状态、输入指纹、JSON 内容、覆盖信息、模型与模板版本。
- 新增 `period_summary_evidence`：周期总结的陈述与原始采集事件之间的证据关系。
- 唯一约束保证同账号、同周期 revision 与输入指纹幂等。
- 迁移仅新增表，不修改或删除现有日总结数据。

## LLM Output

周期总结返回：

- `overview`：2–4 条高层结论。
- `majorAccomplishments`：本周期主要完成事项。
- `projectProgress`：按项目合并后的推进情况。
- `decisions`：关键决策。
- `blockers`：阻塞与风险。
- `nextFocus`：下周期重点。

每条陈述必须引用一个或多个本次请求中提供的证据 ID。模型输出严格通过 Zod 校验；无效引用、无效 JSON 或越权内容不得持久化。日总结提示词同步强化“合并同类工作、优先结果、避免逐 Prompt 罗列”。

月度证据可能超过单次模型请求上限。服务端对完整证据集计算输入指纹，并按“日期 × 项目”轮询选择有代表性的 Prompt / 回答，再按 UTF-8 字节上限装包；若数量或正文被截断，状态和完整性说明必须明确披露。

## Project Structure

- `packages/contracts`：周期合同、请求与响应 Schema。
- `packages/db`：追加迁移和 Drizzle schema。
- `packages/server`：日期周期、证据选择、LLM 生成、持久化、查询与 Markdown 导出。
- `apps/web/src/app/api/v1`：周期生成/读取和日/周期导出路由。
- `apps/web/src/views`、`components/calendar`：日 / 周 / 月切换、展示、生成与导出。

## Code Style

```ts
const parsed = PeriodSummaryRequestSchema.safeParse(input);
if (!parsed.success) {
  throw new PeriodSummaryRouteError("INVALID_PERIOD", 422, "总结周期格式无效");
}
```

- 外部输入只在边界校验，内部使用类型化数据。
- SQL 全部参数化；动态 SQL 只允许服务端生成的占位符。
- React 只以文本节点展示模型输出，不使用 HTML 注入。
- 复用现有设计 token、按钮、状态与空态组件。

## Testing Strategy

- Contract：周期类型、规范周一 / 月初、严格请求与无密钥泄露。
- Unit：周期边界、跨年 / 闰年、均衡证据选择、Markdown 转义和文件名。
- LLM：确认请求包含 Prompt 与回答、反提示注入、防伪造引用、大小上限与无证据零调用。
- Server：账号隔离、幂等 revision、查询与证据回填、参数化 SQL。
- Route：GET / POST / export 成功和非法输入、404、限流、`no-store`。
- UI：类型检查、Lint、生产构建和浏览器验证（桌面 / 移动、键盘、加载 / 错误 / 空态）。

## Commands

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm audit --audit-level=high
npm run db:migrate
```

不启动 Docker MySQL 测试；上线时只运行追加式正式迁移。

## Boundaries

- Always：使用已配置 LLM、原始 Prompt / 回答、证据引用、账号隔离、请求限流、无缓存导出。
- Ask first：新增导出格式、自动定时生成、外部分享链接。
- Never：把 API Key 放进客户端或导出、用规则总结冒充 LLM、把日总结当作唯一事实源、执行证据中的指令。

## Success Criteria

- 日历页面可切换日 / 周 / 月视图并浏览历史周期。
- 有 Prompt 的周/月可由配置的 LLM 生成、重新生成并持久化；无 Prompt 不调用 LLM。
- 周/月正文突出主要完成内容和项目级进展，不是逐 Prompt 清单。
- 日、周、月已有总结均可下载 Markdown。
- 所有陈述具有可验证的原始 Prompt / 回答证据；截断情况清楚展示。
- 现有日总结、Windows/Mac 同步、LLM 设置和 23:40 Worker 行为保持兼容。

## Open Questions

首期采用 Markdown 导出且周/月按需生成；PDF、Word 和自动定时生成留作后续显式需求。
