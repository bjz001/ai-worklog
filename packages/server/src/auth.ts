import { createHmac } from "node:crypto";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { z } from "zod";

const ServerIdentitySchema = z.object({
  APP_ACCOUNT_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .min(3)
    .max(64)
    .optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_FIXTURE_MODE: z.enum(["true", "false"]).default("false")
});

export class InvalidAuthorizationError extends Error {
  readonly code = "INVALID_DEVICE_TOKEN";
  readonly status = 401;

  constructor() {
    super("设备令牌无效或已失效");
    this.name = "InvalidAuthorizationError";
  }
}

export interface ServerIdentity {
  accountId: string;
}

export interface DeviceIdentity extends ServerIdentity {
  deviceId: string;
  deviceTokenId: string;
}

export function hashDeviceToken(token: string, pepper: string): string {
  return createHmac("sha256", pepper)
    .update(`ai-worklog-device-token-v1\u001f${token}`)
    .digest("hex");
}

export function parseBearerToken(header: string | null): string {
  if (!header) throw new InvalidAuthorizationError();
  const match = header.match(/^Bearer ([^\s]{32,512})$/);
  if (!match?.[1]) throw new InvalidAuthorizationError();
  return match[1];
}

export function parseServerIdentity(
  environment: Record<string, string | undefined> = process.env
): ServerIdentity {
  const result = ServerIdentitySchema.safeParse(environment);
  if (!result.success) throw new Error("Invalid APP_ACCOUNT_ID");
  const accountId = result.data.APP_ACCOUNT_ID;
  if (!accountId && result.data.NODE_ENV === "production") {
    throw new Error("Invalid APP_ACCOUNT_ID");
  }
  return { accountId: accountId ?? "account_demo" };
}

interface DeviceIdentityRow extends RowDataPacket {
  account_id: string;
  device_id: string;
  token_id: string;
}

export async function authenticateDevice(options: {
  pool: Pool;
  authorization: string | null;
  tokenPepper: string | undefined;
}): Promise<DeviceIdentity> {
  if (!options.tokenPepper || options.tokenPepper.length < 32) {
    throw new Error("DEVICE_TOKEN_PEPPER is not configured");
  }

  const token = parseBearerToken(options.authorization);
  const tokenHmac = hashDeviceToken(token, options.tokenPepper);
  const [rows] = await options.pool.execute<DeviceIdentityRow[]>(
    `SELECT dt.id AS token_id, dt.account_id, dt.device_id
       FROM device_tokens dt
       JOIN devices d ON d.id = dt.device_id AND d.account_id = dt.account_id
      WHERE dt.token_hmac = ?
        AND dt.revoked_at IS NULL
        AND (dt.expires_at IS NULL OR dt.expires_at > UTC_TIMESTAMP(6))
        AND d.status = 'ACTIVE'
      LIMIT 1`,
    [tokenHmac]
  );
  const row = rows[0];
  if (!row) throw new InvalidAuthorizationError();

  const [touch] = await options.pool.execute<ResultSetHeader>(
    `UPDATE device_tokens dt
       JOIN devices d
         ON d.id = dt.device_id AND d.account_id = dt.account_id
        SET dt.last_used_at = UTC_TIMESTAMP(6),
            d.last_seen_at = UTC_TIMESTAMP(6)
      WHERE dt.id = ?
        AND dt.account_id = ?
        AND dt.device_id = ?
        AND dt.token_hmac = ?
        AND dt.revoked_at IS NULL
        AND (dt.expires_at IS NULL OR dt.expires_at > UTC_TIMESTAMP(6))
        AND d.status = 'ACTIVE'`,
    [row.token_id, row.account_id, row.device_id, tokenHmac]
  );
  // This is a multi-table UPDATE, so MySQL may report one changed row per
  // table. Zero means the credential no longer satisfied the active-token
  // predicates after any concurrent rotation finished.
  if (touch.affectedRows < 1) throw new InvalidAuthorizationError();

  return {
    accountId: row.account_id,
    deviceId: row.device_id,
    deviceTokenId: row.token_id
  };
}
