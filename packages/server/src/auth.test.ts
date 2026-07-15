import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import {
  authenticateDevice,
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

describe("authenticateDevice", () => {
  it("returns the identity only after the active credential touch succeeds", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[{
        token_id: "token-1",
        account_id: "account_demo",
        device_id: "device_demo"
      }], []])
      .mockResolvedValueOnce([{ affectedRows: 2 }, []]);

    await expect(authenticateDevice({
      pool: { execute } as unknown as Pool,
      authorization: `Bearer ${"t".repeat(32)}`,
      tokenPepper: "p".repeat(32)
    })).resolves.toEqual({
      accountId: "account_demo",
      deviceId: "device_demo",
      deviceTokenId: "token-1"
    });
  });

  it("rejects a token revoked between lookup and credential touch", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[{
        token_id: "token-1",
        account_id: "account_demo",
        device_id: "device_demo"
      }], []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    const pool = { execute } as unknown as Pool;

    await expect(authenticateDevice({
      pool,
      authorization: `Bearer ${"t".repeat(32)}`,
      tokenPepper: "p".repeat(32)
    })).rejects.toBeInstanceOf(InvalidAuthorizationError);

    expect(execute.mock.calls[1]?.[0]).toContain("dt.revoked_at IS NULL");
    expect(execute.mock.calls[1]?.[0]).toContain("d.status = 'ACTIVE'");
  });
});
