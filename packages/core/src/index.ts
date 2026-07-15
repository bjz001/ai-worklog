import { createHash } from "node:crypto";

export interface EventIdentity {
  accountId: string;
  deviceId: string;
  sourceType: string;
  sourceInstanceId: string;
  sourceSessionId: string;
  sourceMessageId?: string | null;
  messageIndex: number;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildEventId(identity: EventIdentity): string {
  const stableParts = [
    "event-v1",
    identity.accountId,
    identity.deviceId,
    identity.sourceType.toUpperCase(),
    identity.sourceInstanceId,
    identity.sourceSessionId,
    identity.sourceMessageId ?? `index:${identity.messageIndex}`
  ];

  return sha256Hex(stableParts.join("\u001f"));
}

export function normalizeGitRemote(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  const scpLike = trimmed.includes("://")
    ? null
    : trimmed.match(/^(?:[^@\s]+@)?([^:/\s]+):(.+)$/);
  const urlLike = scpLike
    ? `https://${scpLike[1]}/${scpLike[2]}`
    : trimmed.replace(/^ssh:\/\//i, "https://");

  try {
    const parsed = new URL(urlLike.includes("://") ? urlLike : `https://${urlLike}`);
    const path = parsed.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .replace(/\/{2,}/g, "/")
      .toLowerCase();

    if (!parsed.hostname || !path) return null;
    return `${parsed.hostname.toLowerCase()}/${path}`;
  } catch {
    return null;
  }
}

export function repositoryRootName(localPath: string): string | null {
  const normalized = localPath.trim().replace(/[\\/]+$/u, "");
  const name = normalized.split(/[\\/]/u).filter(Boolean).at(-1)?.trim();
  if (!name || name === "." || name === "..") return null;
  return name.slice(0, 255);
}

const REDACTED = "[REDACTED]";

function redactSensitiveTextOnce(input: string): string {
  return input
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
      REDACTED
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
    .replace(
      /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
      REDACTED
    )
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
      REDACTED
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/gi, `${REDACTED}`)
    .replace(
      /\b((?:mysql|mariadb|postgres(?:ql)?|https?|ssh):\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
      `$1${REDACTED}@`
    )
    .replace(
      /\b(((?:(?:\d{1,3}\.){3}\d{1,3}|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})[:\s]+(?:3306|5432|1433)\s+(?:root|postgres|sa|[A-Za-z][A-Za-z0-9_.-]{0,63}))\s+)[^\s,;]+/gi,
      `$1${REDACTED}`
    )
    .replace(
      /\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
      (_match, label: string) => `${label}: ${REDACTED}`
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*["']?[^\s,"';]+["']?/gi,
      (_match, label: string) => `${label}=${REDACTED}`
    )
    .replace(
      /((?:密码|口令|令牌|密钥)\s*[:：=]\s*)["']?[^\s,"’';，；]+["']?/gu,
      (_match, label: string) => `${label}${REDACTED}`
    );
}

export function redactSensitiveText(input: string): string {
  let current = input;
  // Overlapping credential shapes can expose a second recognizable shape
  // after the first replacement. Return a fixed point so collector and server
  // validation agree and a second pass can never reveal a missed secret.
  for (let pass = 0; pass < 8; pass += 1) {
    const next = redactSensitiveTextOnce(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

export function excerpt(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}
