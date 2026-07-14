import { describe, expect, it, vi } from "vitest";
import { buildEventId, sha256Hex } from "@ai-worklog/core";
import {
  BatchConflictError,
  EventIdentityMismatchError,
  classifyEventMutation,
  isRetryableTransactionError,
  markSummaryDatesDirty,
  projectIdentity,
  validateEventIdentities
} from "./sync-service";

describe("markSummaryDatesDirty", () => {
  it("deduplicates dates and increments a persistent version in the caller transaction", async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);

    await markSummaryDatesDirty({
      connection: { execute } as never,
      accountId: "account-a",
      workDates: ["2026-07-14", "2025-01-02", "2026-07-14"]
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      ["account-a", "2025-01-02"],
      ["account-a", "2026-07-14"]
    ]);
    expect(execute.mock.calls[0]?.[0]).toContain(
      "dirty_version = dirty_version + 1"
    );
  });
});

describe("classifyEventMutation", () => {
  it("preserves repeated delivery and records real content changes", () => {
    expect(classifyEventMutation(null, [], "a".repeat(64))).toBe("insert");
    expect(
      classifyEventMutation("a".repeat(64), ["a".repeat(64)], "a".repeat(64))
    ).toBe("duplicate");
    expect(
      classifyEventMutation("b".repeat(64), ["a".repeat(64)], "a".repeat(64))
    ).toBe("duplicate");
    expect(
      classifyEventMutation("a".repeat(64), ["a".repeat(64)], "b".repeat(64))
    ).toBe("change");
  });
});

describe("projectIdentity", () => {
  it("merges credential-free SSH and HTTPS hints into one project", () => {
    const ssh = projectIdentity({
      gitRemoteKey: "git@github.com:Acme/AI-Worklog.git"
    }, "account-demo");
    const https = projectIdentity({
      gitRemoteKey: "https://token@github.com/acme/ai-worklog.git"
    }, "account-demo");

    expect(ssh.id).toBe(https.id);
    expect(ssh.canonicalKey).toBe("github.com/acme/ai-worklog");
    expect(ssh.name).toBe("ai-worklog");
  });

  it("never embeds a local path or credential in the database identity", () => {
    const identity = projectIdentity({
      localPathHmac: "f".repeat(64),
      repoRootName: "private-project"
    }, "account-demo");

    expect(identity.canonicalKey).toBe(`local:${"f".repeat(64)}`);
    expect(identity.classificationSource).toBe("WORKING_DIRECTORY");
    expect(identity.id).not.toContain("private-project");
  });

  it("scopes the same canonical project key to an account", () => {
    const hint = { gitRemoteKey: "github.com/acme/ai-worklog" };
    expect(projectIdentity(hint, "account-a").id).not.toBe(
      projectIdentity(hint, "account-b").id
    );
  });
});

describe("BatchConflictError", () => {
  it("is a non-retryable conflict", () => {
    const error = new BatchConflictError();
    expect(error.status).toBe(409);
    expect(error.code).toBe("BATCH_ID_REUSED");
  });
});

describe("isRetryableTransactionError", () => {
  it("retries only MySQL deadlocks and lock timeouts", () => {
    expect(isRetryableTransactionError({ errno: 1213 })).toBe(true);
    expect(isRetryableTransactionError({ code: "ER_LOCK_WAIT_TIMEOUT" })).toBe(
      true
    );
    expect(isRetryableTransactionError({ code: "ER_DUP_ENTRY" })).toBe(false);
  });
});

describe("validateEventIdentities", () => {
  const identity = { accountId: "account-a", deviceId: "device-mac" };
  const source = {
    type: "CODEX" as const,
    instanceId: "codex-mac",
    parserVersion: "v1"
  };
  const eventBase = {
    kind: "USER_PROMPT" as const,
    sourceSessionId: "session-1",
    sourceMessageId: "message-1",
    messageIndex: 0,
    occurredAt: "2026-07-14T08:00:00.000Z",
    sourceTimeZone: "Asia/Shanghai",
    sanitizedContent: "safe",
    contentHash: sha256Hex("safe"),
    redactionVersion: "core-v1",
    metadata: {}
  };

  it("binds every event to the authenticated account and device", () => {
    const eventId = buildEventId({
      ...identity,
      sourceType: source.type,
      sourceInstanceId: source.instanceId,
      sourceSessionId: eventBase.sourceSessionId,
      sourceMessageId: eventBase.sourceMessageId,
      messageIndex: eventBase.messageIndex
    });
    expect(() =>
      validateEventIdentities([{ ...eventBase, eventId }], identity, source)
    ).not.toThrow();
    expect(() =>
      validateEventIdentities(
        [{ ...eventBase, eventId: "f".repeat(64) }],
        identity,
        source
      )
    ).toThrow(EventIdentityMismatchError);
  });
});
