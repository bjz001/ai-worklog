import { describe, expect, it } from "vitest";
import {
  buildEventId,
  normalizeGitRemote,
  redactSensitiveText
} from "./index";

describe("redactSensitiveText", () => {
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

