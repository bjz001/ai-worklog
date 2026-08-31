import type { DeviceEnrollment } from "@ai-worklog/contracts";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  bashSingleQuotedLiteral,
  buildDeviceSetup,
  powerShellSingleQuotedLiteral
} from "./device-setup";

const enrollment: DeviceEnrollment = {
  accountId: "account_demo",
  deviceId: "device_abc123",
  deviceToken: "a".repeat(64),
  syncUrl: "http://172.18.209.21:3000/api/v1/sync/batches"
};

const preservedKeys = [
  "AI_WORKLOG_PATH_HMAC_KEY",
  "CODEX_SOURCE_INSTANCE_ID",
  "CODEX_SOURCE_PATH",
  "CLAUDE_CODE_SOURCE_INSTANCE_ID",
  "CLAUDE_CODE_SOURCE_PATH",
  "ZCODE_SOURCE_INSTANCE_ID",
  "ZCODE_HOOK_SPOOL",
  "ZCODE_CONFIG_PATH",
  "DSH_SOURCE_INSTANCE_ID",
  "DSH_SOURCE_PATH",
  "COLLECTOR_DB_PATH",
  "NODE_BINARY"
];

describe("buildDeviceSetup", () => {
  it.each(["MACOS", "WINDOWS"] as const)(
    "keeps the one-time token out of %s commands",
    (platform) => {
      const setup = buildDeviceSetup(platform, enrollment);
      const commands = [
        setup.configureCommand,
        setup.validateCommand,
        setup.installCommand
      ].join("\n");

      expect(commands).not.toContain(enrollment.deviceToken);
      expect(commands).toContain(enrollment.accountId);
      expect(commands).toContain(enrollment.deviceId);
      expect(commands).toContain(enrollment.syncUrl);
      expect(commands).toMatch(/Read-Host|read -r -s/);
    }
  );

  it("uses platform-specific private config paths", () => {
    expect(buildDeviceSetup("MACOS", enrollment).configPath).toBe(
      "~/.config/ai-worklog/collector.env"
    );
    expect(buildDeviceSetup("WINDOWS", enrollment).configPath).toBe(
      "%LOCALAPPDATA%\\AIWorklog\\collector.env"
    );
  });

  it("quarantines legacy Windows Outbox data before installing the scheduler", () => {
    const command = buildDeviceSetup("WINDOWS", enrollment).installCommand;
    const quarantine = command.indexOf("Run.ps1\" -ConfigPath $Config -QuarantineLegacy");
    const status = command.indexOf("Run.ps1\" -ConfigPath $Config -Status");
    const hook = command.indexOf("npm run collector -- install-zcode-hook");
    const install = command.indexOf("Install.ps1");

    expect(quarantine).toBeGreaterThan(-1);
    expect(quarantine).toBeLessThan(status);
    expect(status).toBeLessThan(hook);
    expect(hook).toBeLessThan(install);
  });

  it.each(["MACOS", "WINDOWS"] as const)(
    "keeps first-time defaults without reading an existing %s config",
    (platform) => {
      const command = buildDeviceSetup(platform, enrollment, "INITIAL").configureCommand;

      expect(command).toContain(`CODEX_SOURCE_INSTANCE_ID=${enrollment.deviceId}-codex`);
      expect(command).toContain(
        `CLAUDE_CODE_SOURCE_INSTANCE_ID=${enrollment.deviceId}-claude-code`
      );
      expect(command).toContain(".codex");
      expect(command).toContain(".claude");
      expect(command).toContain("ZCODE_HOOK_SPOOL");
      expect(command).toContain("DSH_SOURCE_PATH");
      expect(command).toContain("collector.sqlite");
      expect(command).not.toContain("read_preserved_value");
      expect(command).not.toContain("$PreserveKeys");
    }
  );

  it.each(["MACOS", "WINDOWS"] as const)(
    "preserves only allowlisted local settings while rotating a %s token",
    (platform) => {
      const command = buildDeviceSetup(platform, enrollment, "ROTATE").configureCommand;

      for (const key of preservedKeys) expect(command).toContain(key);
      expect(command).toContain(`AI_WORKLOG_ACCOUNT_ID=${enrollment.accountId}`);
      expect(command).toContain(`AI_WORKLOG_DEVICE_ID=${enrollment.deviceId}`);
      expect(command).toContain(`AI_WORKLOG_SYNC_URL=${enrollment.syncUrl}`);
      expect(command).not.toContain(enrollment.deviceToken);

      if (platform === "MACOS") {
        expect(command).toContain("read_preserved_value()");
        expect(command).toContain('done < "$CONFIG"');
        expect(command).not.toContain('read_preserved_value "AI_WORKLOG_ACCOUNT_ID"');
        expect(command).not.toContain('read_preserved_value "AI_WORKLOG_DEVICE_ID"');
        expect(command).not.toContain('read_preserved_value "AI_WORKLOG_SYNC_URL"');
        expect(command).not.toContain('read_preserved_value "AI_WORKLOG_DEVICE_TOKEN"');
        expect(command).not.toMatch(/\bsource\s+["']?\$CONFIG/u);
        expect(command).not.toMatch(/(?:^|\n)\s*\.\s+["']?\$CONFIG/u);
        expect(command).not.toMatch(/\beval\b/u);
      } else {
        expect(command).toContain("$PreserveKeys = @(");
        expect(command).toContain("[IO.File]::ReadAllLines($Config)");
        const preserveList = command.slice(
          command.indexOf("$PreserveKeys = @("),
          command.indexOf("$PreservedValues = @{}")
        );
        expect(preserveList).not.toContain("AI_WORKLOG_ACCOUNT_ID");
        expect(preserveList).not.toContain("AI_WORKLOG_DEVICE_ID");
        expect(preserveList).not.toContain("AI_WORKLOG_SYNC_URL");
        expect(preserveList).not.toContain("AI_WORKLOG_DEVICE_TOKEN");
        expect(command).not.toContain("Invoke-Expression");
      }
    }
  );

  it("returns failure before writing when macOS preservation is unsafe", () => {
    const command = buildDeviceSetup("MACOS", enrollment, "ROTATE").configureCommand;
    const safetyCheck = command.indexOf('[ -L "$CONFIG" ]');
    const failure = command.indexOf("\n  exit 1\nfi", safetyCheck);
    const configWrite = command.indexOf('> "$TEMP_CONFIG"');

    expect(safetyCheck).toBeGreaterThan(-1);
    expect(failure).toBeGreaterThan(safetyCheck);
    expect(configWrite).toBeGreaterThan(failure);
  });

  it("rejects unsafe existing macOS config files during first-time setup", () => {
    const command = buildDeviceSetup("MACOS", enrollment, "INITIAL").configureCommand;
    const safetyCheck = command.indexOf('[ -L "$CONFIG" ]');
    const failure = command.indexOf("\n  exit 1\nfi", safetyCheck);
    const configWrite = command.indexOf('> "$TEMP_CONFIG"');

    expect(safetyCheck).toBeGreaterThan(-1);
    expect(failure).toBeGreaterThan(safetyCheck);
    expect(configWrite).toBeGreaterThan(failure);
  });

  it.each(["INITIAL", "ROTATE"] as const)(
    "atomically replaces the macOS config and fails before a false success in %s mode",
    (mode) => {
      const command = buildDeviceSetup("MACOS", enrollment, mode).configureCommand;
      const makeTemp = command.indexOf('mktemp "$CONFIG_DIRECTORY/.collector.env.XXXXXX"');
      const writeTemp = command.indexOf('> "$TEMP_CONFIG"');
      const move = command.indexOf('mv -f "$TEMP_CONFIG" "$CONFIG"');
      const success = command.indexOf("echo '配置已写入");

      expect(command).toContain("set -e");
      expect(command).toContain("trap cleanup_temp_config EXIT");
      expect(command).toContain('chmod 700 "$CONFIG_DIRECTORY" "$DATA_DIRECTORY"');
      expect(command).not.toContain('> "$CONFIG"');
      expect(makeTemp).toBeGreaterThan(-1);
      expect(writeTemp).toBeGreaterThan(makeTemp);
      expect(move).toBeGreaterThan(writeTemp);
      expect(success).toBeGreaterThan(move);
    }
  );

  it.each(["MACOS", "WINDOWS"] as const)(
    "validates the hidden %s token before changing the config",
    (platform) => {
      const command = buildDeviceSetup(platform, enrollment).configureCommand;
      const validation = command.indexOf("^[a-f0-9]{64}$");
      const configWrite = platform === "MACOS"
        ? command.indexOf('> "$TEMP_CONFIG"')
        : command.indexOf("WriteAllLines($TempConfig");

      expect(validation).toBeGreaterThan(-1);
      expect(configWrite).toBeGreaterThan(validation);
    }
  );

  it("rejects a public plain HTTP endpoint even for a typed caller", () => {
    expect(() => buildDeviceSetup("WINDOWS", {
      ...enrollment,
      syncUrl: "http://203.0.113.10:3000/api/v1/sync/batches"
    })).toThrow("enrollment");
  });

  it.each([
    "https://user:password@example.com/api/v1/sync/batches",
    "https://example.com/api/v1/sync/batches?command=unexpected",
    "https://example.com/api/v1/sync/batches#unexpected",
    "https://example.com/not-the-sync-endpoint",
    "https://evil'host.example/api/v1/sync/batches",
    "https://evil;host.example/api/v1/sync/batches",
    "https://evil$(id).example/api/v1/sync/batches",
    "https://evil`id`.example/api/v1/sync/batches",
    "https://evil host.example/api/v1/sync/batches",
    "https://evil\thost.example/api/v1/sync/batches",
    "https://例子.测试/api/v1/sync/batches",
    "https://exam_ple.example/api/v1/sync/batches",
    "https://-leading-hyphen.example/api/v1/sync/batches",
    "https://trailing-hyphen-.example/api/v1/sync/batches"
  ])("rejects a non-canonical sync endpoint: %s", (syncUrl) => {
    expect(() => buildDeviceSetup("MACOS", {
      ...enrollment,
      syncUrl
    })).toThrow("enrollment");
  });

  it("escapes Bash and PowerShell single-quoted literals independently", () => {
    const hostile = "value'$(touch /tmp/pwned)`whoami`";

    expect(bashSingleQuotedLiteral(hostile)).toBe(
      "'value'\"'\"'$(touch /tmp/pwned)`whoami`'"
    );
    expect(powerShellSingleQuotedLiteral(hostile)).toBe(
      "'value''$(touch /tmp/pwned)`whoami`'"
    );
  });

  it("uses escaped single-quoted literals for enrollment values", () => {
    const mac = buildDeviceSetup("MACOS", enrollment).configureCommand;
    const windows = buildDeviceSetup("WINDOWS", enrollment).configureCommand;

    expect(mac).toContain("'AI_WORKLOG_ACCOUNT_ID=account_demo'");
    expect(mac).toContain(
      "'AI_WORKLOG_SYNC_URL=http://172.18.209.21:3000/api/v1/sync/batches'"
    );
    expect(windows).toContain("'AI_WORKLOG_ACCOUNT_ID=account_demo'");
    expect(windows).toContain(
      "'AI_WORKLOG_SYNC_URL=http://172.18.209.21:3000/api/v1/sync/batches'"
    );
  });

  it("creates both source directories on macOS before validation", () => {
    const command = buildDeviceSetup("MACOS", enrollment).configureCommand;

    expect(command).toContain('mkdir -p "$HOME/.codex/sessions"');
    expect(command).toContain('mkdir -p "$HOME/.claude/projects"');
    expect(command).toContain('mkdir -p "$HOME/.ai-worklog/zcode-spool"');
  });

  it.each(["INITIAL", "ROTATE"] as const)(
    "secures a Windows temp file before writing the token and replacing the config in %s mode",
    (mode) => {
    const command = buildDeviceSetup("WINDOWS", enrollment, mode).configureCommand;
    const inheritance = command.indexOf("icacls $TempConfig /inheritance:r");
    const grant = command.indexOf("icacls $TempConfig /grant:r");
    const tokenLine = command.indexOf('"AI_WORKLOG_DEVICE_TOKEN=$Token"');

    expect(command).toContain(
      'New-Item -ItemType Directory -Path $CodexPath, $ClaudePath, $ZcodeSpoolPath -Force'
    );
    expect(inheritance).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(inheritance);
    expect(command.match(/\$LASTEXITCODE/g)).toHaveLength(2);
    expect(tokenLine).toBeGreaterThan(grant);
    expect(command).not.toContain("WriteAllLines($Config");
    expect(command).toContain("WriteAllLines($TempConfig");
    expect(command).toContain(
      "[AIWorklog.NativeMethods]::MoveFileEx($TempConfig, $Config"
    );
    expect(command).toContain("Remove-Item -LiteralPath $TempConfig");
    }
  );
});

describe.skipIf(process.platform === "win32")(
  "generated macOS setup command",
  () => {
    const run = (home: string, command: string, token: string, path?: string) =>
      spawnSync("/bin/bash", ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, PATH: path ?? process.env.PATH },
        input: `${token}\n`
      });

    it("writes a private config through an atomic temporary file", () => {
      const home = mkdtempSync(join(tmpdir(), "ai-worklog-device-setup-"));
      const token = "b".repeat(64);
      try {
        const result = run(
          home,
          buildDeviceSetup("MACOS", enrollment, "INITIAL").configureCommand,
          token
        );
        const configDirectory = join(home, ".config", "ai-worklog");
        const configPath = join(configDirectory, "collector.env");

        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(configPath, "utf8")).toContain(
          `AI_WORKLOG_DEVICE_TOKEN=${token}`
        );
        expect(statSync(configDirectory).mode & 0o777).toBe(0o700);
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
        expect(
          readdirSync(configDirectory).filter((name) =>
            name.startsWith(".collector.env.")
          )
        ).toEqual([]);
      } finally {
        rmSync(home, { force: true, recursive: true });
      }
    });

    it("preserves the old config and reports failure when the atomic write fails", () => {
      const home = mkdtempSync(join(tmpdir(), "ai-worklog-device-failure-"));
      const configDirectory = join(home, ".config", "ai-worklog");
      const configPath = join(configDirectory, "collector.env");
      const fakeBin = join(home, "fake-bin");
      const oldConfig = [
        "AI_WORKLOG_PATH_HMAC_KEY=preserved-hmac-key",
        "CODEX_SOURCE_INSTANCE_ID=preserved-codex",
        "CODEX_SOURCE_PATH=/tmp/preserved-codex",
        "CLAUDE_CODE_SOURCE_INSTANCE_ID=preserved-claude",
        "CLAUDE_CODE_SOURCE_PATH=/tmp/preserved-claude",
        "COLLECTOR_DB_PATH=/tmp/preserved.sqlite",
        "NODE_BINARY=/usr/bin/false",
        `AI_WORKLOG_DEVICE_TOKEN=${"c".repeat(64)}`,
        ""
      ].join("\n");
      try {
        mkdirSync(configDirectory, { mode: 0o700, recursive: true });
        mkdirSync(fakeBin, { mode: 0o700, recursive: true });
        writeFileSync(configPath, oldConfig, { mode: 0o600 });
        const fakeMktemp = join(fakeBin, "mktemp");
        writeFileSync(fakeMktemp, "#!/bin/sh\nexit 71\n", { mode: 0o700 });
        chmodSync(fakeMktemp, 0o700);

        const result = run(
          home,
          buildDeviceSetup("MACOS", enrollment, "ROTATE").configureCommand,
          "d".repeat(64),
          `${fakeBin}:${process.env.PATH ?? ""}`
        );

        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain("配置已写入");
        expect(readFileSync(configPath, "utf8")).toBe(oldConfig);
      } finally {
        rmSync(home, { force: true, recursive: true });
      }
    });

    it("rejects an invalid token without changing an existing config", () => {
      const home = mkdtempSync(join(tmpdir(), "ai-worklog-device-token-"));
      const configDirectory = join(home, ".config", "ai-worklog");
      const configPath = join(configDirectory, "collector.env");
      const oldConfig = "AI_WORKLOG_DEVICE_TOKEN=existing-value\n";
      try {
        mkdirSync(configDirectory, { mode: 0o700, recursive: true });
        writeFileSync(configPath, oldConfig, { mode: 0o600 });

        const result = run(
          home,
          buildDeviceSetup("MACOS", enrollment, "INITIAL").configureCommand,
          "truncated"
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Token 格式无效");
        expect(readFileSync(configPath, "utf8")).toBe(oldConfig);
      } finally {
        rmSync(home, { force: true, recursive: true });
      }
    });
  }
);
