import { describe, expect, it } from "vitest";
import { readBoundedRequestBytes } from "./bounded-request-body";

describe("readBoundedRequestBytes", () => {
  it("cancels a request stream as soon as the byte limit is exceeded", async () => {
    let pulls = 0;
    let cancelled = false;
    const request = new Request("http://localhost/upload", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(4));
          if (pulls === 10) controller.close();
        },
        cancel() {
          cancelled = true;
        }
      }),
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedRequestBytes(
      request,
      8,
      () => new Error("TOO_LARGE")
    )).rejects.toThrow("TOO_LARGE");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it("returns exact bytes at the boundary and rejects a declared oversize", async () => {
    const exact = new Request("http://localhost/upload", {
      method: "POST",
      body: new Uint8Array([1, 2, 3, 4])
    });
    await expect(readBoundedRequestBytes(
      exact,
      4,
      () => new Error("TOO_LARGE")
    )).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));

    const declared = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-length": "5" },
      body: new Uint8Array([1])
    });
    await expect(readBoundedRequestBytes(
      declared,
      4,
      () => new Error("TOO_LARGE")
    )).rejects.toThrow("TOO_LARGE");
  });
});
