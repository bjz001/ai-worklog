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

const REDACTED = "[REDACTED]";

export function redactSensitiveText(input: string): string {
  return input
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
      /\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
      (_match, label: string) => `${label}: ${REDACTED}`
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*["']?[^\s,"';]+["']?/gi,
      (_match, label: string) => `${label}=${REDACTED}`
    );
}

export function excerpt(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}
