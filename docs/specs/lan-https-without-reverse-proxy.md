# Spec: 无反向代理的局域网 HTTPS 部署

## Objective

让同一局域网内的 Windows 采集器通过固定地址
`https://172.18.209.21:8443/api/v1/sync/batches` 安全同步到 Mac 中心端，
不安装或使用 nginx、Caddy、隧道等额外代理服务。

Mac 使用项目内置的 Node HTTPS 启动器直接承载 Next.js。服务器证书由本地专用
CA 签发并包含 `172.18.209.21` 的 IP SAN；Windows 只安装 CA 公共证书，Node
采集进程通过显式 CA 文件校验证书。

## Tech Stack

- Node.js HTTPS / TLS 与 Next.js 15 自定义服务器
- OpenSSL 3 生成离线本地 CA 和服务器证书
- macOS launchd 常驻 Web 服务
- Windows PowerShell Task Scheduler 运行采集器
- Vitest、Shell 静态测试与真实 TLS/API 冒烟测试

## Commands

- 生成/验证证书：`bash scripts/lan-https/macos-certificates.sh --host 172.18.209.21`
- 构建：`npm run build`
- 前台 HTTPS：`npm run start:https`
- 安装 Web 服务：`bash scripts/schedules/macos-web/install.sh --node "$(command -v node)"`
- 卸载 Web 服务：`bash scripts/schedules/macos-web/uninstall.sh`
- 测试：`npm test`
- 类型：`npm run typecheck`
- Lint：`npm run lint`
- 调度静态检查：`bash scripts/schedules/tests/static-test.sh`

## Project Structure

- `apps/web/server.mjs`：加载根目录环境、验证 HTTPS 配置并启动 Next.js。
- `apps/web/server-config.mjs`：纯配置解析和安全校验，供测试复用。
- `apps/web/server-config.test.ts`：URL、端口、绑定地址和证书路径的单元测试。
- `scripts/lan-https/`：幂等生成仓库外 CA/服务器证书，不输出私钥。
- `scripts/schedules/macos-web/`：Web LaunchAgent 安装、运行、卸载。
- `README_SCHEDULES.md`：Mac 与 Windows 的完整交接步骤及回滚方法。

## Code Style

```js
const config = parseHttpsServerConfig(process.env);
const server = createServer(
  { cert: readFileSync(config.certPath), key: readFileSync(config.keyPath) },
  requestHandler
);
server.listen(config.port, config.bindHost);
```

- 启动器只记录阶段、状态、绑定地址和端口，不记录环境值、Token、Prompt 或私钥。
- 所有路径必须为绝对路径；证书、私钥和 `.env.local` 必须为当前用户所有且不可被
  组或其他用户读取。
- 外部 URL 必须是无凭据、无查询和片段的 HTTPS origin。

## Testing Strategy

- RED/GREEN 单元测试覆盖 HTTP 拒绝、嵌入凭据拒绝、非法端口、非绝对证书路径、
  合法局域网 HTTPS 配置。
- Shell 静态测试覆盖 LaunchAgent 不含秘密、只引用绝对 Node/项目路径、证书脚本
  不覆盖既有 CA 私钥、生成的证书包含精确 IP SAN。
- 真实冒烟测试使用生成的 CA 验证 TLS 链，通过 HTTPS 读取工作台和 API；不用
  `-k`、`NODE_TLS_REJECT_UNAUTHORIZED=0` 或任何跳过证书校验的方式。
- 发布前运行全量测试、类型检查、Lint、构建和 `npm audit --audit-level=high`。

## Boundaries

- Always：TLS 1.2 或更高；私钥仓库外保存且 mode 0600；Windows 只接收 CA 公共
  证书；Web 服务由 launchd 常驻；`APP_BASE_URL` 与 Windows 同步 origin 一致。
- Ask first：更换 IP/端口、轮换 CA、将服务开放到公网、修改鉴权或限流策略。
- Never：提交证书私钥/真实证书到 Git；使用局域网明文 HTTP；关闭 TLS 校验；把
  CA 私钥复制到 Windows；在进程参数或日志中写入 MySQL/LLM/设备凭据。

## Success Criteria

- Mac 重启后 `com.ai-worklog.web` 自动监听 `172.18.209.21:8443`。
- `openssl s_client` 与 Node fetch 使用 CA 公共证书成功校验服务器证书，证书 SAN
  包含 `IP Address:172.18.209.21`。
- 工作台与 LLM 设置 API 经 HTTPS 返回 200；未认证页面请求仍返回 401。
- Windows dry-run 和首次真实同步通过，79 个 Outbox 批次最终降为 0，再安装
  23:30 计划任务。
- 证书、`.env.local`、Token 与 SQLite Outbox 均未进入 Git；提交推送至私有仓库。

## Rollback

1. 在 Mac 执行 `bash scripts/schedules/macos-web/uninstall.sh`。
2. 将 `.env.local` 的 `APP_BASE_URL` 恢复为原值并按需启动本地开发服务。
3. Windows 暂停或卸载计划任务；Outbox 保留，后续恢复地址后会幂等续传。
4. 不删除 CA 私钥，除非明确决定永久废弃该 CA；废弃时同时从 Windows 信任中移除。

## Open Questions / Assumptions

- `172.18.209.21` 已由网络侧固定或做 DHCP 保留。
- Windows 使用的 Node 版本支持 `NODE_EXTRA_CA_CERTS`。
- 当前仅对同一可信局域网开放；若将来跨公网，应改用公开可信证书和专用入口。
