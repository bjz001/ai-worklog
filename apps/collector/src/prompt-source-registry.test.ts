import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPromptConnectorRegistry,
  parseAgentSourceSelection
} from "./agent-source-registry.js";

describe("Prompt source registry", () => {
  it("discovers all four sources for the Prompt-only collector", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prompt-registry-"));
    const codex = join(directory, "codex");
    const claude = join(directory, "claude");
    const zcode = join(directory, "zcode");
    const dsh = join(directory, "dsh");
    for (const path of [codex, claude, zcode, dsh]) mkdirSync(path, { recursive: true });
    writeFileSync(join(codex, "session.jsonl"), "{}\n");
    writeFileSync(join(claude, "session.jsonl"), "{}\n");
    writeFileSync(join(zcode, "events.jsonl"), "{}\n");
    writeFileSync(join(dsh, "sessions.db"), "not decoded during discovery");

    const entries = await createPromptConnectorRegistry({
      env: {
        CODEX_SOURCE_PATH: codex,
        CLAUDE_CODE_SOURCE_PATH: claude,
        ZCODE_HOOK_SPOOL: zcode,
        DSH_HOME: dsh
      },
      accountId: "account-1",
      deviceId: "device-1"
    });

    expect(entries.map((entry) => entry.connector.sourceType).sort()).toEqual([
      "CLAUDE_CODE", "CODEX", "DSH", "ZCODE"
    ]);
    expect(parseAgentSourceSelection("zcode")).toBe("ZCODE");
  });
});
