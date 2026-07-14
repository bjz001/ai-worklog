type Fetcher = typeof fetch;

type ApiErrorPayload = {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    requestId?: string;
  };
};

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(options: {
    status: number;
    code?: string;
    message?: string;
    retryable?: boolean;
    requestId?: string;
  }) {
    super(options.message ?? "请求未能完成，请稍后重试");
    this.name = "ApiRequestError";
    this.status = options.status;
    this.code = options.code ?? "REQUEST_FAILED";
    this.retryable = options.retryable ?? options.status >= 500;
    this.requestId = options.requestId;
  }
}

export function resolveApiUrl(path: string, apiBase = ""): string {
  if (!apiBase) return path;
  return `${apiBase.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export async function fetchApi<T>(
  path: string,
  options: {
    apiBase?: string;
    fetcher?: Fetcher;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    resolveApiUrl(path, options.apiBase ?? process.env.NEXT_PUBLIC_API_BASE_URL),
    {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: options.signal
    }
  );

  const contentType = response.headers.get("content-type") ?? "";
  let payload: (T & ApiErrorPayload) | undefined;
  if (contentType.includes("application/json")) {
    try {
      payload = (await response.json()) as T & ApiErrorPayload;
    } catch {
      throw new ApiRequestError({
        status: response.status,
        code: "INVALID_RESPONSE",
        message: "服务返回了无法识别的数据",
        retryable: true
      });
    }
  }

  if (!response.ok) {
    throw new ApiRequestError({
      status: response.status,
      code: payload?.error?.code,
      message: payload?.error?.message,
      retryable: payload?.error?.retryable,
      requestId: payload?.error?.requestId
    });
  }

  if (payload === undefined) {
    throw new ApiRequestError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: "服务返回了无法识别的数据",
      retryable: true
    });
  }

  return payload;
}

export type CollectionState =
  | "loading"
  | "error"
  | "empty"
  | "partial"
  | "ready";

export function collectionState(input: {
  loading: boolean;
  count: number;
  error?: Error | null;
  partial?: boolean;
}): CollectionState {
  if (input.loading) return "loading";
  if (input.error) return "error";
  if (input.count === 0) return "empty";
  if (input.partial) return "partial";
  return "ready";
}
