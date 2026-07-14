import { eq, sql } from "drizzle-orm";
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
      await transaction
        .insert(devices)
        .values(device)
        .onDuplicateKeyUpdate({
          set: {
            accountId: device.accountId,
            deviceRegistrationId: device.deviceRegistrationId,
            name: device.name,
            platform: device.platform,
            status: device.status,
            updatedAt: sql`CURRENT_TIMESTAMP(6)`
          }
        });
    }

    for (const deviceToken of plan.deviceTokens) {
      const [existingToken] = await transaction
        .select({ id: deviceTokens.id })
        .from(deviceTokens)
        .where(eq(deviceTokens.id, deviceToken.id))
        .limit(1);

      if (existingToken) {
        await transaction
          .update(deviceTokens)
          .set({
            accountId: deviceToken.accountId,
            deviceId: deviceToken.deviceId,
            tokenHmac: deviceToken.tokenHmac,
            label: deviceToken.label,
            revokedAt: null
          })
          .where(eq(deviceTokens.id, deviceToken.id));
      } else {
        await transaction.insert(deviceTokens).values(deviceToken);
      }
    }
  });

  return {
    accountId: plan.account.id,
    deviceIds: {
      macos: plan.devices[0]?.id ?? "",
      windows: plan.devices[1]?.id ?? ""
    },
    deviceCount: plan.devices.length,
    deviceTokenCount: plan.deviceTokens.length
  };
}
