import { sql } from "drizzle-orm";
import type { Database } from "./client";
import {
  buildDemoSeedPlan,
  parseSeedConfig,
  type SeedConfig
} from "./seed-plan";
import { accounts, deviceTokens, devices } from "./schema";

export interface DemoSeedResult {
  accountId: string;
  deviceIds: { macos: string; windows: string };
  deviceCount: number;
  deviceTokenCount: number;
}

export async function runDemoSeed(
  database: Database,
  config: SeedConfig = parseSeedConfig()
): Promise<DemoSeedResult> {
  const plan = buildDemoSeedPlan(config);
  let insertedDeviceTokenCount = 0;

  await database.transaction(async (transaction) => {
    await transaction
      .insert(accounts)
      .values(plan.account)
      .onDuplicateKeyUpdate({
        set: {
          displayName: plan.account.displayName,
          timeZone: plan.account.timeZone,
          updatedAt: sql`CURRENT_TIMESTAMP(6)`
        }
      });

    for (const device of plan.devices) {
      const [insert] = await transaction
        .insert(devices)
        .ignore()
        .values(device);
      if (insert.affectedRows !== 1) continue;

      const deviceToken = plan.deviceTokens.find(
        (candidate) => candidate.deviceId === device.id
      );
      if (!deviceToken) throw new Error("Missing bootstrap device token");

      // Only the transaction that inserted the device may issue its seed
      // credential. INSERT IGNORE makes concurrent and repeated bootstrap
      // attempts deterministic without mutating dashboard-owned device state.
      await transaction.insert(deviceTokens).values(deviceToken);
      insertedDeviceTokenCount += 1;
    }
  });

  return {
    accountId: plan.account.id,
    deviceIds: {
      macos: plan.devices[0]?.id ?? "",
      windows: plan.devices[1]?.id ?? ""
    },
    deviceCount: plan.devices.length,
    deviceTokenCount: insertedDeviceTokenCount
  };
}
