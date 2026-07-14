import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Outbox } from "./outbox.js";
import { parseCommand, runCli } from "./cli.js";

const fixturesRoot = fileURLToPath(new URL("../../../fixtures/codex/", import.meta.url));

describe("collector CLI", () => {
  it.each(["prepare", "sync", "status", "run-fixtures"] as const)(
    "accepts the %s command",
    (command) => {
      expect(parseCommand([command]).command).toBe(command);
    }
  );

  it("rejects unknown commands without echoing environment secrets", () => {
    expect(() => parseCommand(["unknown", "fixture-device-token"])).toThrow("Unknown command: unknown");
  });

  it("runs both platform fixtures and reports counts without exposing a configured token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-"));
    const databasePath = join(directory, "collector.sqlite");
    const output: string[] = [];
    const token = "fixture-token-must-not-be-printed";

    await runCli(["run-fixtures"], {
      env: {
        COLLECTOR_DB_PATH: databasePath,
        COLLECTOR_FIXTURES_ROOT: resolve(fixturesRoot),
        AI_WORKLOG_DEVICE_TOKEN: token
      },
      write: (line) => output.push(line)
    });

    const outbox = new Outbox(databasePath);
    expect(outbox.status()).toEqual({ pending: 2, acked: 0, total: 2 });
    outbox.close();
    expect(output.join("\n")).not.toContain(token);
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({ command: "run-fixtures", prepared: 2 });
  });

  it("reports only aggregate Outbox status", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-cli-"));
    const databasePath = join(directory, "collector.sqlite");
    const output: string[] = [];

    await runCli(["status"], {
      env: { COLLECTOR_DB_PATH: databasePath },
      write: (line) => output.push(line)
    });

    expect(output).toEqual([
      JSON.stringify({ command: "status", pending: 0, acked: 0, total: 0 })
    ]);
  });
});
