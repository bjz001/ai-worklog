import { describe, expect, it, vi } from "vitest";
import {
  getLlmSettingsView,
  type LlmSettingsQueryExecutor,
  normalizeLlmBaseUrl,
  saveLlmSettings
} from "./llm-settings-service";

describe("normalizeLlmBaseUrl", () => {
  it("normalizes the official DeepSeek endpoint", () => {
    expect(
      normalizeLlmBaseUrl("DEEPSEEK", "https://api.deepseek.com/")
    ).toBe("https://api.deepseek.com");
  });

  it.each([
    "http://api.deepseek.com",
    "https://api.deepseek.com?forward=1",
    "https://user:pass@api.deepseek.com",
    "https://example.com"
  ])("rejects an unsafe DeepSeek endpoint: %s", (value) => {
    expect(() => normalizeLlmBaseUrl("DEEPSEEK", value)).toThrow(
      "DeepSeek endpoint"
    );
  });

  it("rejects private OpenAI-compatible destinations", () => {
    expect(() =>
      normalizeLlmBaseUrl("OPENAI_COMPATIBLE", "https://127.0.0.1:8443")
    ).toThrow("public HTTPS");
    expect(() =>
      normalizeLlmBaseUrl("OPENAI_COMPATIBLE", "https://localhost")
    ).toThrow("public HTTPS");
  });

  it.each([
    "https://[::ffff:7f00:1]",
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:a00:1]",
    "https://[::ffff:c0a8:1]",
    "https://[::ffff:0:7f00:1]"
  ])("rejects a private IPv4-mapped IPv6 literal: %s", (value) => {
    expect(() => normalizeLlmBaseUrl("OPENAI_COMPATIBLE", value)).toThrow(
      "public HTTPS"
    );
  });

  it.each([
    "https://[::808:808]",
    "https://[::ffff:808:808]",
    "https://[::ffff:0:808:808]",
    "https://[64:ff9b::808:808]",
    "https://[64:ff9b:1::7f00:1]",
    "https://[100:0:0:1::1]",
    "https://[2001:2::1]",
    "https://[2001::1]",
    "https://[2001:20::1]",
    "https://[2001:db8::1]",
    "https://[2002:808:808::1]",
    "https://[2620:4f:8000::1]",
    "https://[3ffe::1]",
    "https://[3fff::1]",
    "https://[5f00::1]",
    "https://[fec0::1]",
    "https://[ff02::1]"
  ])("rejects a special-purpose IPv6 literal: %s", (value) => {
    expect(() => normalizeLlmBaseUrl("OPENAI_COMPATIBLE", value)).toThrow(
      "public HTTPS"
    );
  });

  it.each([
    "https://[2606:4700:4700::1111]",
    "https://[2001:4860:4860::8888]",
    "https://[2001:200::1]"
  ])("allows a globally routable IPv6 literal: %s", (value) => {
    expect(normalizeLlmBaseUrl("OPENAI_COMPATIBLE", value)).toBe(value);
  });
});

describe("LLM settings persistence", () => {
  const masterKey = Buffer.from("22".repeat(32), "hex");

  it("returns safe DeepSeek defaults when no credential exists", async () => {
    const pool: LlmSettingsQueryExecutor = {
      execute: async () => [[], []]
    };

    await expect(
      getLlmSettingsView({ pool, accountId: "account_demo" })
    ).resolves.toEqual({
      provider: "DEEPSEEK",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      hasApiKey: false,
      updatedAt: null
    });
  });

  it("encrypts a new credential and never returns it", async () => {
    const writes: unknown[][] = [];
    let selectCount = 0;
    const pool: LlmSettingsQueryExecutor = {
      execute: async (sql: string, parameters?: unknown) => {
        const values = Array.isArray(parameters) ? parameters : [];
        if (sql.includes("SELECT provider")) {
          selectCount += 1;
          if (selectCount === 1) return [[], []];
          return [[{
            provider: "DEEPSEEK",
            base_url: "https://api.deepseek.com",
            model: "deepseek-v4-flash",
            encrypted_api_key: "ciphertext",
            updated_at: new Date("2026-07-15T08:00:00.000Z")
          }], []];
        }
        if (sql.includes("INSERT INTO llm_settings")) writes.push(values);
        return [{ affectedRows: 1 }, []];
      }
    };

    const result = await saveLlmSettings({
      pool,
      accountId: "account_demo",
      masterKey,
      input: {
        provider: "DEEPSEEK",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        apiKey: "sk-test-only-secret"
      }
    });

    expect(writes).toHaveLength(1);
    expect(String(writes[0]?.[4])).not.toContain("sk-test-only-secret");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.hasApiKey).toBe(true);
  });

  it("requires a credential when configuring an account for the first time", async () => {
    const pool: LlmSettingsQueryExecutor = {
      execute: async () => [[], []]
    };

    await expect(
      saveLlmSettings({
        pool,
        accountId: "account_demo",
        masterKey,
        input: {
          provider: "DEEPSEEK",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash"
        }
      })
    ).rejects.toMatchObject({ code: "LLM_API_KEY_REQUIRED", status: 400 });
  });

  it("never forwards a saved credential when the provider or origin changes", async () => {
    const existing = {
      provider: "DEEPSEEK",
      base_url: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      encrypted_api_key: "v1.synthetic.ciphertext.envelope",
      updated_at: new Date("2026-07-15T08:00:00.000Z")
    };
    const pool: LlmSettingsQueryExecutor = {
      execute: async (sql: string) =>
        sql.includes("SELECT provider") ? [[existing], []] : [{ affectedRows: 1 }, []]
    };

    await expect(
      saveLlmSettings({
        pool,
        accountId: "account_demo",
        masterKey,
        input: {
          provider: "OPENAI_COMPATIBLE",
          baseUrl: "https://example.com/v1",
          model: "synthetic-model"
        }
      })
    ).rejects.toMatchObject({ code: "LLM_API_KEY_REQUIRED", status: 400 });
  });

  it("rolls back the setting when its audit record cannot be written", async () => {
    const connection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT provider")) return [[], []];
        if (sql.includes("INSERT INTO llm_settings")) {
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes("INSERT INTO audit_logs")) {
          throw new Error("synthetic audit failure");
        }
        return [[], []];
      })
    };
    const pool = {
      execute: vi.fn(),
      getConnection: vi.fn().mockResolvedValue(connection)
    };

    await expect(
      saveLlmSettings({
        pool: pool as unknown as LlmSettingsQueryExecutor,
        accountId: "account_demo",
        masterKey,
        input: {
          provider: "DEEPSEEK",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          apiKey: "sk-test-only-secret"
        }
      })
    ).rejects.toThrow("synthetic audit failure");

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.execute.mock.calls[0]?.[0]).toContain(
      "SELECT id FROM accounts"
    );
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });
});
