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
});
