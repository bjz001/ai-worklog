import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parseRunQuery: vi.fn(),
  parseEventQuery: vi.fn(),
  listRuns: vi.fn(),
  runDetail: vi.fn(),
  listEvents: vi.fn(),
  eventContentStream: vi.fn(),
  blobDownload: vi.fn(),
  serverContext: vi.fn()
}));

vi.mock("@ai-worklog/server", () => ({
  parseAgentRunQuery: mocks.parseRunQuery,
  parseAgentEventQuery: mocks.parseEventQuery,
  listAgentRuns: mocks.listRuns,
  getAgentRunDetail: mocks.runDetail,
  listAgentEvents: mocks.listEvents,
  openAgentEventContentStream: mocks.eventContentStream,
  getBlobDownload: mocks.blobDownload,
  blobRootFromEnvironment: vi.fn(() => "/tmp/blob-root")
}));

vi.mock("@/lib/server-api", () => ({
  apiError: vi.fn((error: { status?: number; code?: string }, requestId: string) =>
    NextResponse.json({ error: { code: error.code ?? "INTERNAL_ERROR", requestId } }, {
      status: error.status ?? 500
    })
  ),
  requestId: vi.fn(() => "request-test"),
  serverContext: mocks.serverContext
}));

import { GET as listRunsRoute } from "./agent-runs/route";
import { GET as runDetailRoute } from "./agent-runs/[id]/route";
import { GET as eventTimelineRoute } from "./agent-runs/[id]/events/route";
import { GET as eventContentRoute } from "./agent-events/[id]/content/route";
import { GET as blobDownloadRoute } from "./blobs/[sha256]/route";

let temporaryDirectory = "";
let blobPath = "";

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "ai-worklog-route-"));
  blobPath = join(temporaryDirectory, "blob.txt");
  await writeFile(blobPath, "完整附件", { mode: 0o600 });
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Agent trajectory query routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.serverContext.mockReturnValue({
      pool: { execute: vi.fn() },
      accountId: "account-a"
    });
    mocks.parseRunQuery.mockReturnValue({ page: 1, pageSize: 25 });
    mocks.parseEventQuery.mockReturnValue({ pageSize: 100, cursor: null });
    mocks.listRuns.mockResolvedValue({
      data: [],
      pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }
    });
    mocks.runDetail.mockResolvedValue({ data: { run: { id: "session-db" } } });
    mocks.listEvents.mockResolvedValue({
      data: [],
      pagination: { nextCursor: null, hasMore: false }
    });
    const rawContent = "FAKE_SECRET_CANARY=preserve\n完整正文";
    mocks.eventContentStream.mockResolvedValue({
      format: "TEXT",
      purpose: "RAW_PAYLOAD",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(rawContent));
          controller.close();
        }
      }),
      contentSha256: "a".repeat(64),
      byteLength: Buffer.byteLength(rawContent)
    });
    mocks.blobDownload.mockResolvedValue({
      path: blobPath,
      byteLength: Buffer.byteLength("完整附件"),
      mediaType: "text/plain",
      filename: "附件.txt",
      sha256: "b".repeat(64)
    });
  });

  it("lists and filters runs inside the dashboard account", async () => {
    const request = new NextRequest("http://localhost/api/v1/agent-runs?q=工具");
    const response = await listRunsRoute(request);

    expect(response.status).toBe(200);
    expect(mocks.parseRunQuery).toHaveBeenCalledWith(request.nextUrl.searchParams);
    expect(mocks.listRuns).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account-a"
    }));
  });

  it("loads a run and its cursor-paged timeline", async () => {
    const detail = await runDetailRoute(
      new NextRequest("http://localhost/api/v1/agent-runs/session-db"),
      { params: Promise.resolve({ id: "session-db" }) }
    );
    const timeline = await eventTimelineRoute(
      new NextRequest("http://localhost/api/v1/agent-runs/session-db/events"),
      { params: Promise.resolve({ id: "session-db" }) }
    );

    expect(detail.status).toBe(200);
    expect(timeline.status).toBe(200);
    expect(mocks.runDetail).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account-a",
      runId: "session-db"
    }));
    expect(mocks.listEvents).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account-a",
      runId: "session-db"
    }));
  });

  it("streams full event content verbatim", async () => {
    const response = await eventContentRoute(
      new NextRequest(
        "http://localhost/api/v1/agent-events/event-db/content?purpose=RAW_PAYLOAD"
      ),
      { params: Promise.resolve({ id: "event-db" }) }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("FAKE_SECRET_CANARY=preserve");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.eventContentStream).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account-a",
      eventId: "event-db",
      purpose: "RAW_PAYLOAD"
    }));
  });

  it("streams a captured Blob with a safe attachment header", async () => {
    const response = await blobDownloadRoute(
      new NextRequest(`http://localhost/api/v1/blobs/${"b".repeat(64)}`),
      { params: Promise.resolve({ sha256: "b".repeat(64) }) }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("完整附件");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
