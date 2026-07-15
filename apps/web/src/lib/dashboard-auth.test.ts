import { describe, expect, it } from "vitest";
import {
  dashboardAuthConfig,
  hasValidDashboardAuthorization
} from "./dashboard-auth";

describe("dashboard authorization", () => {
  it("accepts only the configured Basic credential", async () => {
    const config = dashboardAuthConfig({
      DASHBOARD_USERNAME: "owner",
      DASHBOARD_PASSWORD: "a-long-local-password"
    });
    const authorization = `Basic ${btoa("owner:a-long-local-password")}`;

    await expect(
      hasValidDashboardAuthorization(authorization, config)
    ).resolves.toBe(true);
    await expect(
      hasValidDashboardAuthorization(`Basic ${btoa("owner:wrong-password")}`, config)
    ).resolves.toBe(false);
  });

  it("fails closed for incomplete or weak configuration", () => {
    expect(() => dashboardAuthConfig({})).toThrow("DASHBOARD");
    expect(() =>
      dashboardAuthConfig({
        DASHBOARD_USERNAME: "owner",
        DASHBOARD_PASSWORD: "short"
      })
    ).toThrow("DASHBOARD");
  });

  it("allows the explicitly approved admin credential only on a private LAN", () => {
    expect(
      dashboardAuthConfig({
        APP_BASE_URL: "http://172.18.209.21:3000",
        DASHBOARD_ALLOW_WEAK_PASSWORD: "true",
        DASHBOARD_USERNAME: "admin",
        DASHBOARD_PASSWORD: "admin"
      })
    ).toEqual({ username: "admin", password: "admin" });

    expect(() =>
      dashboardAuthConfig({
        APP_BASE_URL: "http://172.18.209.21:3000",
        DASHBOARD_USERNAME: "admin",
        DASHBOARD_PASSWORD: "admin"
      })
    ).toThrow("DASHBOARD");

    expect(() =>
      dashboardAuthConfig({
        APP_BASE_URL: "https://worklog.example.com",
        DASHBOARD_ALLOW_WEAK_PASSWORD: "true",
        DASHBOARD_USERNAME: "admin",
        DASHBOARD_PASSWORD: "admin"
      })
    ).toThrow("DASHBOARD");
  });
});
