import { hashDeviceToken } from "./auth";
import { describe, expect, it, vi } from "vitest";
import {
  createDeviceEnrollment,
  rotateDeviceEnrollmentToken,
  type DeviceServicePool
} from "./device-service";

function transactionalPool(options: {
  accountExists?: boolean;
  device?: {
    id: string;
    name: string;
    platform: "MACOS" | "WINDOWS";
    status: "ACTIVE" | "OFFLINE" | "REVOKED";
    last_seen_at: Date | null;
    last_synced_at: Date | null;
  };
  auditFails?: boolean;
  rollbackFails?: boolean;
} = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: options.rollbackFails
      ? vi.fn().mockRejectedValue(new Error("synthetic rollback failure"))
      : vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    release: vi.fn(),
    execute: vi.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("SELECT id FROM accounts")) {
        return [options.accountExists === false ? [] : [{ id: "account_demo" }], []];
      }
      if (sql.includes("FROM devices") && sql.includes("FOR UPDATE")) {
        return [options.device ? [options.device] : [], []];
      }
      if (sql.includes("INSERT INTO audit_logs") && options.auditFails) {
        throw new Error("synthetic audit failure");
      }
      return [{ affectedRows: 1 }, []];
    })
  };
  return {
    calls,
    connection,
    pool: {
      getConnection: vi.fn().mockResolvedValue(connection)
    } as unknown as DeviceServicePool
  };
}

describe("device enrollment service", () => {
  const tokenPepper = "p".repeat(32);
  const appBaseUrl = "http://172.18.209.21:3000";

  it("creates a device and returns its random token exactly once", async () => {
    const database = transactionalPool();

    const result = await createDeviceEnrollment({
      pool: database.pool,
      accountId: "account_demo",
      input: { name: "Office Mac", platform: "MACOS" },
      tokenPepper,
      appBaseUrl
    });

    expect(result.device).toMatchObject({
      name: "Office Mac",
      os: "MACOS",
      status: "WAITING",
      promptCount: 0
    });
    expect(result.enrollment).toMatchObject({
      accountId: "account_demo",
      deviceId: result.device.id,
      syncUrl: `${appBaseUrl}/api/v1/sync/batches`
    });
    expect(result.enrollment.deviceToken).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.stringify(result).split(result.enrollment.deviceToken).length - 1
    ).toBe(1);

    const tokenInsert = database.calls.find((call) =>
      call.sql.includes("INSERT INTO device_tokens")
    );
    expect(tokenInsert?.values).toContain(
      hashDeviceToken(result.enrollment.deviceToken, tokenPepper)
    );
    expect(JSON.stringify(tokenInsert?.values)).not.toContain(
      result.enrollment.deviceToken
    );
    const auditInsert = database.calls.find((call) =>
      call.sql.includes("INSERT INTO audit_logs")
    );
    expect(JSON.stringify(auditInsert?.values)).not.toContain(
      result.enrollment.deviceToken
    );
    expect(database.connection.commit).toHaveBeenCalledOnce();
    expect(database.connection.rollback).not.toHaveBeenCalled();
    expect(database.connection.release).toHaveBeenCalledOnce();
  });

  it("fails closed when the account does not exist", async () => {
    const database = transactionalPool({ accountExists: false });

    await expect(createDeviceEnrollment({
      pool: database.pool,
      accountId: "missing-account",
      input: { name: "Windows PC", platform: "WINDOWS" },
      tokenPepper,
      appBaseUrl
    })).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND", status: 404 });

    expect(database.calls.some((call) =>
      call.sql.includes("INSERT INTO devices")
    )).toBe(false);
    expect(database.connection.commit).not.toHaveBeenCalled();
    expect(database.connection.rollback).toHaveBeenCalledOnce();
  });

  it("rotates only a device belonging to the authenticated account", async () => {
    const database = transactionalPool();

    await expect(rotateDeviceEnrollmentToken({
      pool: database.pool,
      accountId: "account_demo",
      deviceId: "device_from_another_account",
      tokenPepper,
      appBaseUrl
    })).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND", status: 404 });

    const lookup = database.calls.find((call) =>
      call.sql.includes("FROM devices") && call.sql.includes("FOR UPDATE")
    );
    expect(lookup?.values).toEqual([
      "device_from_another_account",
      "account_demo"
    ]);
    expect(database.calls.some((call) =>
      call.sql.includes("UPDATE device_tokens")
    )).toBe(false);
  });

  it("revokes the old credential and stores only the new token HMAC", async () => {
    const database = transactionalPool({
      device: {
        id: "device_windows_demo",
        name: "Office Windows",
        platform: "WINDOWS",
        status: "ACTIVE",
        last_seen_at: new Date("2026-07-15T02:00:00.000Z"),
        last_synced_at: new Date("2026-07-15T02:00:00.000Z")
      }
    });

    const result = await rotateDeviceEnrollmentToken({
      pool: database.pool,
      accountId: "account_demo",
      deviceId: "device_windows_demo",
      tokenPepper,
      appBaseUrl
    });

    expect(result.device).toMatchObject({
      id: "device_windows_demo",
      os: "WINDOWS",
      status: "WAITING",
      lastSeenAt: null,
      lastSyncAt: null
    });
    const revoke = database.calls.find((call) =>
      call.sql.includes("UPDATE device_tokens")
    );
    expect(revoke?.values).toEqual(["account_demo", "device_windows_demo"]);
    const tokenInsert = database.calls.find((call) =>
      call.sql.includes("INSERT INTO device_tokens")
    );
    expect(tokenInsert?.values).toContain(
      hashDeviceToken(result.enrollment.deviceToken, tokenPepper)
    );
    expect(JSON.stringify(tokenInsert?.values)).not.toContain(
      result.enrollment.deviceToken
    );
    const deviceReset = database.calls.find((call) =>
      call.sql.includes("UPDATE devices")
    );
    expect(deviceReset?.sql).toContain("last_seen_at = NULL");
    expect(deviceReset?.sql).toContain("last_synced_at = NULL");
    expect(database.connection.commit).toHaveBeenCalledOnce();
  });

  it("rolls back device creation when its audit record cannot be written", async () => {
    const database = transactionalPool({ auditFails: true });

    await expect(createDeviceEnrollment({
      pool: database.pool,
      accountId: "account_demo",
      input: { name: "Office Mac", platform: "MACOS" },
      tokenPepper,
      appBaseUrl
    })).rejects.toThrow("synthetic audit failure");

    expect(database.connection.commit).not.toHaveBeenCalled();
    expect(database.connection.rollback).toHaveBeenCalledOnce();
    expect(database.connection.release).toHaveBeenCalledOnce();
  });

  it("rejects unsafe server configuration without echoing it", async () => {
    const weakPepper = "weak-private-value";
    const database = transactionalPool();

    await expect(createDeviceEnrollment({
      pool: database.pool,
      accountId: "account_demo",
      input: { name: "Office Mac", platform: "MACOS" },
      tokenPepper: weakPepper,
      appBaseUrl: "http://user:password@172.18.209.21:3000"
    })).rejects.toThrowError(expect.not.stringContaining(weakPepper));
    expect(database.connection.beginTransaction).not.toHaveBeenCalled();
  });

  it("rejects an app URL containing credentials before opening a transaction", async () => {
    const database = transactionalPool();

    await expect(createDeviceEnrollment({
      pool: database.pool,
      accountId: "account_demo",
      input: { name: "Office Mac", platform: "MACOS" },
      tokenPepper,
      appBaseUrl: "http://user:password@172.18.209.21:3000"
    })).rejects.toMatchObject({
      code: "APP_BASE_URL_NOT_CONFIGURED",
      status: 503
    });
    expect(database.connection.beginTransaction).not.toHaveBeenCalled();
  });

  it("rejects a public plain HTTP sync endpoint", async () => {
    const database = transactionalPool();

    await expect(createDeviceEnrollment({
      pool: database.pool,
      accountId: "account_demo",
      input: { name: "Office Mac", platform: "MACOS" },
      tokenPepper,
      appBaseUrl: "http://203.0.113.10:3000"
    })).rejects.toMatchObject({
      code: "APP_BASE_URL_NOT_CONFIGURED",
      status: 503
    });
    expect(database.connection.beginTransaction).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil'host.example",
    "https://evil;host.example",
    "https://evil$(id).example",
    "https://evil`id`.example",
    "https://evil host.example",
    "https://evil\thost.example",
    "https://例子.测试",
    "https://exam_ple.example",
    "https://-leading-hyphen.example",
    "https://trailing-hyphen-.example"
  ])("rejects an APP_BASE_URL with an unsafe ASCII hostname: %s", async (appBaseUrl) => {
    const database = transactionalPool();

    await expect(createDeviceEnrollment({
      pool: database.pool,
      accountId: "account_demo",
      input: { name: "Office Mac", platform: "MACOS" },
      tokenPepper,
      appBaseUrl
    })).rejects.toMatchObject({
      code: "APP_BASE_URL_NOT_CONFIGURED",
      status: 503
    });
    expect(database.connection.beginTransaction).not.toHaveBeenCalled();
  });

  it("accepts a canonical ASCII HTTPS hostname", async () => {
    const database = transactionalPool();

    const created = await createDeviceEnrollment({
      pool: database.pool,
      accountId: "account_demo",
      input: { name: "Office Mac", platform: "MACOS" },
      tokenPepper,
      appBaseUrl: "https://sync-1.example.com:8443"
    });

    expect(created.enrollment.syncUrl).toBe(
      "https://sync-1.example.com:8443/api/v1/sync/batches"
    );
  });

  it("destroys a connection when rollback fails", async () => {
    const database = transactionalPool({
      auditFails: true,
      rollbackFails: true
    });

    await expect(createDeviceEnrollment({
      pool: database.pool,
      accountId: "account_demo",
      input: { name: "Office Mac", platform: "MACOS" },
      tokenPepper,
      appBaseUrl
    })).rejects.toThrow("synthetic audit failure");

    expect(database.connection.destroy).toHaveBeenCalledOnce();
    expect(database.connection.release).not.toHaveBeenCalled();
  });
});
