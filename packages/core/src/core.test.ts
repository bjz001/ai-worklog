import { describe, expect, it } from "vitest";
import {
  buildAgentEventId,
  buildAgentTextSegmentId,
  buildAgentBlobReferenceId,
  buildAgentRunId,
  buildEventId,
  normalizeGitRemote,
  repositoryRootName,
  redactSensitiveText
} from "./index";

describe("redactSensitiveText", () => {
  it("returns a fixed point that is safe to validate a second time", () => {
    const first = redactSensitiveText(
      "password: password=secret Cookie: api_key=secretvalue"
    );

    expect(redactSensitiveText(first)).toBe(first);
  });
  it("removes common credentials before data enters the outbox", () => {
    const input = [
      "Authorization: Bearer sk-live-super-secret-value",
      "mysql://root:password@db.internal:3306/worklog",
      "https://user:token@example.com/org/repo.git",
      "Cookie: session=abc123secret"
    ].join("\n");

    const output = redactSensitiveText(input);

    expect(output).not.toContain("sk-live-super-secret-value");
    expect(output).not.toContain("root:password");
    expect(output).not.toContain("user:token");
    expect(output).not.toContain("abc123secret");
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("redacts common provider and JWT token shapes without a key label", () => {
    const secrets = [
      "ghp_1234567890abcdefghijklmnopqrstuvwxyzAB",
      "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456"
    ];
    const output = redactSensitiveText(secrets.join("\n"));

    for (const secret of secrets) expect(output).not.toContain(secret);
  });

  it("redacts bare database credential tuples and Chinese secret labels", () => {
    const databasePassword = "fixtureDbPassword987";
    const labeledSecret = "fixtureChineseSecret654";
    const output = redactSensitiveText([
      `10.20.30.40 3306 root ${databasePassword}`,
      `数据库密码：${labeledSecret}`
    ].join("\n"));

    expect(output).not.toContain(databasePassword);
    expect(output).not.toContain(labeledSecret);
    expect(output).toContain("10.20.30.40 3306 root [REDACTED]");
    expect(output).toContain("数据库密码：[REDACTED]");
  });
});

describe("normalizeGitRemote", () => {
  it("maps SSH and HTTPS remotes to one credential-free project key", () => {
    expect(normalizeGitRemote("git@github.com:Acme/Worklog.git")).toBe(
      "github.com/acme/worklog"
    );
    expect(
      normalizeGitRemote("https://token@github.com/Acme/Worklog.git?x=1")
    ).toBe("github.com/acme/worklog");
  });
});

describe("repositoryRootName", () => {
  it("derives the same credential-free fallback from Windows and macOS paths", () => {
    expect(repositoryRootName("C:\\Users\\demo\\work\\ai-worklog\\")).toBe(
      "ai-worklog"
    );
    expect(repositoryRootName("/Users/demo/work/ai-worklog/")).toBe(
      "ai-worklog"
    );
  });
});

describe("buildEventId", () => {
  it("is stable across parser versions and content changes", () => {
    const identity = {
      accountId: "account_demo",
      deviceId: "device_macos",
      sourceType: "CODEX",
      sourceInstanceId: "codex-macos",
      sourceSessionId: "session-1",
      sourceMessageId: "message-2",
      messageIndex: 2
    } as const;

    expect(buildEventId(identity)).toBe(buildEventId(identity));
  });

  it("preserves equal prompts that occurred as different source messages", () => {
    const base = {
      accountId: "account_demo",
      deviceId: "device_macos",
      sourceType: "CODEX",
      sourceInstanceId: "codex-macos",
      sourceSessionId: "session-1",
      messageIndex: 2
    } as const;

    expect(buildEventId({ ...base, sourceMessageId: "message-a" })).not.toBe(
      buildEventId({ ...base, sourceMessageId: "message-b" })
    );
  });
});

describe("agent trajectory identities", () => {
  const identity = {
    accountId: "account_demo",
    deviceId: "device_macos",
    sourceType: "CODEX",
    sourceInstanceId: "codex-macos",
    sourceSessionId: "session-1"
  } as const;

  it("builds a stable run identity independent of parser and content", () => {
    expect(buildAgentRunId(identity)).toBe(buildAgentRunId(identity));
    expect(buildAgentRunId(identity)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("preserves the legacy user/assistant event identity", () => {
    const legacy = buildEventId({
      ...identity,
      sourceMessageId: "message-2",
      messageIndex: 2
    });
    const agent = buildAgentEventId({
      ...identity,
      sourceEventId: "message-2",
      sequence: 2
    });

    expect(agent).toBe(legacy);
  });

  it("preserves the legacy positional fallback identity", () => {
    const legacy = buildEventId({
      ...identity,
      sourceMessageId: null,
      messageIndex: 7
    });
    const agent = buildAgentEventId({
      ...identity,
      sourceEventId: "index:7",
      sequence: 7
    });

    expect(agent).toBe(legacy);
  });

  it("binds text segments and blob references to their immutable identities", () => {
    const eventId = "a".repeat(64);
    expect(buildAgentTextSegmentId({
      eventId,
      ordinal: 0,
      purpose: "RENDERED_CONTENT",
      contentSha256: "b".repeat(64)
    })).not.toBe(buildAgentTextSegmentId({
      eventId,
      ordinal: 0,
      purpose: "RENDERED_CONTENT",
      contentSha256: "c".repeat(64)
    }));
    expect(buildAgentBlobReferenceId({
      runId: "d".repeat(64),
      eventId,
      purpose: "ATTACHMENT",
      requestedPath: "/tmp/demo.txt"
    })).toMatch(/^[a-f0-9]{64}$/u);
  });
});
