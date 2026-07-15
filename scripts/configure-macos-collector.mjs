import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseEnvironment(source) {
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

function existingValue(existing, name) {
  const value = existing.get(name);
  return value && !/[\r\n]/u.test(value) ? value : undefined;
}

function existingOr(existing, name, fallback) {
  return existingValue(existing, name) ?? fallback;
}

export function buildCollectorEnvironment(options) {
  const appBaseUrl = required(
    options.projectEnvironment,
    "APP_BASE_URL"
  ).replace(/\/+$/, "");
  const dataDirectory = join(options.home, ".ai-worklog");
  const accountId = existingValue(options.existing, "AI_WORKLOG_ACCOUNT_ID") ??
    required(options.projectEnvironment, "APP_ACCOUNT_ID");
  const deviceId = existingOr(
    options.existing,
    "AI_WORKLOG_DEVICE_ID",
    options.projectEnvironment.get("MACOS_DEVICE_ID") || "device_macos_demo"
  );
  const deviceToken = existingValue(options.existing, "AI_WORKLOG_DEVICE_TOKEN") ??
    required(options.projectEnvironment, "MACOS_DEVICE_TOKEN");
  const lines = [
    `AI_WORKLOG_ACCOUNT_ID=${accountId}`,
    `AI_WORKLOG_DEVICE_ID=${deviceId}`,
    `CODEX_SOURCE_INSTANCE_ID=${existingOr(options.existing, "CODEX_SOURCE_INSTANCE_ID", "macos-codex")}`,
    `CODEX_SOURCE_PATH=${existingOr(options.existing, "CODEX_SOURCE_PATH", join(options.home, ".codex", "sessions"))}`,
    `CLAUDE_CODE_SOURCE_INSTANCE_ID=${existingOr(options.existing, "CLAUDE_CODE_SOURCE_INSTANCE_ID", "macos-claude-code")}`,
    `CLAUDE_CODE_SOURCE_PATH=${existingOr(options.existing, "CLAUDE_CODE_SOURCE_PATH", join(options.home, ".claude", "projects"))}`,
    `AI_WORKLOG_PATH_HMAC_KEY=${existingOr(options.existing, "AI_WORKLOG_PATH_HMAC_KEY", options.generatedPathHmacKey)}`,
    `COLLECTOR_DB_PATH=${existingOr(options.existing, "COLLECTOR_DB_PATH", join(dataDirectory, "collector.sqlite"))}`,
    `AI_WORKLOG_SYNC_URL=${appBaseUrl}/api/v1/sync/batches`,
    `AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP=${appBaseUrl.startsWith("http://") ? "true" : "false"}`,
    `AI_WORKLOG_DEVICE_TOKEN=${deviceToken}`,
    `NODE_BINARY=${options.nodeBinary}`
  ];
  return `${lines.join("\n")}\n`;
}

export async function main() {
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

  const contents = buildCollectorEnvironment({
    projectEnvironment,
    existing,
    home,
    nodeBinary: process.execPath,
    generatedPathHmacKey: randomBytes(32).toString("hex")
  });

  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
  await chmod(dataDirectory, 0o700);
  const temporaryPath = `${configPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, contents, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporaryPath, configPath);
  await chmod(configPath, 0o600);
  process.stdout.write("macOS collector configuration written with mode 0600.\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
