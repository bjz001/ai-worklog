import type { Pool } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { listDevices } from "./query-service";

describe("listDevices enrollment status", () => {
  it("distinguishes missing, unused, healthy, and stale active credentials", async () => {
    const now = Date.now();
    const pool = {
      async execute(sql: string, values: unknown[]) {
        expect(sql).toContain("FROM device_tokens");
        expect(sql).toContain("revoked_at IS NULL");
        expect(values).toEqual(["account_demo"]);
        return [[
          {
            id: "device-no-token",
            name: "No token",
            platform: "MACOS",
            status: "ACTIVE",
            last_seen_at: null,
            last_synced_at: null,
            prompt_count: 0,
            active_token_count: 0,
            active_token_last_used_at: null
          },
          {
            id: "device-new-token",
            name: "New token",
            platform: "WINDOWS",
            status: "ACTIVE",
            last_seen_at: new Date(now),
            last_synced_at: new Date(now),
            prompt_count: 2,
            active_token_count: 1,
            active_token_last_used_at: null
          },
          {
            id: "device-healthy",
            name: "Healthy",
            platform: "MACOS",
            status: "ACTIVE",
            last_seen_at: new Date(now),
            last_synced_at: new Date(now),
            prompt_count: 4,
            active_token_count: 1,
            active_token_last_used_at: new Date(now)
          },
          {
            id: "device-stale",
            name: "Stale",
            platform: "WINDOWS",
            status: "ACTIVE",
            last_seen_at: new Date(now - 49 * 60 * 60 * 1000),
            last_synced_at: new Date(now - 49 * 60 * 60 * 1000),
            prompt_count: 3,
            active_token_count: 1,
            active_token_last_used_at: new Date(now - 49 * 60 * 60 * 1000)
          }
        ], []];
      }
    } as unknown as Pool;

    const devices = await listDevices(pool, "account_demo");

    expect(devices.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "device-no-token", status: "NOT_CONFIGURED" },
      { id: "device-new-token", status: "WAITING" },
      { id: "device-healthy", status: "SUCCESS" },
      { id: "device-stale", status: "OFFLINE" }
    ]);
  });
});
