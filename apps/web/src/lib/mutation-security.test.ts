import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { readJsonMutation } from "./mutation-security";

function request(options: {
  origin?: string;
  marker?: string;
  contentType?: string;
  body?: string;
}) {
  const headers = new Headers();
  if (options.origin) headers.set("origin", options.origin);
  if (options.marker) headers.set("x-ai-worklog-request", options.marker);
  if (options.contentType) headers.set("content-type", options.contentType);
  return new NextRequest("http://localhost:3000/api/v1/llm-settings", {
    method: "PUT",
    headers,
    body: options.body ?? "{}"
  });
}

describe("readJsonMutation", () => {
  it("accepts a bounded same-origin JSON mutation", async () => {
    await expect(
      readJsonMutation(
        request({
          origin: "http://localhost:3000",
          marker: "1",
          contentType: "application/json",
          body: '{"model":"test"}'
        }),
        "http://localhost:3000"
      )
    ).resolves.toEqual({ model: "test" });
  });

  it.each([
    [{ marker: "1", contentType: "application/json" }, "CSRF_CHECK_FAILED"],
    [{ origin: "https://evil.test", marker: "1", contentType: "application/json" }, "CSRF_CHECK_FAILED"],
    [{ origin: "http://localhost:3000", contentType: "application/json" }, "CSRF_CHECK_FAILED"],
    [{ origin: "http://localhost:3000", marker: "1", contentType: "text/plain" }, "UNSUPPORTED_MEDIA_TYPE"]
  ])("rejects an unsafe mutation boundary", async (input, code) => {
    await expect(
      readJsonMutation(request(input), "http://localhost:3000")
    ).rejects.toMatchObject({ code });
  });

  it("rejects oversized bodies before parsing JSON", async () => {
    await expect(
      readJsonMutation(
        request({
          origin: "http://localhost:3000",
          marker: "1",
          contentType: "application/json",
          body: JSON.stringify({ value: "x".repeat(17_000) })
        }),
        "http://localhost:3000"
      )
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", status: 413 });
  });
});
