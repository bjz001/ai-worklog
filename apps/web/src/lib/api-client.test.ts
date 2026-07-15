import { describe, expect, it, vi } from "vitest";

import {
  ApiRequestError,
  collectionState,
  fetchApi,
  mutateApi,
  resolveApiUrl
} from "./api-client";

describe("resolveApiUrl", () => {
  it("keeps same-origin API paths when no base URL is configured", () => {
    expect(resolveApiUrl("/api/v1/dashboard", "")).toBe("/api/v1/dashboard");
  });

  it("joins a configured API base without duplicate slashes", () => {
    expect(resolveApiUrl("/api/v1/projects", "https://worklog.test/")).toBe(
      "https://worklog.test/api/v1/projects"
    );
  });
});

describe("mutateApi", () => {
  it("sends same-origin JSON with the CSRF marker", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: { saved: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(
      mutateApi<{ data: { saved: boolean } }>("/api/v1/llm-settings", {
        method: "PUT",
        body: { model: "deepseek-v4-flash" },
        fetcher
      })
    ).resolves.toEqual({ data: { saved: true } });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/llm-settings",
      expect.objectContaining({
        method: "PUT",
        credentials: "same-origin",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-AI-Worklog-Request": "1"
        })
      })
    );
  });
});

describe("fetchApi", () => {
  it("returns parsed JSON for a successful response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "project-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await fetchApi<{ data: Array<{ id: string }> }>(
      "/api/v1/projects",
      { fetcher }
    );

    expect(result.data[0]?.id).toBe("project-1");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/projects",
      expect.objectContaining({ headers: { Accept: "application/json" } })
    );
  });

  it("throws a typed, retryable error for unavailable services", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "服务暂时不可用",
            retryable: true,
            requestId: "request-1"
          }
        }),
        { status: 503, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      fetchApi("/api/v1/dashboard", { fetcher })
    ).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      retryable: true
    } satisfies Partial<ApiRequestError>);
  });

  it("uses a safe error when a service returns invalid JSON", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(fetchApi("/api/v1/dashboard", { fetcher })).rejects.toMatchObject({
      name: "ApiRequestError",
      code: "INVALID_RESPONSE",
      message: "服务返回了无法识别的数据"
    } satisfies Partial<ApiRequestError>);
  });
});

describe("collectionState", () => {
  it("distinguishes loading, error, empty, partial, and ready states", () => {
    expect(collectionState({ loading: true, count: 0 })).toBe("loading");
    expect(
      collectionState({ loading: false, count: 0, error: new Error("failed") })
    ).toBe("error");
    expect(collectionState({ loading: false, count: 0 })).toBe("empty");
    expect(collectionState({ loading: false, count: 1, partial: true })).toBe(
      "partial"
    );
    expect(collectionState({ loading: false, count: 1 })).toBe("ready");
  });
});
