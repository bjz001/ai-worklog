# AI Worklog Collector

采集器以只读方式发现 Codex、Claude Code、Z.ai ZCode 和 DeepSeek Harness（DSH）的本地会话，将规范化事件与来源暴露的原始载荷写入 SQLite Outbox，再幂等同步到中心端。protocol v2 不对 system/context/user/assistant/reasoning/工具正文做脱敏、截断或正文级加密；来源未暴露的内容只记录 `NOT_EXPOSED`，不推测补全。设备 Token 仅从环境读取，不进入轨迹、Outbox 载荷或标准输出。

## 命令

```bash
npm run collector -- prepare
npm run collector -- prepare --source DSH
npm run collector -- prepare --force-history
npm run collector -- sync
npm run collector -- status
npm run collector -- install-zcode-hook
npm run collector -- run-fixtures
```

`prepare` 在 v2 下默认探测四类来源；`--source CODEX|CLAUDE_CODE|ZCODE|DSH` 只处理指定类型。新记录优先进入 Outbox，历史回补游标在成功 prepare 后推进；`--force-history` 忽略本地指纹游标重扫。

## 通用配置

- `AI_WORKLOG_ACCOUNT_ID`、`AI_WORKLOG_DEVICE_ID`：必填。
- `AI_WORKLOG_PROTOCOL_VERSION`：默认 `2`。显式设为 `1` 时运行旧 Codex/Claude Code 脱敏协议，用于采集端回退。
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

安装器会验证配置类型、备份现有文件，并幂等合并 `SessionStart`、`UserPromptSubmit`、工具前后/失败与 `Stop` Hook；重复执行不会叠加相同 Hook。Hook 先持久化当次事件，再尝试复制临时 `transcript_path`；转录复制失败会记录状态，不丢失 Hook 事件。

## 附件与原始载荷

只识别日志中结构化路径和可静态解析的 shell 字面量，不执行命令、变量、glob 或命令替换。仅复制采集时存在的普通文件，记录请求路径、真实路径、时间、字节数、SHA-256 和失败状态。这是采集时快照，不保证还原工具访问当时的历史版本。

JSON 批次上限为 2 MiB；长正文先分为 UTF-8 安全的文本段，原始载荷与文件通过固定 1 MiB 块断点续传。块大小是传输单位，不是文件或会话容量上限。事件批次先同步，Blob 后续补齐；缺失、无权限、磁盘耗尽或中断都不会回滚已入库轨迹。

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
