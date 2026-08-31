import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const EVENTS = ["UserPromptSubmit"] as const;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/gu, "");
}

function hookMatches(
  value: unknown,
  command: string,
  args: string[]
): boolean {
  const matcher = object(value);
  const hooks = Array.isArray(matcher.hooks) ? matcher.hooks : [];
  return hooks.some((hook) => {
    const candidate = object(hook);
    return candidate.type === "process" &&
      candidate.command === command &&
      JSON.stringify(candidate.args) === JSON.stringify(args);
  });
}

export async function installZcodeHook(options: {
  configPath: string;
  spoolPath: string;
  hookScriptPath: string;
  nodePath?: string;
  now?: () => Date;
}): Promise<{ changed: boolean; configPath: string; backupPath: string | null }> {
  const nodePath = options.nodePath ?? process.execPath;
  const args = [options.hookScriptPath, "--spool", options.spoolPath];
  await mkdir(dirname(options.configPath), { recursive: true, mode: 0o700 });
  let original = "";
  let existed = false;
  try {
    const info = await lstat(options.configPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("ZCode config must be a regular non-symlink file");
    }
    original = await readFile(options.configPath, "utf8");
    existed = true;
  } catch (error) {
    if (
      error && typeof error === "object" && "code" in error &&
      error.code === "ENOENT"
    ) {
      original = "{}";
    } else {
      throw error;
    }
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(original);
  } catch {
    throw new Error("ZCode config is not valid JSON");
  }
  const config = object(decoded);
  const hooks = object(config.hooks);
  const events = object(hooks.events);
  hooks.enabled = true;
  for (const [event, value] of Object.entries(events)) {
    if (!Array.isArray(value)) continue;
    const remaining = value.filter((entry) => !hookMatches(entry, nodePath, args));
    if (remaining.length === 0) delete events[event];
    else events[event] = remaining;
  }
  for (const event of EVENTS) {
    const entries = Array.isArray(events[event]) ? [...events[event]] : [];
    if (!entries.some((entry) => hookMatches(entry, nodePath, args))) {
      entries.push({
        matcher: "*",
        hooks: [{
          type: "process",
          command: nodePath,
          args,
          enabled: true,
          timeoutMs: 15_000
        }]
      });
    }
    events[event] = entries;
  }
  hooks.events = events;
  config.hooks = hooks;
  const next = `${JSON.stringify(config, null, 2)}\n`;
  const normalizedOriginal = existed
    ? `${JSON.stringify(JSON.parse(original), null, 2)}\n`
    : "";
  if (next === normalizedOriginal) {
    return { changed: false, configPath: options.configPath, backupPath: null };
  }

  let backupPath: string | null = null;
  if (existed) {
    backupPath = `${options.configPath}.backup-${safeTimestamp(
      (options.now ?? (() => new Date()))()
    )}`;
    await copyFile(options.configPath, backupPath, constants.COPYFILE_EXCL);
    await chmod(backupPath, 0o600);
  }
  const temporaryPath = join(
    dirname(options.configPath),
    `.zcode-config-${randomBytes(8).toString("hex")}.tmp`
  );
  const file = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  );
  try {
    await file.writeFile(next, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, options.configPath);
  await chmod(options.configPath, 0o600);
  return { changed: true, configPath: options.configPath, backupPath };
}
