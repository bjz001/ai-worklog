import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildDemoSeedPlan,
  hashDeviceToken,
  parseSeedConfig
} from "./seed-plan";

const seedEnv = {
  APP_ACCOUNT_ID: "account_demo",
  APP_TIME_ZONE: "Asia/Shanghai",
  DEVICE_TOKEN_PEPPER: "p".repeat(32),
  MACOS_DEVICE_ID: "mac-studio",
  WINDOWS_DEVICE_ID: "windows-workstation",
  MACOS_DEVICE_TOKEN: "mac-device-token-that-is-long-enough",
  WINDOWS_DEVICE_TOKEN: "windows-device-token-that-is-long-enough"
};

describe("hashDeviceToken", () => {
  it("uses a keyed SHA-256 HMAC", () => {
    const token = "device-token-that-is-long-enough";
    const pepper = "p".repeat(32);
    const expected = createHmac("sha256", pepper)
      .update(`ai-worklog-device-token-v1\u001f${token}`)
      .digest("hex");

    expect(hashDeviceToken(token, pepper)).toBe(expected);
  });
});

describe("demo seed plan", () => {
  it("creates one account and separate macOS and Windows devices", () => {
    const plan = buildDemoSeedPlan(parseSeedConfig(seedEnv));

    expect(plan.account).toMatchObject({
      id: "account_demo",
      timeZone: "Asia/Shanghai"
    });
    expect(plan.devices.map((device) => device.platform)).toEqual([
      "MACOS",
      "WINDOWS"
    ]);
    expect(plan.devices.map((device) => device.id)).toEqual([
      "mac-studio",
      "windows-workstation"
    ]);
    expect(plan.deviceTokens).toHaveLength(2);
    expect(plan.deviceTokens[0]?.tokenHmac).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.deviceTokens[1]?.tokenHmac).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never retains plaintext device tokens in the seed plan", () => {
    const planJson = JSON.stringify(buildDemoSeedPlan(parseSeedConfig(seedEnv)));

    expect(planJson).not.toContain(seedEnv.MACOS_DEVICE_TOKEN);
    expect(planJson).not.toContain(seedEnv.WINDOWS_DEVICE_TOKEN);
    expect(planJson).not.toContain(seedEnv.DEVICE_TOKEN_PEPPER);
  });

  it("rejects a weak pepper without echoing it", () => {
    const weakPepper = "weak-pepper";

    expect(() =>
      parseSeedConfig({ ...seedEnv, DEVICE_TOKEN_PEPPER: weakPepper })
    ).toThrowError(expect.not.stringContaining(weakPepper));
  });

  it("rejects reusing one token for both devices", () => {
    expect(() =>
      parseSeedConfig({
        ...seedEnv,
        WINDOWS_DEVICE_TOKEN: seedEnv.MACOS_DEVICE_TOKEN
      })
    ).toThrow(/MACOS_DEVICE_TOKEN|WINDOWS_DEVICE_TOKEN/);
  });

  it("rejects reusing one device identity for both machines", () => {
    expect(() =>
      parseSeedConfig({
        ...seedEnv,
        WINDOWS_DEVICE_ID: seedEnv.MACOS_DEVICE_ID
      })
    ).toThrow(/MACOS_DEVICE_ID|WINDOWS_DEVICE_ID/);
  });
});
