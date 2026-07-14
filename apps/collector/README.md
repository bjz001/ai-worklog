# AI Worklog Collector

本地只读采集 Codex JSONL，将脱敏后的事件写入 SQLite Outbox，再通过同步 API 上传。数据库和标准输出均不会保存或打印设备令牌。

## 命令

```bash
npm run collector -- prepare
npm run collector -- sync
npm run collector -- status
npm run collector -- run-fixtures
```

`prepare` 需要：

- `COLLECTOR_DB_PATH`：本地 SQLite 路径；未设置时使用用户目录下的 `.ai-worklog/collector.sqlite`。
- `AI_WORKLOG_ACCOUNT_ID`
- `AI_WORKLOG_DEVICE_ID`
- `CODEX_SOURCE_INSTANCE_ID`
- `CODEX_SOURCE_PATH`：明确授权的 `.jsonl` 文件或目录。
- `AI_WORKLOG_PATH_HMAC_KEY`：推荐设置，用于不可逆标识本地项目路径。

`sync` 额外需要：

- `AI_WORKLOG_SYNC_URL`：生产环境必须为 HTTPS；仅 localhost 允许 HTTP。
- `AI_WORKLOG_DEVICE_TOKEN`：只从环境读取。

同步请求包含 `Authorization`、`Idempotency-Key` 与 `X-Payload-SHA256`。只有服务端返回结构有效、批次 ID 匹配的提交 ACK 后，批次才会标记为已确认。

## 验证

```bash
npm test -w @ai-worklog/collector
npm run typecheck -w @ai-worklog/collector
npx eslint apps/collector/src
```
