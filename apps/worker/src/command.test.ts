import { describe, expect, it } from "vitest";
import { parseWorkerCommand } from "./command";

describe("parseWorkerCommand", () => {
  it("accepts an optional explicit work date", () => {
    expect(parseWorkerCommand([])).toEqual({ workDate: null });
    expect(parseWorkerCommand(["2026-07-14"])).toEqual({
      workDate: "2026-07-14"
    });
  });

  it("rejects invalid dates and extra arguments", () => {
    expect(() => parseWorkerCommand(["2026-02-30"])).toThrow("date");
    expect(() => parseWorkerCommand(["2026-07-14", "extra"])).toThrow(
      "arguments"
    );
  });
});
