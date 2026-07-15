import { describe, expect, it } from "vitest";

import { lanHttpOrigin, updateAppBaseUrl } from "./config.mjs";

describe("LAN HTTP environment configuration", () => {
  it("builds an origin only for an RFC1918 IPv4 and unprivileged port", () => {
    expect(lanHttpOrigin("172.18.209.21", "3000")).toBe(
      "http://172.18.209.21:3000"
    );
    expect(() => lanHttpOrigin("8.8.8.8", "3000")).toThrow(
      "Invalid LAN HTTP configuration"
    );
    expect(() => lanHttpOrigin("172.18.209.21", "80")).toThrow(
      "Invalid LAN HTTP configuration"
    );
  });

  it("replaces APP_BASE_URL without changing secrets", () => {
    const source = [
      "MYSQL_PASSWORD=do-not-change",
      "APP_BASE_URL=http://127.0.0.1:3000",
      "DASHBOARD_PASSWORD=also-do-not-change",
      ""
    ].join("\n");

    expect(updateAppBaseUrl(source, "http://172.18.209.21:3000")).toBe(
      [
        "MYSQL_PASSWORD=do-not-change",
        "APP_BASE_URL=http://172.18.209.21:3000",
        "DASHBOARD_PASSWORD=also-do-not-change",
        ""
      ].join("\n")
    );
  });

  it("appends a missing APP_BASE_URL and rejects duplicates", () => {
    expect(updateAppBaseUrl("APP_ACCOUNT_ID=account_demo\n", "http://10.0.0.2:3000"))
      .toBe("APP_ACCOUNT_ID=account_demo\nAPP_BASE_URL=http://10.0.0.2:3000\n");
    expect(() =>
      updateAppBaseUrl(
        "APP_BASE_URL=http://10.0.0.1:3000\nAPP_BASE_URL=http://10.0.0.2:3000\n",
        "http://10.0.0.3:3000"
      )
    ).toThrow("Invalid environment file");
  });
});
