import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Environment } from "./config";

const SeedEnvironmentSchema = z.object({
  APP_ACCOUNT_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .min(3)
    .max(64)
    .default("account_demo"),
  APP_TIME_ZONE: z.string().trim().min(1).max(64).default("Asia/Shanghai"),
  DEVICE_TOKEN_PEPPER: z.string().min(32).max(1024),
  MACOS_DEVICE_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .min(3)
    .max(64)
    .default("device_macos_demo"),
  WINDOWS_DEVICE_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .min(3)
    .max(64)
    .default("device_windows_demo"),
  MACOS_DEVICE_TOKEN: z.string().min(32).max(512),
  WINDOWS_DEVICE_TOKEN: z.string().min(32).max(512)
});

export interface SeedConfig {
  accountId: string;
  timeZone: string;
  tokenPepper: string;
  macosDeviceId: string;
  windowsDeviceId: string;
  macosDeviceToken: string;
  windowsDeviceToken: string;
}

export interface DemoSeedPlan {
  account: {
    id: string;
    displayName: string;
    timeZone: string;
  };
  devices: Array<{
    id: string;
    accountId: string;
    deviceRegistrationId: string;
    name: string;
    platform: "MACOS" | "WINDOWS";
    status: "ACTIVE";
  }>;
  deviceTokens: Array<{
    id: string;
    accountId: string;
    deviceId: string;
    tokenHmac: string;
    label: string;
  }>;
}

function seedConfigurationError(fields: string[]): Error {
  const suffix = fields.length > 0 ? `: ${[...new Set(fields)].join(", ")}` : "";
  return new Error(`Invalid seed configuration${suffix}`);
}

export function parseSeedConfig(
  environment: Environment = process.env
): SeedConfig {
  const parsed = SeedEnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw seedConfigurationError(
      parsed.error.issues.map((issue) => issue.path.join("."))
    );
  }

  if (parsed.data.MACOS_DEVICE_TOKEN === parsed.data.WINDOWS_DEVICE_TOKEN) {
    throw seedConfigurationError([
      "MACOS_DEVICE_TOKEN",
      "WINDOWS_DEVICE_TOKEN"
    ]);
  }
  if (parsed.data.MACOS_DEVICE_ID === parsed.data.WINDOWS_DEVICE_ID) {
    throw seedConfigurationError(["MACOS_DEVICE_ID", "WINDOWS_DEVICE_ID"]);
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.APP_TIME_ZONE });
  } catch {
    throw seedConfigurationError(["APP_TIME_ZONE"]);
  }

  return {
    accountId: parsed.data.APP_ACCOUNT_ID,
    timeZone: parsed.data.APP_TIME_ZONE,
    tokenPepper: parsed.data.DEVICE_TOKEN_PEPPER,
    macosDeviceId: parsed.data.MACOS_DEVICE_ID,
    windowsDeviceId: parsed.data.WINDOWS_DEVICE_ID,
    macosDeviceToken: parsed.data.MACOS_DEVICE_TOKEN,
    windowsDeviceToken: parsed.data.WINDOWS_DEVICE_TOKEN
  };
}

export function hashDeviceToken(token: string, pepper: string): string {
  return createHmac("sha256", pepper)
    .update(`ai-worklog-device-token-v1\u001f${token}`)
    .digest("hex");
}

export function buildDemoSeedPlan(config: SeedConfig): DemoSeedPlan {
  const macosDeviceId = config.macosDeviceId;
  const windowsDeviceId = config.windowsDeviceId;

  return {
    account: {
      id: config.accountId,
      displayName: "Demo account",
      timeZone: config.timeZone
    },
    devices: [
      {
        id: macosDeviceId,
        accountId: config.accountId,
        deviceRegistrationId: macosDeviceId,
        name: "Demo Mac",
        platform: "MACOS",
        status: "ACTIVE"
      },
      {
        id: windowsDeviceId,
        accountId: config.accountId,
        deviceRegistrationId: windowsDeviceId,
        name: "Demo Windows",
        platform: "WINDOWS",
        status: "ACTIVE"
      }
    ],
    deviceTokens: [
      {
        id: "device_token_macos_demo",
        accountId: config.accountId,
        deviceId: macosDeviceId,
        tokenHmac: hashDeviceToken(config.macosDeviceToken, config.tokenPepper),
        label: "macOS collector"
      },
      {
        id: "device_token_windows_demo",
        accountId: config.accountId,
        deviceId: windowsDeviceId,
        tokenHmac: hashDeviceToken(config.windowsDeviceToken, config.tokenPepper),
        label: "Windows collector"
      }
    ]
  };
}
