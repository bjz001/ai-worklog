import { describe, expect, it, vi } from "vitest";
import {
  getLlmSettingsView,
  type LlmSettingsQueryExecutor,
  normalizeLlmBaseUrl,
  saveLlmSettings
} from "./llm-settings-service";
import {
  DEFAULT_SUMMARY_PROMPTS,
  buildSummarySystemPrompt
} from "./summary-prompts";

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
      updatedAt: null,
      summaryPrompts: {
        daily: {
          instructions: DEFAULT_SUMMARY_PROMPTS.daily,
          defaultInstructions: DEFAULT_SUMMARY_PROMPTS.daily,
          effectivePrompt: buildSummarySystemPrompt(
            "DAILY",
            DEFAULT_SUMMARY_PROMPTS.daily
          ),
          isCustomized: false
        },
        weekly: {
          instructions: DEFAULT_SUMMARY_PROMPTS.weekly,
          defaultInstructions: DEFAULT_SUMMARY_PROMPTS.weekly,
          effectivePrompt: buildSummarySystemPrompt(
            "WEEK",
            DEFAULT_SUMMARY_PROMPTS.weekly
          ),
          isCustomized: false
        },
        monthly: {
          instructions: DEFAULT_SUMMARY_PROMPTS.monthly,
          defaultInstructions: DEFAULT_SUMMARY_PROMPTS.monthly,
          effectivePrompt: buildSummarySystemPrompt(
            "MONTH",
            DEFAULT_SUMMARY_PROMPTS.monthly
          ),
          isCustomized: false
        }
      }
    });
  });

  it("returns custom guidance while keeping the effective safety contract", async () => {
    const pool: LlmSettingsQueryExecutor = {
      execute: async () => [[{
        provider: "DEEPSEEK",
        base_url: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        encrypted_api_key: "ciphertext",
        daily_summary_prompt: "突出当天已完成的用户价值。",
        weekly_summary_prompt: null,
        monthly_summary_prompt: null,
        updated_at: new Date("2026-07-15T08:00:00.000Z")
      }], []]
    };

    const result = await getLlmSettingsView({
      pool,
      accountId: "account_demo"
    });

    expect(result.summaryPrompts.daily).toMatchObject({
      instructions: "突出当天已完成的用户价值。",
      defaultInstructions: DEFAULT_SUMMARY_PROMPTS.daily,
      isCustomized: true
    });
    expect(result.summaryPrompts.daily.effectivePrompt).toContain(
      "evidenceIds"
    );
    expect(result.summaryPrompts.weekly.isCustomized).toBe(false);
  });

  it("preserves stored prompt overrides when an update omits summaryPrompts", async () => {
    const existing = {
      provider: "DEEPSEEK",
      base_url: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      encrypted_api_key: "v1.synthetic.ciphertext.envelope",
      daily_summary_prompt: "保留日总结要求。",
      weekly_summary_prompt: null,
      monthly_summary_prompt: "保留月总结要求。",
      updated_at: new Date("2026-07-15T08:00:00.000Z")
    };
    let selectCount = 0;
    let writtenValues: unknown[] = [];
    const pool: LlmSettingsQueryExecutor = {
      execute: async (sql: string, parameters?: unknown) => {
        if (sql.includes("SELECT provider")) {
          selectCount += 1;
          if (selectCount === 1) return [[existing], []];
          return [[{
            ...existing,
            daily_summary_prompt: writtenValues[5],
            weekly_summary_prompt: writtenValues[6],
            monthly_summary_prompt: writtenValues[7],
            updated_at: new Date("2026-07-15T09:00:00.000Z")
          }], []];
        }
        if (sql.includes("INSERT INTO llm_settings")) {
          writtenValues = Array.isArray(parameters) ? parameters : [];
        }
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
        model: "deepseek-v4-flash"
      }
    });

    expect(writtenValues.slice(5, 8)).toEqual([
      "保留日总结要求。",
      null,
      "保留月总结要求。"
    ]);
    expect(result.summaryPrompts.daily.instructions).toBe("保留日总结要求。");
    expect(result.summaryPrompts.weekly.defaultInstructions).toBe(
      DEFAULT_SUMMARY_PROMPTS.weekly
    );
  });

  it("restores defaults when prompt overrides are explicitly null", async () => {
    const existing = {
      provider: "DEEPSEEK",
      base_url: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      encrypted_api_key: "v1.synthetic.ciphertext.envelope",
      daily_summary_prompt: "旧日总结要求。",
      weekly_summary_prompt: "旧周总结要求。",
      monthly_summary_prompt: "旧月总结要求。",
      updated_at: new Date("2026-07-15T08:00:00.000Z")
    };
    let selectCount = 0;
    let writtenValues: unknown[] = [];
    const pool: LlmSettingsQueryExecutor = {
      execute: async (sql: string, parameters?: unknown) => {
        if (sql.includes("SELECT provider")) {
          selectCount += 1;
          if (selectCount === 1) return [[existing], []];
          return [[{
            ...existing,
            daily_summary_prompt: writtenValues[5],
            weekly_summary_prompt: writtenValues[6],
            monthly_summary_prompt: writtenValues[7],
            updated_at: new Date("2026-07-15T09:00:00.000Z")
          }], []];
        }
        if (sql.includes("INSERT INTO llm_settings")) {
          writtenValues = Array.isArray(parameters) ? parameters : [];
        }
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
        summaryPrompts: {
          daily: null,
          weekly: null,
          monthly: null
        }
      }
    });

    expect(writtenValues.slice(5, 8)).toEqual([null, null, null]);
    expect(result.summaryPrompts.daily).toMatchObject({
      instructions: DEFAULT_SUMMARY_PROMPTS.daily,
      defaultInstructions: DEFAULT_SUMMARY_PROMPTS.daily,
      isCustomized: false
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
