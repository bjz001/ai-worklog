import { z, type ZodType } from "zod";
import {
  defaultLlmResolver,
  pinnedHttpsFetch,
  resolvePublicLlmDestination,
  type LlmResolver,
  type ResolvedLlmAddress
} from "./llm-network-policy";
import type { RuntimeLlmSettings } from "./llm-settings-service";

const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_LLM_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

export type LlmFetcher = (
  input: string,
  init: RequestInit
) => Promise<Response>;

export type { LlmResolver } from "./llm-network-policy";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class LlmUpstreamError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "LlmUpstreamError";
    this.code = code;
    this.status = status;
  }
}

function unsafeDestination(): LlmUpstreamError {
  return new LlmUpstreamError(
    "UNSAFE_LLM_BASE_URL",
    422,
    "LLM 地址未通过公网安全检查"
  );
}

async function verifiedDestination(
  baseUrl: string,
  resolver: LlmResolver
): Promise<readonly ResolvedLlmAddress[]> {
  try {
    return await resolvePublicLlmDestination(baseUrl, resolver);
  } catch {
    throw unsafeDestination();
  }
}

export async function assertPublicLlmDestination(
  baseUrl: string,
  resolver: LlmResolver = defaultLlmResolver
): Promise<void> {
  await verifiedDestination(baseUrl, resolver);
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function upstreamStatusError(status: number): LlmUpstreamError {
  if (status === 401 || status === 403) {
    return new LlmUpstreamError(
      "LLM_UPSTREAM_AUTH_FAILED",
      422,
      "LLM API Key 无效或无权使用当前模型"
    );
  }
  if (status === 429) {
    return new LlmUpstreamError(
      "LLM_UPSTREAM_RATE_LIMITED",
      502,
      "LLM 服务当前限流，请稍后重试"
    );
  }
  if (status >= 300 && status < 400) {
    return new LlmUpstreamError(
      "LLM_UPSTREAM_REDIRECTED",
      502,
      "LLM 服务返回了不安全的重定向"
    );
  }
  return new LlmUpstreamError(
    "LLM_UPSTREAM_UNAVAILABLE",
    502,
    "LLM 服务暂时不可用"
  );
}

function invalidResponse(): LlmUpstreamError {
  return new LlmUpstreamError(
    "LLM_UPSTREAM_INVALID_RESPONSE",
    502,
    "LLM 服务返回了无法识别的结果"
  );
}

async function boundedResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw invalidResponse();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  let rejectOnAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const abortHandler = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
    rejectOnAbort?.(new Error("LLM_RESPONSE_BODY_ABORTED"));
  };
  signal.addEventListener("abort", abortHandler, { once: true });
  try {
    if (signal.aborted) abortHandler();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw new Error("LLM_RESPONSE_BODY_ABORTED");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw invalidResponse();
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    signal.removeEventListener("abort", abortHandler);
    if (signal.aborted) {
      await reader.cancel(signal.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}

const CompletionEnvelopeSchema = z
  .object({
    choices: z
      .array(
        z.object({
          message: z.object({ content: z.string() }).passthrough()
        }).passthrough()
      )
      .min(1)
  })
  .passthrough();

export function serializeLlmJsonRequest(
  settings: Pick<RuntimeLlmSettings, "model">,
  messages: readonly LlmMessage[]
): string {
  return JSON.stringify({
    model: settings.model,
    messages,
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 4_096,
    stream: false
  });
}

export function llmJsonRequestByteLength(
  settings: Pick<RuntimeLlmSettings, "model">,
  messages: readonly LlmMessage[]
): number {
  return Buffer.byteLength(serializeLlmJsonRequest(settings, messages), "utf8");
}

function withAbortDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("LLM_DEADLINE_EXCEEDED"));
  }
  return new Promise<T>((resolve, reject) => {
    const abortHandler = () => {
      reject(new Error("LLM_DEADLINE_EXCEEDED"));
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abortHandler);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abortHandler);
        reject(error);
      }
    );
  });
}

export async function requestLlmJson<T>(options: {
  settings: RuntimeLlmSettings;
  messages: readonly LlmMessage[];
  schema: ZodType<T>;
  fetcher?: LlmFetcher;
  resolver?: LlmResolver;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): Promise<{ data: T; latencyMs: number }> {
  const body = serializeLlmJsonRequest(options.settings, options.messages);
  if (Buffer.byteLength(body, "utf8") > MAX_LLM_REQUEST_BYTES) {
    throw new LlmUpstreamError(
      "LLM_INPUT_TOO_LARGE",
      422,
      "待总结内容超过单次模型请求上限"
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("LLM_DEADLINE_EXCEEDED")),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  const startedAt = Date.now();
  let raw: string;
  try {
    const addresses = await withAbortDeadline(
      verifiedDestination(
        options.settings.baseUrl,
        options.resolver ?? defaultLlmResolver
      ),
      controller.signal
    );
    const fetcher: LlmFetcher = options.fetcher ?? ((input, init) =>
      pinnedHttpsFetch(input, init, addresses));
    const response = await fetcher(
      chatCompletionsUrl(options.settings.baseUrl),
      {
        method: "POST",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.settings.apiKey}`,
          "Content-Type": "application/json"
        },
        body,
        signal: controller.signal
      }
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw upstreamStatusError(response.status);
    }
    raw = await boundedResponseText(
      response,
      options.maxResponseBytes ?? MAX_RESPONSE_BYTES,
      controller.signal
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new LlmUpstreamError(
        "LLM_UPSTREAM_TIMEOUT",
        504,
        "LLM 服务响应超时"
      );
    }
    if (error instanceof LlmUpstreamError) throw error;
    throw new LlmUpstreamError(
      "LLM_UPSTREAM_UNAVAILABLE",
      502,
      "无法连接 LLM 服务"
    );
  } finally {
    clearTimeout(timer);
  }

  let envelope: z.infer<typeof CompletionEnvelopeSchema>;
  try {
    envelope = CompletionEnvelopeSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof LlmUpstreamError) throw error;
    throw invalidResponse();
  }
  try {
    const content = envelope.choices[0]!.message.content;
    return {
      data: options.schema.parse(JSON.parse(content)),
      latencyMs: Date.now() - startedAt
    };
  } catch {
    throw invalidResponse();
  }
}

export async function testLlmConnection(options: {
  settings: RuntimeLlmSettings;
  fetcher?: LlmFetcher;
  resolver?: LlmResolver;
}): Promise<{ latencyMs: number }> {
  const result = await requestLlmJson({
    ...options,
    messages: [
      {
        role: "system",
        content: "Return JSON only. Reply exactly with {\"ok\":true}."
      },
      { role: "user", content: "Connection check" }
    ],
    schema: z.object({ ok: z.literal(true) }).strict()
  });
  return { latencyMs: result.latencyMs };
}
