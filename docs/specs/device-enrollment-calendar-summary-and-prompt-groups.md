# Spec: 在线设备配置、日历总结与 Prompt 分组

## Objective

为单用户可信局域网部署补齐四项能力：

1. 当前部署使用用户明确指定的 `admin/admin` Dashboard Basic Auth；短密码必须由独立环境开关显式允许，默认仍要求至少 16 位。
2. 同步中心可以登记 macOS/Windows 设备、一次性生成设备 Token，并提供可复制的本机配置指引；中心端不远程执行目标机器命令，也不再次返回历史 Token。
3. 日历按日期加载完整 LLM 工作总结；缺失或不完整日期可以手动触发生成/重新生成，并展示加载、成功和安全失败状态。
4. 项目页按项目展开最近 Prompt；Prompt 库按项目分组展开/收缩，同名不同项目不合并。

## Assumptions

- “在线配置”是中心端登记设备并生成本机配置材料，不是远程控制 Mac/Windows。
- 设备 Token 只在创建或轮换成功的响应中出现一次，关闭配置面板后前端清除它。
- 项目页默认全部收起；带 `?project=<id>` 的深链自动展开目标项目。
- Prompt 库只对当前分页结果分组，标题明确显示“本页 N 条”；默认展开第一个组。
- 折叠状态仅存在当前页面内，不写 MySQL 或浏览器存储。
- 手动总结请求同步等待 LLM 结果；MySQL 日期锁负责防止同一天并发生成。

## Tech Stack

- Next.js 15 App Router、React 19、TypeScript
- Zod API 边界校验
- MySQL 8 + `mysql2/promise`
- Vitest 单元/服务测试
- 现有 CSS 设计系统与 Detail Drawer

## Commands

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm audit --audit-level=high
bash scripts/schedules/tests/static-test.sh
```

部署到当前 Mac：

```bash
npm run build
bash scripts/schedules/macos-runtime/deploy.sh --node "$(command -v node)" --dry-run
bash scripts/schedules/macos-runtime/deploy.sh --node "$(command -v node)"
```

## Project Structure

- `packages/contracts`：设备登记、总结详情和查询响应契约
- `packages/server`：设备 Token 生命周期、总结查询/生成、Prompt 精确项目筛选
- `packages/db`：现有设备表与 seed 兼容行为
- `apps/web/src/app/api/v1`：受 Dashboard Auth 和同源校验保护的 API
- `apps/web/src/views`：同步中心、日历、项目、Prompt 库交互
- `apps/web/src/components/prompts`：可复用 Prompt 详情
- `docs/specs`：本规格和验收边界

## Code Style

边界先校验、服务层返回安全 DTO、SQL 全部参数化：

```ts
const parsed = CreateDeviceSchema.safeParse(await readJsonMutation(request));
if (!parsed.success) throw new DeviceConfigurationError("INVALID_DEVICE", 422);
return NextResponse.json(await createDevice({ ...context, input: parsed.data }), {
  status: 201
});
```

折叠控件使用原生按钮并暴露状态：

```tsx
<button aria-controls={panelId} aria-expanded={expanded} onClick={toggle}>
  {project.name}
</button>
```

## Testing Strategy

- 契约测试：拒绝额外字段、控制字符、非法日期和非法项目 ID。
- 服务测试：Token 只以 HMAC 入库、轮换撤销旧 Token、账户隔离、SQL 参数化；完整总结五个分区可读取。
- 查询测试：`projectId` 精确筛选；日历状态和详情映射正确。
- 纯前端逻辑测试：Prompt 按项目稳定分组，同名不同 ID、未分类和顺序正确。
- 浏览器验证：登录、设备配置一次性 Token 面板、日历生成/详情、项目和 Prompt 折叠、键盘与控制台。
- 不在自动测试中调用真实 LLM；服务测试使用 fake fetcher。

## Boundaries

### Always

- 所有写 API 使用 Dashboard Auth、同源 Origin、自定义请求头和 Zod 严格校验。
- 设备 Token 使用密码学随机数生成，只存 HMAC，GET/日志/audit 不返回明文。
- 用户提供的名称不拼入 shell 命令；配置指引使用固定路径与独立复制字段。
- LLM 错误仅返回安全错误码和中文提示，不回显上游正文或 API Key。
- 账户 ID 始终是 SQL 查询和更新条件的一部分。

### Ask first

- 远程执行另一台设备的命令。
- 将服务映射到公网、移除 Dashboard Auth 或开放跨域写请求。
- 持久保存设备 Token 明文。

### Never

- 将 `admin/admin`、设备 Token、LLM Key 或数据库密码提交到 Git。
- 把 Token 放进 URL、日志、audit metadata、localStorage 或命令历史。
- 用项目名称模糊搜索代替 `projectId` 精确账户内筛选。
- 覆盖未提交用户文件或删除本地 Outbox。

## Success Criteria

### Authentication

- 本机运行配置使用 `admin/admin`，匿名和旧凭据返回 401，新凭据可访问页面/API。
- 不设置 `DASHBOARD_ALLOW_WEAK_PASSWORD=true` 时，少于 16 位的密码仍被拒绝。
- 弱密码模式只允许 loopback 或 RFC1918 的 HTTP `APP_BASE_URL`。

### Online device configuration

- 同步中心可创建 macOS/Windows 设备并一次性展示 Token、账号 ID、设备 ID、同步地址和平台配置步骤。
- 关闭一次性配置后，Token 无法通过 GET 找回；需要明确确认才能轮换。
- 轮换后旧 Token 失效，新 Token 可认证；重复 seed 不恢复旧 Token。
- Mac 配置生成脚本优先保留已有在线配置凭据，不写回旧 `.env.local` Token。

### Calendar summaries

- 点击有总结日期可看到亮点、项目进展、决策、阻塞、下一步、完整性说明和证据。
- 缺失日期显示“生成总结”，已有日期显示“重新生成”；运行期间按钮禁用且有状态提示。
- 成功后立即刷新日期状态和详情；失败后显示安全错误并允许重试。
- PARTIAL 明确表示总结已生成但设备覆盖不完整，不再表现为“无总结”。

### Project and Prompt grouping

- 项目页默认收起，展开时精确懒加载该项目最近 10 条 Prompt，并缓存本页结果。
- Dashboard 项目深链自动展开正确项目，“查看全部”进入带 `projectId` 的 Prompt 库。
- Prompt 库按 `projectId` 对当前页分组；每条记录恰好出现一次，同名不同 ID 不合并。
- 所有折叠按钮支持键盘，并同步 `aria-expanded` 与具名 region。

## Open Questions

- 暂不实现设备配置的远程执行；若未来需要，应设计独立的双向 Agent、审批和审计协议。
- 历史 35 天总结自动回补不属于本轮；用户可从日历逐日生成，Worker 继续处理当天/昨天。
