import { homedir } from "node:os";
import {
  lstat,
  readdir,
  realpath,
  stat
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  resolve
} from "node:path";
import type { AgentSourceType } from "@ai-worklog/contracts";
import { sha256Hex } from "@ai-worklog/core";
import type { AgentConnector } from "./agent-connector.js";
import { AgentPromptConnector } from "./agent-prompt-connector.js";
import type { PromptConnector } from "./prompt-connector.js";
import { ClaudeCodeConnector } from "./claude-connector.js";
import { ClaudeCodeAgentConnector } from "./claude-agent-connector.js";
import { CodexAgentConnector } from "./codex-agent-connector.js";
import { CodexConnector } from "./codex-connector.js";
import { DshAgentConnector } from "./dsh-agent-connector.js";
import { ZCodeAgentConnector } from "./zcode-agent-connector.js";

export interface AgentSourceCandidate {
  path: string;
  fingerprint: string;
  modifiedAtMs: number;
}

export interface AgentConnectorRegistryEntry {
  connector: AgentConnector;
  candidates: AgentSourceCandidate[];
}

export interface PromptConnectorRegistryEntry {
  connector: PromptConnector;
  candidates: AgentSourceCandidate[];
}

interface FileInfo {
  path: string;
  size: number;
  modifiedAtMs: number;
  fingerprint: string;
}

export function parseAgentSourceSelection(value: string): AgentSourceType {
  const normalized = value.trim().toUpperCase();
  if (["CODEX", "CLAUDE_CODE", "ZCODE", "DSH"].includes(normalized)) {
    return normalized as AgentSourceType;
  }
  throw new Error("Unsupported Agent source");
}

async function sourceFiles(root: string): Promise<FileInfo[]> {
  let initial;
  try {
    initial = await lstat(root);
  } catch (error) {
    if (
      error && typeof error === "object" && "code" in error &&
      error.code === "ENOENT"
    ) return [];
    throw error;
  }
  if (initial.isSymbolicLink()) {
    throw new Error("Agent source root symlinks are not allowed");
  }
  const paths: string[] = [];
  if (initial.isFile()) {
    paths.push(await realpath(root));
  } else if (initial.isDirectory()) {
    const pending = [await realpath(root)];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) continue;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) paths.push(path);
      }
    }
  }
  const files: FileInfo[] = [];
  for (const path of paths) {
    const info = await stat(path);
    files.push({
      path,
      size: info.size,
      modifiedAtMs: info.mtimeMs,
      fingerprint: sha256Hex([
        path,
        String(info.dev),
        String(info.ino),
        String(info.size),
        String(info.mtimeMs)
      ].join("\u001f"))
    });
  }
  return files;
}

function newestFirst(candidates: AgentSourceCandidate[]): AgentSourceCandidate[] {
  return candidates.sort((left, right) =>
    right.modifiedAtMs - left.modifiedAtMs || left.path.localeCompare(right.path)
  );
}

async function jsonlCandidates(root: string, name?: string): Promise<AgentSourceCandidate[]> {
  return newestFirst((await sourceFiles(root))
    .filter((file) => extname(file.path).toLowerCase() === ".jsonl")
    .filter((file) => !name || basename(file.path).toLowerCase() === name)
    .map(({ path, fingerprint, modifiedAtMs }) => ({
      path,
      fingerprint,
      modifiedAtMs
    })));
}

async function dshCandidates(root: string): Promise<AgentSourceCandidate[]> {
  const files = await sourceFiles(root);
  if (files.length === 0) return [];
  const source = await lstat(root);
  if (source.isFile()) {
    const file = files[0];
    if (!file) return [];
    return [{
      path: file.path,
      fingerprint: file.fingerprint,
      modifiedAtMs: file.modifiedAtMs
    }];
  }
  const groupedJsonl = new Map<string, FileInfo[]>();
  const sqlite: FileInfo[] = [];
  for (const file of files) {
    const lowerName = basename(file.path).toLowerCase();
    if (lowerName === "session.jsonl" || lowerName === "session.jsonl.zstd") {
      const backendRoot = dirname(dirname(dirname(file.path)));
      const group = groupedJsonl.get(backendRoot) ?? [];
      group.push(file);
      groupedJsonl.set(backendRoot, group);
    } else if (
      /^sessions?\.(?:db|sqlite|sqlite3)$/u.test(lowerName)
    ) {
      sqlite.push(file);
    }
  }
  const candidates: AgentSourceCandidate[] = sqlite.map((file) => ({
    path: file.path,
    fingerprint: file.fingerprint,
    modifiedAtMs: file.modifiedAtMs
  }));
  for (const [path, group] of groupedJsonl) {
    candidates.push({
      path,
      fingerprint: sha256Hex(group
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((file) => file.fingerprint)
        .join("\u001f")),
      modifiedAtMs: Math.max(...group.map((file) => file.modifiedAtMs))
    });
  }
  return newestFirst(candidates);
}

function instanceId(
  env: Record<string, string | undefined>,
  variable: string,
  deviceId: string,
  source: AgentSourceType
): string {
  const configured = env[variable]?.trim();
  const candidate = configured || `${deviceId}-${source.toLowerCase().replace(/_/gu, "-")}`;
  return candidate.length <= 128
    ? candidate
    : `${source.toLowerCase()}-${sha256Hex(candidate).slice(0, 96)}`;
}

export async function createAgentConnectorRegistry(options: {
  env: Record<string, string | undefined>;
  accountId: string;
  deviceId: string;
  selectedSource?: AgentSourceType;
}): Promise<AgentConnectorRegistryEntry[]> {
  const shared = {
    accountId: options.accountId,
    deviceId: options.deviceId,
    pathHmacKey: options.env.AI_WORKLOG_PATH_HMAC_KEY
  };
  const specifications: Array<{
    type: AgentSourceType;
    connector: AgentConnector;
    discover: () => Promise<AgentSourceCandidate[]>;
  }> = [
    {
      type: "CODEX",
      connector: new CodexAgentConnector({
        ...shared,
        sourceInstanceId: instanceId(
          options.env,
          "CODEX_SOURCE_INSTANCE_ID",
          options.deviceId,
          "CODEX"
        )
      }),
      discover: () => jsonlCandidates(
        options.env.CODEX_SOURCE_PATH?.trim() || join(homedir(), ".codex", "sessions")
      )
    },
    {
      type: "CLAUDE_CODE",
      connector: new ClaudeCodeAgentConnector({
        ...shared,
        sourceInstanceId: instanceId(
          options.env,
          "CLAUDE_CODE_SOURCE_INSTANCE_ID",
          options.deviceId,
          "CLAUDE_CODE"
        )
      }),
      discover: () => jsonlCandidates(
        options.env.CLAUDE_CODE_SOURCE_PATH?.trim() || join(homedir(), ".claude", "projects")
      )
    },
    {
      type: "ZCODE",
      connector: new ZCodeAgentConnector({
        ...shared,
        sourceInstanceId: instanceId(
          options.env,
          "ZCODE_SOURCE_INSTANCE_ID",
          options.deviceId,
          "ZCODE"
        )
      }),
      discover: () => jsonlCandidates(
        options.env.ZCODE_HOOK_SPOOL?.trim() ||
          options.env.ZCODE_SOURCE_PATH?.trim() ||
          join(homedir(), ".ai-worklog", "zcode-spool"),
        "events.jsonl"
      )
    },
    {
      type: "DSH",
      connector: new DshAgentConnector({
        ...shared,
        sourceInstanceId: instanceId(
          options.env,
          "DSH_SOURCE_INSTANCE_ID",
          options.deviceId,
          "DSH"
        )
      }),
      discover: () => dshCandidates(
        options.env.DSH_SOURCE_PATH?.trim() ||
          options.env.DSH_HOME?.trim() ||
          join(homedir(), ".dsh")
      )
    }
  ];
  const registry: AgentConnectorRegistryEntry[] = [];
  for (const specification of specifications) {
    if (options.selectedSource && specification.type !== options.selectedSource) {
      continue;
    }
    const candidates = await specification.discover();
    if (candidates.length > 0) {
      registry.push({ connector: specification.connector, candidates });
    }
  }
  return registry;
}

export async function createPromptConnectorRegistry(options: {
  env: Record<string, string | undefined>;
  accountId: string;
  deviceId: string;
  selectedSource?: AgentSourceType;
}): Promise<PromptConnectorRegistryEntry[]> {
  const shared = {
    accountId: options.accountId,
    deviceId: options.deviceId,
    pathHmacKey: options.env.AI_WORKLOG_PATH_HMAC_KEY
  };
  const specifications: Array<{
    type: AgentSourceType;
    connector: PromptConnector;
    discover: () => Promise<AgentSourceCandidate[]>;
  }> = [
    {
      type: "CODEX",
      connector: new CodexConnector({
        ...shared,
        captureMode: "raw-prompts",
        sourceInstanceId: instanceId(
          options.env,
          "CODEX_SOURCE_INSTANCE_ID",
          options.deviceId,
          "CODEX"
        )
      }),
      discover: () => jsonlCandidates(
        options.env.CODEX_SOURCE_PATH?.trim() || join(homedir(), ".codex", "sessions")
      )
    },
    {
      type: "CLAUDE_CODE",
      connector: new ClaudeCodeConnector({
        ...shared,
        captureMode: "raw-prompts",
        sourceInstanceId: instanceId(
          options.env,
          "CLAUDE_CODE_SOURCE_INSTANCE_ID",
          options.deviceId,
          "CLAUDE_CODE"
        )
      }),
      discover: () => jsonlCandidates(
        options.env.CLAUDE_CODE_SOURCE_PATH?.trim() || join(homedir(), ".claude", "projects")
      )
    },
    {
      type: "ZCODE",
      connector: new AgentPromptConnector({
        connector: new ZCodeAgentConnector({
          ...shared,
          sourceInstanceId: instanceId(
            options.env,
            "ZCODE_SOURCE_INSTANCE_ID",
            options.deviceId,
            "ZCODE"
          )
        })
      }),
      discover: () => jsonlCandidates(
        options.env.ZCODE_HOOK_SPOOL?.trim() ||
          options.env.ZCODE_SOURCE_PATH?.trim() ||
          join(homedir(), ".ai-worklog", "zcode-spool"),
        "events.jsonl"
      )
    },
    {
      type: "DSH",
      connector: new AgentPromptConnector({
        connector: new DshAgentConnector({
          ...shared,
          sourceInstanceId: instanceId(
            options.env,
            "DSH_SOURCE_INSTANCE_ID",
            options.deviceId,
            "DSH"
          )
        })
      }),
      discover: () => dshCandidates(
        options.env.DSH_SOURCE_PATH?.trim() ||
          options.env.DSH_HOME?.trim() ||
          join(homedir(), ".dsh")
      )
    }
  ];
  const registry: PromptConnectorRegistryEntry[] = [];
  for (const specification of specifications) {
    if (options.selectedSource && specification.type !== options.selectedSource) {
      continue;
    }
    const candidates = await specification.discover();
    if (candidates.length > 0) registry.push({ connector: specification.connector, candidates });
  }
  return registry;
}

export function collectorBlobRoot(
  env: Record<string, string | undefined>,
  databasePath: string
): string {
  return resolve(
    env.COLLECTOR_BLOB_ROOT?.trim() ||
    join(dirname(databasePath), "blobs")
  );
}
