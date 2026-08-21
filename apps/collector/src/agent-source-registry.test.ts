import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAgentConnectorRegistry,
  parseAgentSourceSelection
} from "./agent-source-registry.js";

describe("Agent connector registry", () => {
  it("auto-discovers all four sources and supports an explicit source limit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-registry-"));
    const codex = join(directory, "codex");
    const claude = join(directory, "claude");
    const zcode = join(directory, "zcode", "session");
    const dsh = join(directory, "dsh");
    mkdirSync(codex, { recursive: true });
    mkdirSync(claude, { recursive: true });
    mkdirSync(zcode, { recursive: true });
    mkdirSync(dsh, { recursive: true });
    writeFileSync(join(codex, "session.jsonl"), "{}\n");
    writeFileSync(join(claude, "session.jsonl"), "{}\n");
    writeFileSync(join(zcode, "events.jsonl"), "{}\n");
    writeFileSync(join(dsh, "sessions.db"), "not decoded during discovery");
    const env = {
      CODEX_SOURCE_PATH: codex,
      CLAUDE_CODE_SOURCE_PATH: claude,
      ZCODE_HOOK_SPOOL: join(directory, "zcode"),
      DSH_HOME: dsh
    };

    const all = await createAgentConnectorRegistry({
      env,
      accountId: "account-1",
      deviceId: "device-1"
    });
    const selected = await createAgentConnectorRegistry({
      env,
      accountId: "account-1",
      deviceId: "device-1",
      selectedSource: "ZCODE"
    });

    expect(all.map((entry) => entry.connector.sourceType).sort()).toEqual([
      "CLAUDE_CODE", "CODEX", "DSH", "ZCODE"
    ]);
    expect(all.every((entry) => entry.candidates.length === 1)).toBe(true);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.connector.sourceType).toBe("ZCODE");
  });

  it("validates CLI source values without reflecting arbitrary input", () => {
    expect(parseAgentSourceSelection("dsh")).toBe("DSH");
    expect(() => parseAgentSourceSelection("DSH;token=secret"))
      .toThrow("Unsupported Agent source");
  });
});
