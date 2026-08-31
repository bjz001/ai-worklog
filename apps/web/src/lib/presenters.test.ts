import { describe, expect, it } from "vitest";

import {
  deviceStatusMeta,
  formatDateTime,
  formatSource,
  summarizeText
} from "./presenters";

describe("formatDateTime", () => {
  it("uses a stable fallback for missing and invalid values", () => {
    expect(formatDateTime(null)).toBe("尚未同步");
    expect(formatDateTime("not-a-date")).toBe("时间未知");
  });

  it("formats valid timestamps for the Chinese interface", () => {
    expect(formatDateTime("2026-07-14T09:30:00+08:00", "Asia/Shanghai")).toContain(
      "7月14日"
    );
  });
});

describe("status and source presentation", () => {
  it("describes partial sync with text rather than color alone", () => {
    expect(deviceStatusMeta("PARTIAL")).toEqual({
      label: "部分成功",
      tone: "warning",
      icon: "warning"
    });
  });

  it("provides human-readable source labels", () => {
    expect(formatSource("CLAUDE_CODE")).toBe("Claude Code");
    expect(formatSource("CODEX")).toBe("Codex");
    expect(formatSource("ZCODE")).toBe("ZCode");
    expect(formatSource("DSH")).toBe("DSH");
  });
});

describe("summarizeText", () => {
  it("keeps short text and shortens long text predictably", () => {
    expect(summarizeText("简短内容", 12)).toBe("简短内容");
    expect(summarizeText("这是一个需要被截断的较长内容", 10)).toBe("这是一个需要被截断…");
  });
});
