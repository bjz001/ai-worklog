import { describe, expect, it } from "vitest";
import {
  buildCollectorEnvironment,
  parseEnvironment
} from "./configure-macos-collector.mjs";

describe("macOS collector configuration", () => {
  it("preserves an existing online-managed device identity and token", () => {
    const projectEnvironment = parseEnvironment([
      "APP_BASE_URL=http://172.18.209.21:3000",
      ""
    ].join("\n"));
    const existing = parseEnvironment([
      "AI_WORKLOG_ACCOUNT_ID=account_online",
      "AI_WORKLOG_DEVICE_ID=device_online",
      "AI_WORKLOG_DEVICE_TOKEN=online-token-canary",
      "CODEX_SOURCE_INSTANCE_ID=online-codex",
      "CLAUDE_CODE_SOURCE_INSTANCE_ID=online-claude",
      "AI_WORKLOG_PATH_HMAC_KEY=existing-path-key",
      ""
    ].join("\n"));

    const result = buildCollectorEnvironment({
      projectEnvironment,
      existing,
      home: "/Users/tester",
      nodeBinary: "/usr/local/bin/node",
      generatedPathHmacKey: "new-path-key"
    });

    expect(result).toContain("AI_WORKLOG_ACCOUNT_ID=account_online\n");
    expect(result).toContain("AI_WORKLOG_DEVICE_ID=device_online\n");
    expect(result).toContain("AI_WORKLOG_DEVICE_TOKEN=online-token-canary\n");
    expect(result).toContain("CODEX_SOURCE_INSTANCE_ID=online-codex\n");
    expect(result).toContain("CLAUDE_CODE_SOURCE_INSTANCE_ID=online-claude\n");
    expect(result).toContain("AI_WORKLOG_PATH_HMAC_KEY=existing-path-key\n");
    expect(result).not.toContain("new-path-key");
  });

  it("uses the bootstrap environment when no collector config exists", () => {
    const result = buildCollectorEnvironment({
      projectEnvironment: parseEnvironment([
        "APP_BASE_URL=https://worklog.example.test",
        "APP_ACCOUNT_ID=account_demo",
        "MACOS_DEVICE_ID=device_macos_demo",
        `MACOS_DEVICE_TOKEN=${"a".repeat(64)}`,
        ""
      ].join("\n")),
      existing: new Map(),
      home: "/Users/tester",
      nodeBinary: "/usr/local/bin/node",
      generatedPathHmacKey: "generated-path-key"
    });

    expect(result).toContain("AI_WORKLOG_ACCOUNT_ID=account_demo\n");
    expect(result).toContain("AI_WORKLOG_DEVICE_ID=device_macos_demo\n");
    expect(result).toContain("AI_WORKLOG_PROTOCOL_VERSION=2\n");
    expect(result).toContain("COLLECTOR_BLOB_ROOT=/Users/tester/.ai-worklog/blobs\n");
    expect(result).toContain("AI_WORKLOG_ALLOW_INSECURE_LAN_HTTP=false\n");
    expect(result).toContain("AI_WORKLOG_PATH_HMAC_KEY=generated-path-key\n");
  });
});
