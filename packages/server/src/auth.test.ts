import { describe, expect, it } from "vitest";
import {
  InvalidAuthorizationError,
  parseBearerToken,
  parseServerIdentity
} from "./auth";

describe("parseBearerToken", () => {
  it("accepts one bounded bearer credential without logging it", () => {
    const token = "a".repeat(48);

    expect(parseBearerToken(`Bearer ${token}`)).toBe(token);
  });

  it.each([
    null,
    "",
    "Basic abc",
    "Bearer short",
    `Bearer ${"x".repeat(513)}`,
    `Bearer ${"x".repeat(32)} extra`
  ])("rejects malformed authorization: %s", (header) => {
    expect(() => parseBearerToken(header)).toThrow(InvalidAuthorizationError);
  });
});

describe("parseServerIdentity", () => {
  it("takes the account only from trusted server environment", () => {
    expect(parseServerIdentity({ APP_ACCOUNT_ID: "account_demo" })).toEqual({
      accountId: "account_demo"
    });
  });

  it("rejects identifiers that could alter SQL or account scope", () => {
    expect(() =>
      parseServerIdentity({ APP_ACCOUNT_ID: "account_demo' OR 1=1" })
    ).toThrow("APP_ACCOUNT_ID");
  });

  it("fails closed when the production account scope is missing", () => {
    expect(() => parseServerIdentity({ NODE_ENV: "production" })).toThrow(
      "APP_ACCOUNT_ID"
    );
  });
});
