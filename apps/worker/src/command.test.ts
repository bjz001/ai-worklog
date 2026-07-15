import { describe, expect, it } from "vitest";
import { parseWorkerCommand } from "./command";

describe("parseWorkerCommand", () => {
  it("defaults to the account-local current day", () => {
    expect(parseWorkerCommand([])).toEqual({ mode: "today", workDate: null });
  });

  it("accepts one explicit work date without enabling queue backfill", () => {
    expect(parseWorkerCommand(["2026-07-14"])).toEqual({
      mode: "date",
      workDate: "2026-07-14"
    });
  });

  it("requires an explicit flag before processing the persistent backlog", () => {
    expect(parseWorkerCommand(["--backfill"])).toEqual({
      mode: "backfill",
      workDate: null
    });
  });

  it("rejects invalid dates and extra arguments", () => {
    expect(() => parseWorkerCommand(["2026-02-30"])).toThrow("date");
    expect(() => parseWorkerCommand(["--unknown"])).toThrow("arguments");
    expect(() => parseWorkerCommand(["--backfill", "2026-07-14"])).toThrow(
      "arguments"
    );
    expect(() => parseWorkerCommand(["2026-07-14", "extra"])).toThrow(
      "arguments"
    );
  });
});
