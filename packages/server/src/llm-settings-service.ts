import type {
  LlmProvider,
  LlmSettingsUpdate,
  LlmSettingsView
} from "@ai-worklog/contracts";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { decryptApiKey, encryptApiKey } from "./llm-crypto";
import { isUnsafeLlmHostname } from "./llm-network-policy";

export const DEFAULT_LLM_SETTINGS = {
  provider: "DEEPSEEK" as const,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash"
};

export interface LlmSettingsQueryExecutor {
  execute(sql: string, values?: unknown): Promise<[any, any]>;
}

type QueryExecutor = LlmSettingsQueryExecutor | Pick<Pool | PoolConnection, "execute">;

type TransactionConnection = Pick<
  PoolConnection,
  "beginTransaction" | "commit" | "execute" | "release" | "rollback"
>;

interface TransactionPool extends LlmSettingsQueryExecutor {
  getConnection(): Promise<TransactionConnection>;
}

interface LlmSettingsRow extends RowDataPacket {
  provider: LlmProvider;
  base_url: string;
  model: string;
  encrypted_api_key: string;
  updated_at: Date;
}

export class LlmSettingsError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "LlmSettingsError";
    this.code = code;
    this.status = status;
  }
}

function genericEndpointError(): LlmSettingsError {
  return new LlmSettingsError(
    "INVALID_LLM_BASE_URL",
    400,
    "LLM endpoint must be a public HTTPS URL"
  );
}

function deepSeekEndpointError(): LlmSettingsError {
  return new LlmSettingsError(
    "INVALID_LLM_BASE_URL",
    400,
    "Invalid DeepSeek endpoint; use the official DeepSeek endpoint"
  );
}

export function normalizeLlmBaseUrl(
  provider: LlmProvider,
  input: string
): string {
  const fail = provider === "DEEPSEEK"
    ? deepSeekEndpointError
    : genericEndpointError;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw fail();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isUnsafeLlmHostname(url.hostname)
  ) {
    throw fail();
  }
  if (provider === "DEEPSEEK") {
    if (
      url.hostname.toLowerCase() !== "api.deepseek.com" ||
      (url.pathname !== "/" && url.pathname !== "/v1" && url.pathname !== "/v1/")
    ) {
      throw fail();
    }
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

async function settingsRow(
  pool: QueryExecutor,
  accountId: string
): Promise<LlmSettingsRow | null> {
  const [rows] = await pool.execute<LlmSettingsRow[]>(
    `SELECT provider, base_url, model, encrypted_api_key, updated_at
       FROM llm_settings
      WHERE account_id = ?
      LIMIT 1`,
    [accountId]
  );
  return rows[0] ?? null;
}

function safeView(row: LlmSettingsRow | null): LlmSettingsView {
  if (!row) {
    return {
      ...DEFAULT_LLM_SETTINGS,
      hasApiKey: false,
      updatedAt: null
    };
  }
  return {
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    hasApiKey: row.encrypted_api_key.length > 0,
    updatedAt: row.updated_at.toISOString()
  };
}

export async function getLlmSettingsView(options: {
  pool: QueryExecutor;
  accountId: string;
}): Promise<LlmSettingsView> {
  return safeView(await settingsRow(options.pool, options.accountId));
}

export async function saveLlmSettings(options: {
  pool: QueryExecutor;
  accountId: string;
  input: LlmSettingsUpdate;
  masterKey: Buffer;
}): Promise<LlmSettingsView> {
  const persist = async (executor: QueryExecutor): Promise<LlmSettingsView> => {
    const existing = await settingsRow(executor, options.accountId);
    const credentialScopeUnchanged = Boolean(
      existing &&
      existing.provider === options.input.provider &&
      new URL(existing.base_url).origin === new URL(baseUrl).origin
    );
    const encryptedApiKey = options.input.apiKey
      ? encryptApiKey(options.input.apiKey, options.masterKey, options.accountId)
      : credentialScopeUnchanged
        ? existing?.encrypted_api_key
        : undefined;
    if (!encryptedApiKey) {
      throw new LlmSettingsError(
        "LLM_API_KEY_REQUIRED",
        400,
        existing
          ? "更换 LLM 服务商或域名时需要填写新的 API Key"
          : "首次配置时需要填写 API Key"
      );
    }

    await executor.execute(
      `INSERT INTO llm_settings
         (account_id, provider, base_url, model, encrypted_api_key)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         provider = VALUES(provider),
         base_url = VALUES(base_url),
         model = VALUES(model),
         encrypted_api_key = VALUES(encrypted_api_key),
         updated_at = UTC_TIMESTAMP(6)`,
      [
        options.accountId,
        options.input.provider,
        baseUrl,
        options.input.model,
        encryptedApiKey
      ]
    );
    await executor.execute(
      `INSERT INTO audit_logs
         (account_id, action, resource_type, resource_id, outcome, metadata)
       VALUES (?, 'LLM_SETTINGS_UPDATED', 'LLM_SETTINGS', ?, 'SUCCEEDED', ?)`,
      [
        options.accountId,
        options.accountId,
        JSON.stringify({
          provider: options.input.provider,
          baseUrl,
          model: options.input.model,
          apiKeyChanged: Boolean(options.input.apiKey)
        })
      ]
    );
    const saved = await settingsRow(executor, options.accountId);
    if (!saved) {
      throw new LlmSettingsError(
        "LLM_SETTINGS_NOT_FOUND",
        500,
        "LLM 配置保存后无法读取"
      );
    }
    return safeView(saved);
  };

  const baseUrl = normalizeLlmBaseUrl(
    options.input.provider,
    options.input.baseUrl
  );

  const maybeTransactional = options.pool as Partial<TransactionPool>;
  if (typeof maybeTransactional.getConnection !== "function") {
    return persist(options.pool);
  }
  const connection = await maybeTransactional.getConnection();
  try {
    await connection.beginTransaction();
    // Serialize all credential reuse/rotation decisions for this account. A
    // stable parent row also covers the first-settings race where no settings
    // row exists yet to lock.
    await connection.execute(
      "SELECT id FROM accounts WHERE id = ? FOR UPDATE",
      [options.accountId]
    );
    const result = await persist(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export interface RuntimeLlmSettings {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export async function getRuntimeLlmSettings(options: {
  pool: QueryExecutor;
  accountId: string;
  masterKey: Buffer;
}): Promise<RuntimeLlmSettings> {
  const row = await settingsRow(options.pool, options.accountId);
  if (!row) {
    throw new LlmSettingsError(
      "LLM_NOT_CONFIGURED",
      409,
      "请先配置并验证 LLM"
    );
  }
  return {
    provider: row.provider,
    baseUrl: normalizeLlmBaseUrl(row.provider, row.base_url),
    model: row.model,
    apiKey: decryptApiKey(
      row.encrypted_api_key,
      options.masterKey,
      options.accountId
    )
  };
}
