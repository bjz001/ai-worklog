import { Context } from "@deepseek-ai/cordis";
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  type SessionEvent,
  type SessionHeader
} from "@deepseek-ai/dsh-session";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import SqliteSessionPersistence from "@deepseek-ai/dsh-session-persistence-sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentRunId, sha256Hex } from "@ai-worklog/core";
import { DshAgentConnector } from "./dsh-agent-connector.js";

const events: SessionEvent[] = [
  { type: "turn/start", seq: 0, time: 1_000, data: { turn: 1 } },
  { type: "step/start", seq: 1, time: 1_001, data: { turn: 1, step: 1 } },
  { type: "step/end", seq: 2, time: 1_002, data: { turn: 1, step: 1 } },
  { type: "turn/end", seq: 3, time: 1_003, data: { turn: 1, reason: { kind: "completed" } } }
];

async function createJsonl(root: string, compression: "none" | "zstd", id: string) {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(JsonlSessionPersistence, { root, compression, writeBatchMaxDelayMs: 1 });
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1_000,
    cwd: "/tmp/dsh-project"
  };
  await ctx.sessionPersistence.create(header);
  await ctx.sessionPersistence.append(header.id, events);
  await ctx.fiber.dispose();
}

async function createSqlite(path: string, id: string) {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SqliteSessionPersistence, { path, writeBatchMaxDelayMs: 1 });
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 2_000,
    cwd: "/tmp/dsh-project"
  };
  await ctx.sessionPersistence.create(header);
  await ctx.sessionPersistence.append(header.id, events);
  await ctx.fiber.dispose();
}

describe("DshAgentConnector", () => {
  it("uses official persistence decoding for JSONL, zstd and SQLite backends", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dsh-agent-"));
    const plain = join(directory, "plain");
    const zstd = join(directory, "zstd");
    const sqlite = join(directory, "sessions.db");
    await createJsonl(plain, "none", "plain-session");
    await createJsonl(zstd, "zstd", "zstd-session");
    await createSqlite(sqlite, "sqlite-session");
    const connector = new DshAgentConnector({
      accountId: "account-1",
      deviceId: "device-1",
      sourceInstanceId: "dsh-device-1"
    });

    const [plainCapture] = await connector.readSource(plain);
    const [zstdCapture] = await connector.readSource(zstd);
    const [sqliteCapture] = await connector.readSource(sqlite);

    for (const capture of [plainCapture, zstdCapture, sqliteCapture]) {
      const eventRecords = capture?.records.filter((record) =>
        record.recordType === "EVENT"
      ) ?? [];
      expect(eventRecords).toHaveLength(events.length + 1);
      expect(eventRecords.map((record) => record.recordType === "EVENT" ? record.kind : ""))
        .toContain("TURN_BOUNDARY");
      expect(JSON.stringify(capture)).toContain('"turn/start"');
    }
    expect(plainCapture?.attachmentRequests.some((request) =>
      request.purpose === "SOURCE_TRANSCRIPT"
    )).toBe(true);
    expect(zstdCapture?.attachmentRequests.some((request) =>
      request.requestedPath.endsWith(".jsonl.zstd")
    )).toBe(true);
    expect(sqliteCapture?.attachmentRequests.some((request) =>
      request.requestedPath === sqlite
    )).toBe(true);
  }, 30_000);

  it("normalizes the full loop vocabulary while retaining unknown extensions", async () => {
    const connector = new DshAgentConnector({
      accountId: "account-1",
      deviceId: "device-1",
      sourceInstanceId: "dsh-device-1",
      decoder: {
        async inspect() {
          return [{
            meta: {
              version: 0,
              id: "synthetic-session",
              createdAt: 1_000,
              cwd: "/tmp/project"
            },
            artifactPath: "/tmp/session.jsonl",
            events: [
              { type: "request/header", seq: 0, time: 1_001, data: { header: { system: "FULL SYSTEM", tools: [{ name: "bash" }] }, reason: "initial" } },
              { type: "assistant/chunk", seq: 1, time: 1_002, data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "full reasoning" } } },
              { type: "tool/call", seq: 2, time: 1_003, data: { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: "{\"command\":\"pwd\"}" } },
              { type: "future/extension", seq: 3, time: 1_004, data: { keep: "unknown" }, ignorable: true }
            ]
          }];
        }
      }
    });
    const [capture] = await connector.readSource("/tmp/synthetic");
    const kinds = capture?.records.flatMap((record) =>
      record.recordType === "EVENT" ? [record.kind] : []
    );

    expect(kinds).toEqual(expect.arrayContaining([
      "CONTEXT", "REASONING", "TOOL_CALL", "SOURCE_EVENT"
    ]));
    expect(JSON.stringify(capture)).toContain("FULL SYSTEM");
    expect(JSON.stringify(capture)).toContain("full reasoning");
    expect(JSON.stringify(capture)).toContain("unknown");
  });

  it("uses the same bounded identity for a long parent session as for its run", async () => {
    const parentSession = "parent-".repeat(180);
    const connector = new DshAgentConnector({
      accountId: "account-1",
      deviceId: "device-1",
      sourceInstanceId: "dsh-device-1",
      decoder: {
        async inspect() {
          return [{
            meta: {
              version: 0,
              id: "child-session",
              createdAt: 1_000,
              parentSession
            },
            events: []
          }];
        }
      }
    });
    const [capture] = await connector.readSource("/tmp/synthetic");
    const run = capture?.records.find((record) => record.recordType === "RUN");
    const boundedParent = `sha256:${sha256Hex(parentSession)}`;

    expect(run?.recordType === "RUN" ? run.parentRunId : null).toBe(
      buildAgentRunId({
        accountId: "account-1",
        deviceId: "device-1",
        sourceType: "DSH",
        sourceInstanceId: "dsh-device-1",
        sourceSessionId: boundedParent
      })
    );
  });
});
