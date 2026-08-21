import { createHmac } from "node:crypto";
import { normalizeGitRemote, sha256Hex } from "@ai-worklog/core";
import { resolveLocalProjectIdentity } from "./git-project.js";
import type { JsonRecord } from "./jsonl-reader.js";

export function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = optionalString(value);
    if (candidate) return candidate;
  }
  return undefined;
}

export function isoTimestamp(value: unknown, fallback: string): string {
  const raw = optionalString(value) ?? fallback;
  const timestamp = new Date(raw);
  return Number.isNaN(timestamp.getTime())
    ? new Date(fallback).toISOString()
    : timestamp.toISOString();
}

function looksLikeBinaryOrCiphertext(value: string, key: string): boolean {
  const normalizedKey = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase();
  if (/(?:^|[_-])(?:encrypted(?:_content)?|ciphertext|base64|image_data|blob_data|binary)(?:$|[_-])/u.test(normalizedKey)) {
    return true;
  }
  return /^data:[^;,]+;base64,/iu.test(value);
}

function searchableValue(
  value: unknown,
  key: string,
  depth: number,
  seen: Set<object>
): unknown {
  if (depth > 24) return "[nested content omitted from search]";
  if (typeof value === "string") {
    return looksLikeBinaryOrCiphertext(value, key)
      ? "[binary or ciphertext omitted from search]"
      : value;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular value]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => searchableValue(item, key, depth + 1, seen));
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([childKey, child]) => [
      childKey,
      searchableValue(child, childKey, depth + 1, seen)
    ]));
}

export function searchableJson(value: unknown): string {
  return JSON.stringify(searchableValue(value, "", 0, new Set()), null, 2);
}

export function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    const type = String(record.type ?? "");
    if ([
      "text",
      "input_text",
      "output_text",
      "summary_text"
    ].includes(type)) {
      const text = firstString(record.text, record.message, record.content);
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function numericIndex(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export async function projectHint(options: {
  cwd?: string;
  reportedGitRemote?: string;
  accountId: string;
  deviceId: string;
  pathHmacKey?: string;
}) {
  if (!options.cwd) return undefined;
  const remote = options.reportedGitRemote
    ? normalizeGitRemote(options.reportedGitRemote)
    : null;
  const project = await resolveLocalProjectIdentity({
    cwd: options.cwd,
    reportedGitRemote: remote ?? options.reportedGitRemote
  });
  if (!project) return undefined;
  const key = options.pathHmacKey ?? sha256Hex(
    `path-key-v1\u001f${options.accountId}\u001f${options.deviceId}`
  );
  return {
    ...(project.gitRemoteKey ? { gitRemoteKey: project.gitRemoteKey } : {}),
    ...(project.repoRootName ? { repoRootName: project.repoRootName } : {}),
    localPathHmac: createHmac("sha256", key)
      .update(project.pathForHmac)
      .digest("hex")
  };
}
