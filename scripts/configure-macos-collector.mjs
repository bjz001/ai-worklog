import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function parseEnvironment(source) {
  const values = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`Missing or invalid ${name} in .env.local`);
  }
  return value;
}

const projectEnvironment = parseEnvironment(
  await readFile(resolve(process.cwd(), ".env.local"), "utf8")
);
const home = homedir();
const configDirectory = join(home, ".config", "ai-worklog");
const dataDirectory = join(home, ".ai-worklog");
const configPath = join(configDirectory, "collector.env");
let existing = new Map();
try {
  existing = parseEnvironment(await readFile(configPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const appBaseUrl = required(projectEnvironment, "APP_BASE_URL").replace(/\/+$/, "");
const pathHmacKey = existing.get("AI_WORKLOG_PATH_HMAC_KEY") || randomBytes(32).toString("hex");
const lines = [
  `AI_WORKLOG_ACCOUNT_ID=${required(projectEnvironment, "APP_ACCOUNT_ID")}`,
  `AI_WORKLOG_DEVICE_ID=${projectEnvironment.get("MACOS_DEVICE_ID") || "device_macos_demo"}`,
  "CODEX_SOURCE_INSTANCE_ID=macos-codex",
  `CODEX_SOURCE_PATH=${join(home, ".codex", "sessions")}`,
  "CLAUDE_CODE_SOURCE_INSTANCE_ID=macos-claude-code",
  `CLAUDE_CODE_SOURCE_PATH=${join(home, ".claude", "projects")}`,
  `AI_WORKLOG_PATH_HMAC_KEY=${pathHmacKey}`,
  `COLLECTOR_DB_PATH=${join(dataDirectory, "collector.sqlite")}`,
  `AI_WORKLOG_SYNC_URL=${appBaseUrl}/api/v1/sync/batches`,
  `AI_WORKLOG_DEVICE_TOKEN=${required(projectEnvironment, "MACOS_DEVICE_TOKEN")}`,
  `NODE_BINARY=${process.execPath}`
];

await mkdir(configDirectory, { recursive: true, mode: 0o700 });
await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
await chmod(configDirectory, 0o700);
await chmod(dataDirectory, 0o700);
const temporaryPath = `${configPath}.tmp-${process.pid}`;
await writeFile(temporaryPath, `${lines.join("\n")}\n`, {
  encoding: "utf8",
  mode: 0o600
});
await rename(temporaryPath, configPath);
await chmod(configPath, 0o600);
process.stdout.write("macOS collector configuration written with mode 0600.\n");
