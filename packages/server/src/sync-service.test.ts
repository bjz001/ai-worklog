import { describe, expect, it, vi } from "vitest";
import { buildEventId, sha256Hex } from "@ai-worklog/core";
import { InvalidAuthorizationError } from "./auth";
import {
  BatchConflictError,
  EventIdentityMismatchError,
  backfillVisibleResultPromptLinks,
  classifyEventMutation,
  compatibleLegacyStoredEventIdentity,
  compatibleStoredEventIdentity,
  commitSyncBatch,
  isRetryableTransactionError,
  lockActiveDeviceCredential,
  markSummaryDatesDirty,
  projectIdentity,
  resolveStoredEventIdentity,
  validateEventIdentities
} from "./sync-service";

function validCommitFixture() {
  const identity = {
    accountId: "account-a",
    deviceId: "device-mac",
    deviceTokenId: "token-current"
  };
  const source = {
    type: "CODEX" as const,
    instanceId: "codex-mac",
    parserVersion: "codex-jsonl-v4"
  };
  const eventIdentity = {
    accountId: identity.accountId,
    deviceId: identity.deviceId,
    sourceType: source.type,
    sourceInstanceId: source.instanceId,
    sourceSessionId: "session-1",
    sourceMessageId: "message-1",
    messageIndex: 0
  };
  return {
    identity,
    validated: {
      payload: {
        protocolVersion: 1 as const,
        batchId: "batch-race-check",
        createdAt: "2026-07-15T08:00:00.000Z",
        source,
        events: [{
          eventId: buildEventId(eventIdentity),
          kind: "USER_PROMPT" as const,
          sourceSessionId: eventIdentity.sourceSessionId,
          sourceMessageId: eventIdentity.sourceMessageId,
          messageIndex: eventIdentity.messageIndex,
          occurredAt: "2026-07-15T07:59:00.000Z",
          sourceTimeZone: "Asia/Shanghai",
          sanitizedContent: "safe prompt",
          contentHash: sha256Hex("safe prompt"),
          redactionVersion: "core-v1",
          metadata: {}
        }]
      },
      payloadHash: sha256Hex("batch-race-check")
    }
  };
}

describe("active device credential commit lock", () => {
  it("locks the device before revalidating and locking its exact token", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[{ id: "device-mac" }], []])
      .mockResolvedValueOnce([[{ id: "token-current" }], []]);
    const { identity } = validCommitFixture();

    await lockActiveDeviceCredential({
      connection: { execute } as never,
      identity
    });

    expect(String(execute.mock.calls[0]?.[0])).toContain("FROM devices");
    expect(String(execute.mock.calls[0]?.[0])).toContain("FOR UPDATE");
    expect(execute.mock.calls[0]?.[1]).toEqual([
      identity.deviceId,
      identity.accountId
    ]);
    expect(String(execute.mock.calls[1]?.[0])).toContain("FROM device_tokens");
    expect(String(execute.mock.calls[1]?.[0])).toContain("revoked_at IS NULL");
    expect(String(execute.mock.calls[1]?.[0])).toContain("expires_at > UTC_TIMESTAMP(6)");
    expect(String(execute.mock.calls[1]?.[0])).toContain("FOR UPDATE");
    expect(execute.mock.calls[1]?.[1]).toEqual([
      identity.deviceTokenId,
      identity.accountId,
      identity.deviceId
    ]);
  });

  it("rejects a token revoked after initial authentication before accepting a batch", async () => {
    const execute = vi.fn(async (sql: unknown) => {
      const statement = String(sql);
      if (statement.includes("FROM devices")) {
        return [[{ id: "device-mac" }], []];
      }
      if (statement.includes("FROM device_tokens")) return [[], []];
      throw new Error(`unexpected query: ${statement}`);
    });
    const connection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      destroy: vi.fn(),
      execute
    };
    const fixture = validCommitFixture();

    await expect(commitSyncBatch({
      pool: {
        getConnection: vi.fn().mockResolvedValue(connection)
      } as never,
      identity: fixture.identity,
      validated: fixture.validated,
      requestId: "request-race-check"
    })).rejects.toBeInstanceOf(InvalidAuthorizationError);

    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(execute.mock.calls.some((call) =>
      String(call[0]).includes("sync_batches")
    )).toBe(false);
  });
});

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

describe("compatibleStoredEventIdentity", () => {
  const existing = {
    device_id: "device-mac",
    session_id: "session-db-id",
    kind: "USER_PROMPT" as const,
    source_message_id: "stable-message-id",
    message_index: 7
  };

  it("allows parser upgrades to change a positional index when a stable source ID exists", () => {
    expect(
      compatibleStoredEventIdentity(existing, {
        deviceId: "device-mac",
        sessionId: "session-db-id",
        event: {
          kind: "USER_PROMPT",
          sourceMessageId: "stable-message-id",
          messageIndex: 99
        }
      })
    ).toBe(true);
  });

  it("keeps the semantic index immutable when it is the event identity fallback", () => {
    expect(
      compatibleStoredEventIdentity(
        { ...existing, source_message_id: null },
        {
          deviceId: "device-mac",
          sessionId: "session-db-id",
          event: {
            kind: "USER_PROMPT",
            sourceMessageId: null,
            messageIndex: 99
          }
        }
      )
    ).toBe(false);
  });
});

describe("legacy Codex event identity migration", () => {
  const accountId = "account-a";
  const deviceId = "device-mac";
  const sessionId = "session-db-id";
  const source = {
    type: "CODEX" as const,
    instanceId: "codex-mac",
    parserVersion: "codex-jsonl-v4"
  };
  const sourceSessionId = "source-session-1";
  const projectId = "project-current";
  const legacyEventId = buildEventId({
    accountId,
    deviceId,
    sourceType: source.type,
    sourceInstanceId: source.instanceId,
    sourceSessionId,
    sourceMessageId: null,
    messageIndex: 0
  });
  const canonicalEventId = buildEventId({
    accountId,
    deviceId,
    sourceType: source.type,
    sourceInstanceId: source.instanceId,
    sourceSessionId,
    sourceMessageId: "canonical-client-id",
    messageIndex: 1
  });
  const event = {
    eventId: canonicalEventId,
    kind: "USER_PROMPT" as const,
    sourceSessionId,
    sourceMessageId: "canonical-client-id",
    messageIndex: 1,
    occurredAt: "2026-07-14T08:00:00.000Z",
    sourceTimeZone: "Asia/Shanghai",
    sanitizedContent: "Visible prompt body",
    contentHash: sha256Hex("Visible prompt body"),
    redactionVersion: "core-v1",
    metadata: {
      legacyEventAliases: [{ eventId: legacyEventId, sourceSessionId }]
    }
  };
  const legacyRow = {
    id: "event-db-id",
    account_id: accountId,
    event_id: legacyEventId,
    content_hash: sha256Hex("Synthetic injected context\nVisible prompt body"),
    current_version: 1,
    device_id: deviceId,
    session_id: sessionId,
    project_id: "project-legacy",
    kind: event.kind,
    source_message_id: null,
    message_index: 0,
    reply_to_event_id: null,
    occurred_at: new Date(event.occurredAt),
    current_sanitized_content: "Synthetic injected context\nVisible prompt body",
    legacy_source_session_id: sourceSessionId,
    legacy_source_type: source.type,
    legacy_source_instance_id: source.instanceId
  };

  it("accepts a wrapped short Chinese prompt only with a verified legacy alias", () => {
    const shortEvent = {
      ...event,
      sanitizedContent: "好",
      contentHash: sha256Hex("好")
    };
    const wrappedRow = {
      ...legacyRow,
      content_hash: sha256Hex("Synthetic wrapper context\n好"),
      current_sanitized_content: "Synthetic wrapper context\n好"
    };

    expect(compatibleLegacyStoredEventIdentity(wrappedRow, {
      accountId,
      deviceId,
      sessionId,
      source,
      event: shortEvent,
      legacyAlias: { eventId: legacyEventId, sourceSessionId }
    })).toBe(true);
  });

  it("migrates a lineage-matched alias when a locked historical version hash matches", async () => {
    const changedLegacyRow = {
      ...legacyRow,
      content_hash: sha256Hex("newer current content"),
      current_sanitized_content: "newer current content"
    };
    const execute = vi.fn()
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[changedLegacyRow], []])
      .mockResolvedValueOnce([[
        { content_hash: changedLegacyRow.content_hash },
        { content_hash: event.contentHash }
      ], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    await expect(resolveStoredEventIdentity({
      connection: { execute } as never,
      accountId,
      deviceId,
      sessionId,
      projectId,
      source,
      event
    })).resolves.toMatchObject({
      migrated: true,
      existing: { id: changedLegacyRow.id, event_id: canonicalEventId }
    });

    expect(String(execute.mock.calls[2]?.[0])).toContain(
      "FROM event_versions"
    );
    expect(String(execute.mock.calls[2]?.[0])).toContain("FOR UPDATE");
    expect(execute.mock.calls[2]?.[1]).toEqual([
      accountId,
      changedLegacyRow.id
    ]);
  });

  it("ignores a cross-time alias collision so the canonical event can be inserted", async () => {
    const collidingLegacyRow = {
      ...legacyRow,
      content_hash: event.contentHash,
      current_sanitized_content: event.sanitizedContent,
      occurred_at: new Date("2026-07-14T16:00:00.000Z")
    };
    const execute = vi.fn()
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[collidingLegacyRow], []]);

    await expect(resolveStoredEventIdentity({
      connection: { execute } as never,
      accountId,
      deviceId,
      sessionId,
      projectId,
      source,
      event
    })).resolves.toEqual({ existing: null, migrated: false });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every((call) =>
      String(call[0]).trimStart().startsWith("SELECT")
    )).toBe(true);
  });

  it("still rejects an incompatible canonical identity", async () => {
    const canonicalCollision = {
      ...legacyRow,
      event_id: canonicalEventId,
      source_message_id: event.sourceMessageId,
      message_index: event.messageIndex,
      device_id: "another-device"
    };
    const execute = vi.fn().mockResolvedValueOnce([[canonicalCollision], []]);

    await expect(resolveStoredEventIdentity({
      connection: { execute } as never,
      accountId,
      deviceId,
      sessionId,
      projectId,
      source,
      event
    })).rejects.toBeInstanceOf(EventIdentityMismatchError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("migrates a v2/v3 response identity and every same-session reply reference", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[legacyRow], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 2 }, []]);

    const resolved = await resolveStoredEventIdentity({
      connection: { execute } as never,
      accountId,
      deviceId,
      sessionId,
      projectId,
      source,
      event
    });

    expect(resolved.migrated).toBe(true);
    expect(resolved.existing).toMatchObject({
      id: legacyRow.id,
      event_id: canonicalEventId,
      source_message_id: "canonical-client-id",
      message_index: 1,
      session_id: sessionId,
      project_id: projectId
    });
    expect(classifyEventMutation(
      resolved.existing?.content_hash ?? null,
      [legacyRow.content_hash],
      event.contentHash
    )).toBe("change");
    expect(execute.mock.calls[2]?.[1]).toEqual([
      canonicalEventId,
      "canonical-client-id",
      1,
      null,
      sessionId,
      projectId,
      legacyRow.id,
      accountId,
      deviceId,
      legacyRow.session_id,
      event.kind,
      legacyEventId
    ]);
    expect(execute.mock.calls[3]?.[1]).toEqual([
      sessionId,
      projectId,
      legacyRow.id,
      accountId,
      deviceId,
      legacyRow.session_id
    ]);
    expect(execute.mock.calls[4]?.[1]).toEqual([
      canonicalEventId,
      accountId,
      deviceId,
      sessionId,
      legacyEventId
    ]);
  });

  it("clears a stale visible-result prompt link when the canonical reply is absent", async () => {
    const aliasId = buildEventId({
      accountId,
      deviceId,
      sourceType: source.type,
      sourceInstanceId: source.instanceId,
      sourceSessionId,
      sourceMessageId: "legacy-result-response",
      messageIndex: 1
    });
    const resultId = buildEventId({
      accountId,
      deviceId,
      sourceType: source.type,
      sourceInstanceId: source.instanceId,
      sourceSessionId,
      sourceMessageId: "event-agent-line:4",
      messageIndex: 3
    });
    const resultEvent = {
      ...event,
      eventId: resultId,
      kind: "VISIBLE_RESULT" as const,
      sourceMessageId: "event-agent-line:4",
      messageIndex: 3,
      sanitizedContent: "Visible result body",
      contentHash: sha256Hex("Visible result body"),
      metadata: {
        legacyEventAliases: [{ eventId: aliasId, sourceSessionId }]
      }
    };
    const resultRow = {
      ...legacyRow,
      event_id: aliasId,
      kind: resultEvent.kind,
      source_message_id: "legacy-result-response",
      message_index: 1,
      content_hash: resultEvent.contentHash,
      current_sanitized_content: resultEvent.sanitizedContent
    };
    const execute = vi.fn()
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[resultRow], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    await resolveStoredEventIdentity({
      connection: { execute } as never,
      accountId,
      deviceId,
      sessionId,
      projectId,
      source,
      event: resultEvent
    });

    expect(String(execute.mock.calls[3]?.[0])).toContain("prompt_entry_id = ?");
    expect(execute.mock.calls[3]?.[1]).toEqual([
      sessionId,
      projectId,
      null,
      resultRow.id,
      accountId,
      deviceId,
      resultRow.session_id
    ]);
  });

  it("does not attempt alias migration when the collector did not provide one", async () => {
    const execute = vi.fn().mockResolvedValueOnce([[], []]);

    const resolved = await resolveStoredEventIdentity({
      connection: { execute } as never,
      accountId,
      deviceId,
      sessionId,
      projectId,
      source,
      event: { ...event, metadata: {} }
    });

    expect(resolved).toEqual({ existing: null, migrated: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("migrates a v2 first-segment identity into the later v4 segment without inserting", async () => {
    const currentSessionId = "session-b-db";
    const currentProjectId = "project-b";
    const firstSourceSessionId = "source-segment-a";
    const currentSourceSessionId = "source-segment-b";
    const v3Alias = buildEventId({
      accountId,
      deviceId,
      sourceType: source.type,
      sourceInstanceId: source.instanceId,
      sourceSessionId: currentSourceSessionId,
      sourceMessageId: null,
      messageIndex: 3
    });
    const v2Alias = buildEventId({
      accountId,
      deviceId,
      sourceType: source.type,
      sourceInstanceId: source.instanceId,
      sourceSessionId: firstSourceSessionId,
      sourceMessageId: null,
      messageIndex: 3
    });
    const canonicalId = buildEventId({
      accountId,
      deviceId,
      sourceType: source.type,
      sourceInstanceId: source.instanceId,
      sourceSessionId: currentSourceSessionId,
      sourceMessageId: "segment-b-client",
      messageIndex: 8
    });
    const segmentEvent = {
      ...event,
      eventId: canonicalId,
      sourceSessionId: currentSourceSessionId,
      sourceMessageId: "segment-b-client",
      messageIndex: 8,
      metadata: {
        legacyEventAliases: [
          { eventId: v3Alias, sourceSessionId: currentSourceSessionId },
          { eventId: v2Alias, sourceSessionId: firstSourceSessionId }
        ]
      }
    };
    const v2Row = {
      ...legacyRow,
      event_id: v2Alias,
      content_hash: segmentEvent.contentHash,
      session_id: "session-a-db",
      project_id: "project-a",
      source_message_id: null,
      message_index: 3,
      current_sanitized_content: segmentEvent.sanitizedContent,
      legacy_source_session_id: firstSourceSessionId
    };
    const execute = vi.fn()
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[v2Row], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    const resolved = await resolveStoredEventIdentity({
      connection: { execute } as never,
      accountId,
      deviceId,
      sessionId: currentSessionId,
      projectId: currentProjectId,
      source,
      event: segmentEvent
    });

    expect(resolved).toMatchObject({
      migrated: true,
      existing: {
        id: v2Row.id,
        event_id: canonicalId,
        session_id: currentSessionId,
        project_id: currentProjectId
      }
    });
    const mutation = classifyEventMutation(
      resolved.existing?.content_hash ?? null,
      [v2Row.content_hash],
      segmentEvent.contentHash
    );
    expect(mutation).toBe("duplicate");
    const v2StoredEventCountAcrossSegmentsAAndB = 2;
    expect(
      v2StoredEventCountAcrossSegmentsAAndB +
        (mutation === "insert" ? 1 : 0)
    ).toBe(2);
    expect(execute).toHaveBeenCalledTimes(6);
    expect(execute.mock.calls[3]?.[1]).toEqual([
      canonicalId,
      "segment-b-client",
      8,
      null,
      currentSessionId,
      currentProjectId,
      v2Row.id,
      accountId,
      deviceId,
      v2Row.session_id,
      segmentEvent.kind,
      v2Alias
    ]);
    expect(execute.mock.calls[4]?.[1]).toEqual([
      currentSessionId,
      currentProjectId,
      v2Row.id,
      accountId,
      deviceId,
      v2Row.session_id
    ]);
    expect(execute.mock.calls[5]?.[1]).toEqual([
      canonicalId,
      accountId,
      deviceId,
      v2Row.session_id,
      currentSessionId,
      v2Alias
    ]);
  });

  it("merges an old v2 duplicate when the canonical v4 row already exists", async () => {
    const canonicalRow = {
      ...legacyRow,
      id: "canonical-event-db-id",
      event_id: canonicalEventId,
      content_hash: event.contentHash,
      source_message_id: event.sourceMessageId,
      message_index: event.messageIndex,
      project_id: projectId,
      current_sanitized_content: event.sanitizedContent
    };
    let storedEventCount = 2;
    const execute = vi.fn(async (sql: unknown, parameters?: unknown) => {
      const statement = String(sql);
      const values = parameters as unknown[] | undefined;
      if (statement.includes("FROM collected_events ce")) {
        if (values?.[1] === canonicalEventId) return [[canonicalRow], []];
        if (values?.[1] === legacyEventId) return [[legacyRow], []];
        return [[], []];
      }
      if (statement.includes("FROM event_versions") && statement.includes("IN (?, ?)")) {
        return [[
          {
            collected_event_id: canonicalRow.id,
            version: 1,
            content_hash: event.contentHash,
            sanitized_content: event.sanitizedContent,
            parser_version: "codex-jsonl-v4",
            redaction_version: "core-v1",
            metadata: {},
            created_at: new Date(event.occurredAt)
          },
          {
            collected_event_id: legacyRow.id,
            version: 1,
            content_hash: legacyRow.content_hash,
            sanitized_content: legacyRow.current_sanitized_content,
            parser_version: "codex-jsonl-v2",
            redaction_version: "core-v1",
            metadata: {},
            created_at: new Date(event.occurredAt)
          }
        ], []];
      }
      if (statement.includes("FROM daily_summaries")) {
        return [[{
          id: "summary-1",
          document: {
            highlights: [{
              text: "canonical evidence",
              evidenceIds: [canonicalRow.id]
            }]
          }
        }], []];
      }
      if (statement.includes("FROM skill_candidates")) {
        return [[{
          id: "skill-1",
          document: { evidenceIds: [canonicalRow.id] }
        }], []];
      }
      if (statement.includes("FROM prompt_entries")) {
        return [[
          { id: "prompt-canonical", collected_event_id: canonicalRow.id },
          { id: "prompt-legacy", collected_event_id: legacyRow.id }
        ], []];
      }
      if (statement.includes("DELETE FROM collected_events")) {
        storedEventCount -= 1;
      }
      return [{ affectedRows: 1 }, []];
    });

    await expect(resolveStoredEventIdentity({
      connection: { execute } as never,
      accountId,
      deviceId,
      sessionId,
      projectId,
      source,
      event
    })).resolves.toMatchObject({
      existing: { id: legacyRow.id, event_id: canonicalEventId },
      migrated: true
    });
    expect(storedEventCount).toBe(1);
    const statements = execute.mock.calls.map((call) => String(call[0]));
    expect(statements.some((sql) => sql.includes("INSERT INTO event_versions"))).toBe(true);
    expect(statements.some((sql) => sql.includes("UPDATE summary_evidence"))).toBe(true);
    expect(statements.some((sql) => sql.includes("SET prompt_entry_id = ?"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM prompt_entries"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM collected_events"))).toBe(true);
    const promptRewire = execute.mock.calls.find((call) =>
      String(call[0]).includes("SET prompt_entry_id = ?")
    );
    expect(promptRewire?.[1]).toEqual([
      "prompt-legacy",
      accountId,
      "prompt-canonical"
    ]);
    const summaryUpdate = execute.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE daily_summaries")
    );
    expect(String((summaryUpdate?.[1] as unknown[] | undefined)?.[0]))
      .toContain(legacyRow.id);
    expect(String((summaryUpdate?.[1] as unknown[] | undefined)?.[0]))
      .not.toContain(canonicalRow.id);
    const skillUpdate = execute.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE skill_candidates")
    );
    expect(String((skillUpdate?.[1] as unknown[] | undefined)?.[0]))
      .toContain(legacyRow.id);
    expect(String((skillUpdate?.[1] as unknown[] | undefined)?.[0]))
      .not.toContain(canonicalRow.id);
  });

  it.each([
    ["another account", { account_id: "account-b" }],
    ["another device", { device_id: "device-windows" }],
    ["another session", { session_id: "another-session" }],
    ["another kind", { kind: "VISIBLE_RESULT" as const }],
    ["another source session", {
      legacy_source_session_id: "unclaimed-source-session"
    }],
    ["another source instance", {
      legacy_source_instance_id: "other-codex"
    }],
    ["unrelated content", {
      content_hash: sha256Hex("unrelated"),
      current_sanitized_content: "unrelated"
    }],
    ["a distant source message", {
      occurred_at: new Date("2026-07-14T08:00:03.000Z")
    }]
  ])("ignores an alias owned by %s without mutating it", async (_label, override) => {
    const unsafeRow = { ...legacyRow, ...override };
    const execute = vi.fn()
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[unsafeRow], []])
      .mockResolvedValue([[], []]);

    expect(
      compatibleLegacyStoredEventIdentity(unsafeRow, {
        accountId,
        deviceId,
        sessionId,
        source,
        event,
        legacyAlias: { eventId: legacyEventId, sourceSessionId }
      })
    ).toBe(false);
    await expect(resolveStoredEventIdentity({
      connection: { execute } as never,
      accountId,
      deviceId,
      sessionId,
      projectId,
      source,
      event
    })).resolves.toEqual({ existing: null, migrated: false });
    expect(execute.mock.calls.every((call) =>
      String(call[0]).trimStart().startsWith("SELECT")
    )).toBe(true);
  });
});

describe("backfillVisibleResultPromptLinks", () => {
  it("links results after all batch events using account, device, and session boundaries", async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);

    await backfillVisibleResultPromptLinks({
      connection: { execute } as never,
      accountId: "account-a",
      deviceId: "device-mac",
      sessionIds: ["session-b", "session-a", "session-a"]
    });

    const sql = String(execute.mock.calls[0]?.[0]);
    expect(sql).toContain("prompt_event.account_id = result_event.account_id");
    expect(sql).toContain("prompt_event.device_id = result_event.device_id");
    expect(sql).toContain("prompt_event.session_id = result_event.session_id");
    expect(sql).toContain("vr.account_id = ?");
    expect(sql).toContain("result_event.device_id = ?");
    expect(sql).toContain("result_event.session_id IN (?, ?)");
    expect(execute.mock.calls[0]?.[1]).toEqual([
      "account-a",
      "device-mac",
      "session-a",
      "session-b"
    ]);
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
