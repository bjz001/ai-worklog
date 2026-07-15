import type { Database } from "./client";
import { describe, expect, it, vi } from "vitest";
import { runDemoSeed } from "./seeding";
import { accounts, deviceTokens, devices } from "./schema";

const seedConfig = {
  accountId: "account_demo",
  timeZone: "Asia/Shanghai",
  tokenPepper: "p".repeat(32),
  macosDeviceId: "device_macos_demo",
  windowsDeviceId: "device_windows_demo",
  macosDeviceToken: "m".repeat(32),
  windowsDeviceToken: "w".repeat(32)
};

function seedDatabase(deviceAffectedRows: Record<string, number>) {
  const insertedTokens: Array<Record<string, unknown>> = [];
  const insertedDevices: Array<Record<string, unknown>> = [];
  const ignoreDeviceConflict = vi.fn(() => ({
    values: vi.fn(async (value: Record<string, unknown>) => {
      insertedDevices.push(value);
      return [
        { affectedRows: deviceAffectedRows[String(value.id)] ?? 0 },
        []
      ];
    })
  }));
  const accountOnDuplicate = vi.fn(async () => [
    { affectedRows: 2 },
    []
  ]);
  const transaction = {
    insert: vi.fn((table: unknown) => {
      if (table === accounts) {
        return {
          values: vi.fn(() => ({
            onDuplicateKeyUpdate: accountOnDuplicate
          }))
        };
      }
      if (table === devices) {
        return { ignore: ignoreDeviceConflict };
      }
      if (table === deviceTokens) {
        return {
          values: vi.fn(async (value: Record<string, unknown>) => {
            insertedTokens.push(value);
            return [{ affectedRows: 1 }, []];
          })
        };
      }
      throw new Error("Unexpected seed table");
    })
  };
  return {
    database: {
      transaction: vi.fn(
        async (operation: (value: typeof transaction) => unknown) =>
          operation(transaction)
      )
    } as unknown as Database,
    insertedDevices,
    insertedTokens,
    ignoreDeviceConflict
  };
}

describe("runDemoSeed token bootstrap", () => {
  it("does not restore seed credentials for existing devices with zero token rows", async () => {
    const fixture = seedDatabase({
      device_macos_demo: 0,
      device_windows_demo: 0
    });

    const result = await runDemoSeed(fixture.database, seedConfig);

    expect(fixture.insertedTokens).toEqual([]);
    expect(result.deviceTokenCount).toBe(0);
  });

  it("issues bootstrap credentials only for freshly inserted devices", async () => {
    const fixture = seedDatabase({
      device_macos_demo: 1,
      device_windows_demo: 1
    });

    const result = await runDemoSeed(fixture.database, seedConfig);

    expect(fixture.insertedTokens.map((token) => token.deviceId)).toEqual([
      "device_macos_demo",
      "device_windows_demo"
    ]);
    expect(result.deviceTokenCount).toBe(2);
  });

  it("does not overwrite or reactivate an existing online-managed token", async () => {
    const fixture = seedDatabase({
      device_macos_demo: 0,
      device_windows_demo: 0
    });

    await runDemoSeed(fixture.database, seedConfig);

    expect(fixture.insertedTokens).toEqual([]);
  });

  it("does not reactivate or reassign an existing seeded device", async () => {
    const fixture = seedDatabase({
      device_macos_demo: 0,
      device_windows_demo: 0
    });

    await runDemoSeed(fixture.database, seedConfig);

    expect(fixture.insertedDevices).toHaveLength(2);
    expect(fixture.ignoreDeviceConflict).toHaveBeenCalledTimes(2);
    expect(fixture.insertedTokens).toEqual([]);
  });

  it("issues a token only for the device won by this bootstrap transaction", async () => {
    const fixture = seedDatabase({
      device_macos_demo: 0,
      device_windows_demo: 1
    });

    const result = await runDemoSeed(fixture.database, seedConfig);

    expect(fixture.insertedTokens.map((token) => token.deviceId)).toEqual([
      "device_windows_demo"
    ]);
    expect(result.deviceTokenCount).toBe(1);
  });
});
