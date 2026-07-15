import {
  DeviceCreateSchema,
  type DeviceCreateInput,
  type DeviceEnrollmentResponse,
  type DevicePlatform,
  type DeviceView
} from "@ai-worklog/contracts";
import { randomBytes } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { hashDeviceToken } from "./auth";

type TransactionConnection = Pick<
  PoolConnection,
  "beginTransaction" | "commit" | "destroy" | "execute" | "release" | "rollback"
>;

export interface DeviceServicePool {
  getConnection(): Promise<TransactionConnection>;
}

interface AccountRow extends RowDataPacket {
  id: string;
}

interface DeviceRow extends RowDataPacket {
  id: string;
  name: string;
  platform: DevicePlatform;
  status: "ACTIVE" | "OFFLINE" | "REVOKED";
  last_seen_at: Date | null;
  last_synced_at: Date | null;
}

export class DeviceServiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "DeviceServiceError";
    this.code = code;
    this.status = status;
  }
}

function validatedPepper(tokenPepper: string | undefined): string {
  if (
    !tokenPepper ||
    tokenPepper.length < 32 ||
    tokenPepper.length > 1024 ||
    /[\r\n]/u.test(tokenPepper)
  ) {
    throw new DeviceServiceError(
      "DEVICE_TOKEN_PEPPER_NOT_CONFIGURED",
      503,
      "设备凭证服务尚未正确配置"
    );
  }
  return tokenPepper;
}

function isPrivateHttpHost(hostname: string): boolean {
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) {
    return true;
  }
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some(
      (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255
    )
  ) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

const asciiUrlPattern = /^[\u0021-\u007e]+$/u;
const dnsLabelPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;

function isSafeAsciiHostname(hostname: string): boolean {
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    !asciiUrlPattern.test(hostname)
  ) {
    return false;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const address = hostname.slice(1, -1);
    return (
      address.length > 1 &&
      address.length <= 45 &&
      address.includes(":") &&
      /^[0-9A-Fa-f:.]+$/u.test(address)
    );
  }
  return hostname
    .split(".")
    .every((label) => dnsLabelPattern.test(label));
}

function syncEndpoint(appBaseUrl: string | undefined): string {
  let url: URL;
  try {
    if (!appBaseUrl || !asciiUrlPattern.test(appBaseUrl)) throw new Error();
    url = new URL(appBaseUrl ?? "");
  } catch {
    throw new DeviceServiceError(
      "APP_BASE_URL_NOT_CONFIGURED",
      503,
      "APP_BASE_URL 尚未正确配置"
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !isSafeAsciiHostname(url.hostname) ||
    (url.protocol === "http:" && !isPrivateHttpHost(url.hostname))
  ) {
    throw new DeviceServiceError(
      "APP_BASE_URL_NOT_CONFIGURED",
      503,
      "APP_BASE_URL 尚未正确配置"
    );
  }
  return `${url.origin}/api/v1/sync/batches`;
}

function identifier(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function issueCredential(tokenPepper: string): {
  token: string;
  tokenHmac: string;
  tokenId: string;
} {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHmac: hashDeviceToken(token, tokenPepper),
    tokenId: identifier("device_token")
  };
}

function deviceView(
  row: Pick<
    DeviceRow,
    "id" | "last_seen_at" | "last_synced_at" | "name" | "platform"
  >
): DeviceView {
  return {
    id: row.id,
    name: row.name,
    os: row.platform,
    status: "WAITING",
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    lastSyncAt: row.last_synced_at?.toISOString() ?? null,
    promptCount: 0
  };
}

function result(options: {
  accountId: string;
  appBaseUrl: string;
  row: Pick<
    DeviceRow,
    "id" | "last_seen_at" | "last_synced_at" | "name" | "platform"
  >;
  token: string;
}): DeviceEnrollmentResponse["data"] {
  return {
    device: deviceView(options.row),
    enrollment: {
      accountId: options.accountId,
      deviceId: options.row.id,
      deviceToken: options.token,
      syncUrl: syncEndpoint(options.appBaseUrl)
    }
  };
}

async function inTransaction<T>(
  pool: DeviceServicePool,
  operation: (connection: TransactionConnection) => Promise<T>
): Promise<T> {
  const connection = await pool.getConnection();
  let reusable = true;
  try {
    await connection.beginTransaction();
    const value = await operation(connection);
    await connection.commit();
    return value;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      reusable = false;
    }
    throw error;
  } finally {
    if (reusable) connection.release();
    else connection.destroy();
  }
}

export async function createDeviceEnrollment(options: {
  pool: DeviceServicePool;
  accountId: string;
  input: DeviceCreateInput;
  tokenPepper: string | undefined;
  appBaseUrl: string | undefined;
}): Promise<DeviceEnrollmentResponse["data"]> {
  const parsed = DeviceCreateSchema.safeParse(options.input);
  if (!parsed.success) {
    throw new DeviceServiceError(
      "INVALID_DEVICE",
      422,
      "设备配置格式无效"
    );
  }
  const tokenPepper = validatedPepper(options.tokenPepper);
  const endpoint = syncEndpoint(options.appBaseUrl);
  const deviceId = identifier("device");
  const credential = issueCredential(tokenPepper);

  return inTransaction(options.pool, async (connection) => {
    const [accounts] = await connection.execute<AccountRow[]>(
      "SELECT id FROM accounts WHERE id = ? FOR UPDATE",
      [options.accountId]
    );
    if (!accounts[0]) {
      throw new DeviceServiceError(
        "ACCOUNT_NOT_FOUND",
        404,
        "账号不存在"
      );
    }

    await connection.execute(
      `INSERT INTO devices
         (id, account_id, device_registration_id, name, platform, status)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      [
        deviceId,
        options.accountId,
        deviceId,
        parsed.data.name,
        parsed.data.platform
      ]
    );
    await connection.execute(
      `INSERT INTO device_tokens
         (id, account_id, device_id, token_hmac, label)
       VALUES (?, ?, ?, ?, ?)`,
      [
        credential.tokenId,
        options.accountId,
        deviceId,
        credential.tokenHmac,
        `${parsed.data.platform} collector`
      ]
    );
    await connection.execute(
      `INSERT INTO audit_logs
         (account_id, device_id, action, resource_type, resource_id, outcome, metadata)
       VALUES (?, ?, 'DEVICE_CREATED', 'DEVICE', ?, 'SUCCEEDED', ?)`,
      [
        options.accountId,
        deviceId,
        deviceId,
        JSON.stringify({ platform: parsed.data.platform })
      ]
    );

    return {
      device: {
        id: deviceId,
        name: parsed.data.name,
        os: parsed.data.platform,
        status: "WAITING",
        lastSeenAt: null,
        lastSyncAt: null,
        promptCount: 0
      },
      enrollment: {
        accountId: options.accountId,
        deviceId,
        deviceToken: credential.token,
        syncUrl: endpoint
      }
    };
  });
}

export async function rotateDeviceEnrollmentToken(options: {
  pool: DeviceServicePool;
  accountId: string;
  deviceId: string;
  tokenPepper: string | undefined;
  appBaseUrl: string | undefined;
}): Promise<DeviceEnrollmentResponse["data"]> {
  if (!/^[A-Za-z0-9_-]{3,64}$/u.test(options.deviceId)) {
    throw new DeviceServiceError(
      "DEVICE_NOT_FOUND",
      404,
      "设备不存在"
    );
  }
  const tokenPepper = validatedPepper(options.tokenPepper);
  syncEndpoint(options.appBaseUrl);

  return inTransaction(options.pool, async (connection) => {
    const [rows] = await connection.execute<DeviceRow[]>(
      `SELECT id, name, platform, status, last_seen_at, last_synced_at
         FROM devices
        WHERE id = ? AND account_id = ?
        FOR UPDATE`,
      [options.deviceId, options.accountId]
    );
    const row = rows[0];
    if (!row) {
      throw new DeviceServiceError(
        "DEVICE_NOT_FOUND",
        404,
        "设备不存在"
      );
    }
    if (row.status === "REVOKED") {
      throw new DeviceServiceError(
        "DEVICE_REVOKED",
        409,
        "已撤销设备不能轮换凭证"
      );
    }

    const credential = issueCredential(tokenPepper);
    await connection.execute(
      `UPDATE device_tokens
          SET revoked_at = UTC_TIMESTAMP(6)
        WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL`,
      [options.accountId, options.deviceId]
    );
    await connection.execute(
      `INSERT INTO device_tokens
         (id, account_id, device_id, token_hmac, label)
       VALUES (?, ?, ?, ?, ?)`,
      [
        credential.tokenId,
        options.accountId,
        options.deviceId,
        credential.tokenHmac,
        `${row.platform} collector`
      ]
    );
    await connection.execute(
      `UPDATE devices
          SET status = 'ACTIVE', last_seen_at = NULL, last_synced_at = NULL,
              updated_at = UTC_TIMESTAMP(6)
        WHERE id = ? AND account_id = ?`,
      [options.deviceId, options.accountId]
    );
    await connection.execute(
      `INSERT INTO audit_logs
         (account_id, device_id, action, resource_type, resource_id, outcome, metadata)
       VALUES (?, ?, 'DEVICE_TOKEN_ROTATED', 'DEVICE', ?, 'SUCCEEDED', ?)`,
      [
        options.accountId,
        options.deviceId,
        options.deviceId,
        JSON.stringify({ platform: row.platform })
      ]
    );

    return result({
      accountId: options.accountId,
      appBaseUrl: options.appBaseUrl ?? "",
      row: {
        ...row,
        last_seen_at: null,
        last_synced_at: null
      },
      token: credential.token
    });
  });
}
