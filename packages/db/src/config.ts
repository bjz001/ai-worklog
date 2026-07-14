import type { PoolOptions } from "mysql2";
import { z } from "zod";

export type Environment = Record<string, string | undefined>;

const DatabaseEnvironmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  MYSQL_HOST: z.string().trim().min(1).max(255),
  MYSQL_PORT: z.coerce.number().int().min(1).max(65_535).default(3306),
  MYSQL_USER: z.string().trim().min(1).max(128),
  MYSQL_PASSWORD: z.string().max(1024),
  MYSQL_DATABASE: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/, "must contain only letters, numbers, or underscores")
    .max(64),
  MYSQL_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ALLOW_INSECURE_MYSQL: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  MYSQL_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  MYSQL_QUEUE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(100)
});

export interface DatabaseConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  allowInsecure: boolean;
  connectionLimit: number;
  queueLimit: number;
}

export class DatabaseConfigurationError extends Error {
  override readonly name = "DatabaseConfigurationError";
}

function configurationError(issues: z.core.$ZodIssue[]): DatabaseConfigurationError {
  const fields = [...new Set(issues.map((issue) => issue.path.join(".")))]
    .filter(Boolean)
    .join(", ");

  return new DatabaseConfigurationError(
    `Invalid database configuration${fields ? `: ${fields}` : ""}`
  );
}

export function parseDatabaseConfig(
  environment: Environment = process.env
): DatabaseConfig {
  const parsed = DatabaseEnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw configurationError(parsed.error.issues);
  }

  const values = parsed.data;
  if (values.NODE_ENV === "production") {
    if (values.MYSQL_USER.toLowerCase() === "root") {
      throw new DatabaseConfigurationError(
        "Invalid production database configuration: root is not allowed"
      );
    }
    if (values.MYSQL_PASSWORD.trim().length === 0) {
      throw new DatabaseConfigurationError(
        "Invalid production database configuration: password is required"
      );
    }
    if (!values.MYSQL_SSL && !values.ALLOW_INSECURE_MYSQL) {
      throw new DatabaseConfigurationError(
        "Invalid production database configuration: TLS is required unless ALLOW_INSECURE_MYSQL=true"
      );
    }
  }

  return {
    nodeEnv: values.NODE_ENV,
    host: values.MYSQL_HOST,
    port: values.MYSQL_PORT,
    user: values.MYSQL_USER,
    password: values.MYSQL_PASSWORD,
    database: values.MYSQL_DATABASE,
    ssl: values.MYSQL_SSL,
    allowInsecure: values.ALLOW_INSECURE_MYSQL,
    connectionLimit: values.MYSQL_CONNECTION_LIMIT,
    queueLimit: values.MYSQL_QUEUE_LIMIT
  };
}

export function toPoolOptions(config: DatabaseConfig): PoolOptions {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    charset: "utf8mb4",
    timezone: "Z",
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    queueLimit: config.queueLimit,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    multipleStatements: false,
    ssl: config.ssl
      ? { minVersion: "TLSv1.2", rejectUnauthorized: true }
      : undefined
  };
}
