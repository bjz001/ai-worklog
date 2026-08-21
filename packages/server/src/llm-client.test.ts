import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  assertPublicLlmDestination,
  chatCompletionsUrl,
  requestLlmJson,
  serializeLlmJsonRequest
} from "./llm-client";
import { createPinnedLlmLookup } from "./llm-network-policy";
import { DEFAULT_SUMMARY_PROMPTS } from "./summary-prompts";

const settings = {
  provider: "DEEPSEEK" as const,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  apiKey: "sk-test-only-secret",
  summaryPrompts: {
    daily: DEFAULT_SUMMARY_PROMPTS.daily,
    weekly: DEFAULT_SUMMARY_PROMPTS.weekly,
    monthly: DEFAULT_SUMMARY_PROMPTS.monthly
  }
};

const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];

describe("LLM destination safety", () => {
  it("preserves an OpenAI-compatible base path", () => {
    expect(chatCompletionsUrl("https://example.com/v1")).toBe(
      "https://example.com/v1/chat/completions"
    );
  });

  it("rejects DNS answers containing any private address", async () => {
    await expect(
      assertPublicLlmDestination("https://example.com/v1", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 }
      ])
    ).rejects.toMatchObject({ code: "UNSAFE_LLM_BASE_URL" });
  });

  it.each([
    "::ffff:7f00:1",
    "::ffff:127.0.0.1",
    "::ffff:a00:1",
    "::ffff:ac10:1",
    "::ffff:0:7f00:1"
  ])("rejects private IPv4-mapped IPv6 answer %s", async (address) => {
    await expect(
      assertPublicLlmDestination("https://example.com/v1", async () => [
        { address, family: 6 }
      ])
    ).rejects.toMatchObject({ code: "UNSAFE_LLM_BASE_URL" });
  });

  it.each([
    "::808:808",
    "::ffff:808:808",
    "::ffff:0:808:808",
    "64:ff9b::808:808",
    "64:ff9b:1::7f00:1",
    "100:0:0:1::1",
    "2001:2::1",
    "2001::1",
    "2001:20::1",
    "2001:db8::1",
    "2002:808:808::1",
    "2620:4f:8000::1",
    "3ffe::1",
    "3fff::1",
    "5f00::1",
    "fec0::1",
    "ff02::1"
  ])("rejects special-purpose IPv6 DNS answer %s", async (address) => {
    await expect(
      assertPublicLlmDestination("https://example.com/v1", async () => [
        { address, family: 6 }
      ])
    ).rejects.toMatchObject({ code: "UNSAFE_LLM_BASE_URL" });
  });

  it.each([
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2001:200::1"
  ])("allows globally routable IPv6 DNS answer %s", async (address) => {
    await expect(
      assertPublicLlmDestination("https://example.com/v1", async () => [
        { address, family: 6 }
      ])
    ).resolves.toBeUndefined();
  });

  it("pins HTTPS lookup to a previously verified public address", async () => {
    const pinnedLookup = createPinnedLlmLookup([
      { address: "8.8.8.8", family: 4 }
    ]);
    const answer = await new Promise<{ address: string; family?: number }>(
      (resolve, reject) => {
        pinnedLookup("example.com", {}, (error, address, family) => {
          if (error) {
            reject(error);
          } else if (Array.isArray(address)) {
            reject(new Error("Expected one pinned address"));
          } else {
            resolve({ address, family });
          }
        });
      }
    );

    expect(answer).toEqual({ address: "8.8.8.8", family: 4 });
  });
});

describe("requestLlmJson", () => {
  it("disables DeepSeek thinking mode and reserves enough output for summary JSON", () => {
    const request = JSON.parse(
      serializeLlmJsonRequest(settings, [{ role: "user", content: "test" }])
    ) as Record<string, unknown>;

    expect(request).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" },
      max_tokens: 8_192,
      response_format: { type: "json_object" },
      stream: false
    });
  });

  it("posts a bounded JSON request and validates model JSON", async () => {
    const fetcher = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer sk-test-only-secret"
      );
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    await expect(
      requestLlmJson({
        settings,
        messages: [{ role: "user", content: "test" }],
        schema: z.object({ ok: z.literal(true) }).strict(),
        fetcher,
        resolver: publicResolver
      })
    ).resolves.toMatchObject({ data: { ok: true } });
  });

  it("accepts one complete JSON object wrapped in a Markdown JSON fence", async () => {
    const fetcher = async () => new Response(
      JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: { content: "```json\n{\"ok\":true}\n```" }
        }]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

    await expect(
      requestLlmJson({
        settings,
        messages: [{ role: "user", content: "test" }],
        schema: z.object({ ok: z.literal(true) }).strict(),
        fetcher,
        resolver: publicResolver
      })
    ).resolves.toMatchObject({ data: { ok: true } });
  });

  it("reports truncated and empty model output with actionable error codes", async () => {
    const truncated = async () => new Response(
      JSON.stringify({
        choices: [{
          finish_reason: "length",
          message: { content: "{\"ok\":" }
        }]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    await expect(
      requestLlmJson({
        settings,
        messages: [{ role: "user", content: "test" }],
        schema: z.object({ ok: z.boolean() }),
        fetcher: truncated,
        resolver: publicResolver
      })
    ).rejects.toMatchObject({ code: "LLM_UPSTREAM_OUTPUT_TRUNCATED" });

    const empty = async () => new Response(
      JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: { content: null, reasoning_content: "private reasoning" }
        }]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    await expect(
      requestLlmJson({
        settings,
        messages: [{ role: "user", content: "test" }],
        schema: z.object({ ok: z.boolean() }),
        fetcher: empty,
        resolver: publicResolver
      })
    ).rejects.toMatchObject({
      code: "LLM_UPSTREAM_EMPTY_RESPONSE",
      message: expect.not.stringContaining("private reasoning")
    });
  });

  it("distinguishes malformed JSON from a valid JSON object with the wrong shape", async () => {
    const invalidJson = async () => new Response(
      JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: { content: "{\"ok\":" }
        }]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    await expect(
      requestLlmJson({
        settings,
        messages: [{ role: "user", content: "test" }],
        schema: z.object({ ok: z.literal(true) }).strict(),
        fetcher: invalidJson,
        resolver: publicResolver
      })
    ).rejects.toMatchObject({ code: "LLM_UPSTREAM_INVALID_JSON" });

    const invalidSchema = async () => new Response(
      JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: { content: "{\"ok\":false}" }
        }]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    await expect(
      requestLlmJson({
        settings,
        messages: [{ role: "user", content: "test" }],
        schema: z.object({ ok: z.literal(true) }).strict(),
        fetcher: invalidSchema,
        resolver: publicResolver
      })
    ).rejects.toMatchObject({ code: "LLM_UPSTREAM_INVALID_SCHEMA" });
  });

  it.each([
    [401, "LLM_UPSTREAM_AUTH_FAILED"],
    [429, "LLM_UPSTREAM_RATE_LIMITED"],
    [302, "LLM_UPSTREAM_REDIRECTED"]
  ])("maps upstream status %s without exposing its body", async (status, code) => {
    const fetcher = async () => new Response("sensitive upstream detail", { status });

    await expect(
      requestLlmJson({
        settings,
        messages: [{ role: "user", content: "test" }],
        schema: z.object({ ok: z.boolean() }),
        fetcher,
        resolver: publicResolver
      })
    ).rejects.toMatchObject({ code, message: expect.not.stringContaining("sensitive") });
  });

  it("rejects malformed or oversized responses", async () => {
    const malformed = async () => new Response("not-json", { status: 200 });
    await expect(
      requestLlmJson({
        settings,
        messages: [{ role: "user", content: "test" }],
        schema: z.object({ ok: z.boolean() }),
        fetcher: malformed,
        resolver: publicResolver
      })
    ).rejects.toMatchObject({ code: "LLM_UPSTREAM_INVALID_RESPONSE" });

    const oversized = async () => new Response("x".repeat(300_000), { status: 200 });
    await expect(
      requestLlmJson({
        settings,
        messages: [{ role: "user", content: "test" }],
        schema: z.object({ ok: z.boolean() }),
        fetcher: oversized,
        resolver: publicResolver
      })
    ).rejects.toMatchObject({ code: "LLM_UPSTREAM_INVALID_RESPONSE" });
  });

  it("keeps the timeout active while reading a slow response body and cancels it", async () => {
    let cancelled = false;
    const fetcher = async () => new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        }
      }),
      { status: 200 }
    );

    await expect(
      requestLlmJson({
        settings,
        messages: [{ role: "user", content: "test" }],
        schema: z.object({ ok: z.boolean() }),
        fetcher,
        resolver: publicResolver,
        timeoutMs: 10
      })
    ).rejects.toMatchObject({ code: "LLM_UPSTREAM_TIMEOUT" });
    expect(cancelled).toBe(true);
  });

  it("applies the same deadline while DNS resolution is pending", async () => {
    const fetcher = vi.fn();
    const neverResolvingResolver = async () =>
      new Promise<readonly { address: string; family?: number }[]>(() => undefined);

    await expect(
      requestLlmJson({
        settings,
        messages: [{ role: "user", content: "test" }],
        schema: z.object({ ok: z.boolean() }),
        fetcher,
        resolver: neverResolvingResolver,
        timeoutMs: 10
      })
    ).rejects.toMatchObject({ code: "LLM_UPSTREAM_TIMEOUT" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
