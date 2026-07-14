import { describe, expect, it } from "vitest";
import { parseDatabaseConfig, toPoolOptions } from "./config";

const validEnv = {
  NODE_ENV: "development",
  MYSQL_HOST: "db.internal",
  MYSQL_PORT: "3306",
  MYSQL_USER: "ai_worklog_app",
  MYSQL_PASSWORD: "a-local-only-password",
  MYSQL_DATABASE: "ai_worklog",
  MYSQL_SSL: "false",
  MYSQL_CONNECTION_LIMIT: "12",
  MYSQL_QUEUE_LIMIT: "80"
};

describe("parseDatabaseConfig", () => {
  it("accepts an explicitly configured development database", () => {
    const config = parseDatabaseConfig(validEnv);

    expect(config).toMatchObject({
      host: "db.internal",
      port: 3306,
      user: "ai_worklog_app",
      database: "ai_worklog",
      ssl: false,
      connectionLimit: 12,
      queueLimit: 80
    });
  });

  it("allows a password-protected root account only outside production", () => {
    expect(() =>
      parseDatabaseConfig({ ...validEnv, MYSQL_USER: "root" })
    ).not.toThrow();
  });

  it("rejects root and empty passwords in production", () => {
    expect(() =>
      parseDatabaseConfig({
        ...validEnv,
        NODE_ENV: "production",
        MYSQL_USER: "root"
      })
    ).toThrow(/root/i);

    expect(() =>
      parseDatabaseConfig({
        ...validEnv,
        NODE_ENV: "production",
        MYSQL_PASSWORD: ""
      })
    ).toThrow(/password/i);
  });

  it("requires TLS in production unless the private-network exception is explicit", () => {
    expect(() =>
      parseDatabaseConfig({ ...validEnv, NODE_ENV: "production" })
    ).toThrow(/TLS/);
    expect(() =>
      parseDatabaseConfig({
        ...validEnv,
        NODE_ENV: "production",
        ALLOW_INSECURE_MYSQL: "true"
      })
    ).not.toThrow();
    expect(() =>
      parseDatabaseConfig({
        ...validEnv,
        NODE_ENV: "production",
        MYSQL_SSL: "true"
      })
    ).not.toThrow();
  });

  it("never echoes a rejected password in its error", () => {
    const secret = "must-never-appear-in-an-error";

    expect(() =>
      parseDatabaseConfig({
        ...validEnv,
        MYSQL_PORT: "not-a-port",
        MYSQL_PASSWORD: secret
      })
    ).toThrowError(expect.not.stringContaining(secret));
  });

  it("rejects database identifiers that cannot be safely quoted", () => {
    expect(() =>
      parseDatabaseConfig({
        ...validEnv,
        MYSQL_DATABASE: "ai_worklog`; DROP DATABASE mysql; --"
      })
    ).toThrow(/MYSQL_DATABASE/);
  });
});

describe("toPoolOptions", () => {
  it("pins client conversion and connection settings to UTC and utf8mb4", () => {
    const options = toPoolOptions(parseDatabaseConfig(validEnv));

    expect(options).toMatchObject({
      timezone: "Z",
      charset: "utf8mb4",
      multipleStatements: false,
      connectionLimit: 12,
      queueLimit: 80
    });
  });
});
