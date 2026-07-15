import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  rotate: vi.fn(),
  consume: vi.fn(),
  readJsonMutation: vi.fn(),
  serverContext: vi.fn()
}));

vi.mock("@ai-worklog/server", () => ({
  DeviceServiceError: class DeviceServiceError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  createDeviceEnrollment: mocks.create,
  rotateDeviceEnrollmentToken: mocks.rotate,
  deviceMutationRateLimiter: { consume: mocks.consume }
}));

vi.mock("@/lib/mutation-security", () => ({
  readJsonMutation: mocks.readJsonMutation
}));

vi.mock("@/lib/server-api", () => ({
  apiError: vi.fn(() => NextResponse.json({ error: { code: "TEST" } }, { status: 500 })),
  requestId: vi.fn(() => "request-test"),
  serverContext: mocks.serverContext
}));

import { POST as createDevice } from "./devices/route";
import { POST as rotateDeviceToken } from "./devices/[id]/token/route";

const enrollment = {
  device: {
    id: "device_abc123",
    name: "Office Mac",
    os: "MACOS",
    status: "WAITING",
    lastSeenAt: null,
    lastSyncAt: null,
    promptCount: 0
  },
  enrollment: {
    accountId: "account_demo",
    deviceId: "device_abc123",
    deviceToken: "a".repeat(64),
    syncUrl: "http://172.18.209.21:3000/api/v1/sync/batches"
  }
};

describe("device enrollment routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.serverContext.mockReturnValue({
      pool: { getConnection: vi.fn() },
      accountId: "account_demo"
    });
    mocks.readJsonMutation.mockResolvedValue({});
    mocks.create.mockResolvedValue(enrollment);
    mocks.rotate.mockResolvedValue(enrollment);
  });

  it("creates a device from a strict same-origin mutation", async () => {
    mocks.readJsonMutation.mockResolvedValue({
      name: "Office Mac",
      platform: "MACOS"
    });

    const response = await createDevice(new NextRequest(
      "http://172.18.209.21:3000/api/v1/devices",
      { method: "POST" }
    ));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ data: enrollment });
    expect(mocks.consume).toHaveBeenCalledWith("account_demo");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_demo",
      input: { name: "Office Mac", platform: "MACOS" }
    }));
  });

  it("rotates a token only for the route account and device", async () => {
    const response = await rotateDeviceToken(
      new NextRequest(
        "http://172.18.209.21:3000/api/v1/devices/device_abc123/token",
        { method: "POST" }
      ),
      { params: Promise.resolve({ id: "device_abc123" }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ data: enrollment });
    expect(mocks.consume).toHaveBeenCalledWith("account_demo");
    expect(mocks.rotate).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_demo",
      deviceId: "device_abc123"
    }));
  });
});
