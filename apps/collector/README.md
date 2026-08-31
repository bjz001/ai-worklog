# AI Worklog Collector

采集器以只读方式发现 Codex、Claude Code、Z.ai ZCode 和 DeepSeek Harness（DSH）的本地会话，只将完整用户 Prompt 写入 SQLite Outbox，再幂等同步到中心端。Prompt 正文不脱敏；上下文、助手回复、推理、工具调用、转录和附件均不采集。设备 Token 仅从环境读取，不进入 Outbox 载荷或标准输出。

## 命令

```bash
npm run collector -- prepare
npm run collector -- prepare --source DSH
npm run collector -- prepare --force-history
npm run collector -- sync
npm run collector -- status
npm run collector -- quarantine-legacy
npm run collector -- install-zcode-hook
npm run collector -- run-fixtures
```

`prepare` 默认探测四类来源；`--source CODEX|CLAUDE_CODE|ZCODE|DSH` 只处理指定类型。新记录优先进入 Outbox，历史回补游标在成功 prepare 后推进；`--force-history` 忽略本地指纹游标重扫。

`quarantine-legacy` 是从旧版轨迹采集协议升级时使用的一次性本地操作。它在事务中将 pending 的非 v1 批次和所有 pending Blob 移入隔离表，不联网、不删除原始会话文件或 Blob 文件。为防止旧数据误上传，`sync` 在检测到未隔离的旧批次或 pending Blob 时会直接阻断并要求先执行该命令。

## 通用配置

- `AI_WORKLOG_ACCOUNT_ID`、`AI_WORKLOG_DEVICE_ID`：必填。
- `AI_WORKLOG_PROTOCOL_VERSION`：默认 `1`；当前只支持 Prompt-only 采集协议。
- `COLLECTOR_DB_PATH`：SQLite Outbox；默认 `~/.ai-worklog/collector.sqlite`。
- `COLLECTOR_BLOB_ROOT`：本地内容寻址 Blob 缓存；默认为 Outbox 同目录下的 `blobs`。
- `AI_WORKLOG_PATH_HMAC_KEY`：推荐设置，用于稳定且不可逆地标识本地项目路径。

来源默认路径及覆盖项：

- Codex：`~/.codex/sessions`；`CODEX_SOURCE_PATH`、`CODEX_SOURCE_INSTANCE_ID`。
- Claude Code：`~/.claude/projects`；`CLAUDE_CODE_SOURCE_PATH`、`CLAUDE_CODE_SOURCE_INSTANCE_ID`。
- ZCode：`~/.ai-worklog/zcode-spool`；`ZCODE_HOOK_SPOOL`/`ZCODE_SOURCE_PATH`、`ZCODE_SOURCE_INSTANCE_ID`。
- DSH：`DSH_SOURCE_PATH`，否则 `$DSH_HOME`，再否则 `~/.dsh`；`DSH_SOURCE_INSTANCE_ID`。

DSH 通过官方 session persistence 包解码 JSONL、`.jsonl.zstd` 和 SQLite，不自行猜测压缩或数据库格式。同一 JSONL backend root 不能混用明文和 zstd 编码。

## ZCode Hook

```bash
ZCODE_CONFIG_PATH="$HOME/.zcode/cli/config.json" \
ZCODE_HOOK_SPOOL="$HOME/.ai-worklog/zcode-spool" \
npm run collector -- install-zcode-hook
```

安装器会验证配置类型、备份现有文件，并只幂等合并 `UserPromptSubmit` Hook；重复执行不会叠加相同 Hook。Hook 只持久化当次 Prompt，不读取或复制 `transcript_path`。

## Prompt 与同步

JSON 批次上限为 2 MiB；单条 Prompt 遵守协议的内容上限。只保存 Prompt 正文和必要的来源、会话、时间字段，不保存原始载荷、转录或 Blob。

## 同步

`sync` 额外需要：

- `AI_WORKLOG_SYNC_URL`：指向 `/api/v1/sync/batches`。默认强制 HTTPS；HTTP 只允许 localhost，或在 `AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP=true` 时允许 RFC1918 IPv4。
- `AI_WORKLOG_DEVICE_TOKEN`：只从环境读取。

同步请求包含 `Authorization`、`Idempotency-Key` 与 `X-Payload-SHA256`。仅在服务端返回结构有效且批次 ID 匹配的 ACK 后，Outbox 才标记已确认。开启局域网 HTTP 时，原文与设备 Token 都可能被同网段监听；公网 HTTP 始终拒绝。

## 验证

```bash
npm test -w @ai-worklog/collector
npm run typecheck -w @ai-worklog/collector
npx eslint apps/collector/src
```
