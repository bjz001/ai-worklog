import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./copy-text";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("uses the Clipboard API when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyText("one-time-value");

    expect(writeText).toHaveBeenCalledWith("one-time-value");
  });

  it("falls back to a temporary textarea on private HTTP pages", async () => {
    const dialogAppend = vi.fn();
    const previousFocus = {
      closest: vi.fn().mockReturnValue({ append: dialogAppend }),
      focus: vi.fn(),
      isConnected: true
    };
    const textarea = {
      focus: vi.fn(),
      remove: vi.fn(),
      select: vi.fn(),
      setAttribute: vi.fn(),
      style: {} as CSSStyleDeclaration,
      value: ""
    };
    const append = vi.fn();
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("insecure context")) }
    });
    vi.stubGlobal("document", {
      activeElement: previousFocus,
      body: { append },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand
    });

    await copyText("one-time-value");

    expect(dialogAppend).toHaveBeenCalledWith(textarea);
    expect(append).not.toHaveBeenCalled();
    expect(textarea.value).toBe("one-time-value");
    expect(textarea.select).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(previousFocus.focus).toHaveBeenCalledOnce();
  });

  it("restores focus even when the fallback copy fails", async () => {
    const previousFocus = { focus: vi.fn(), isConnected: true };
    const textarea = {
      focus: vi.fn(),
      remove: vi.fn(),
      select: vi.fn(),
      setAttribute: vi.fn(),
      style: {} as CSSStyleDeclaration,
      value: ""
    };
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      activeElement: previousFocus,
      body: { append: vi.fn() },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand: vi.fn().mockReturnValue(false)
    });

    await expect(copyText("one-time-value")).rejects.toThrow("Copy was not supported");

    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(previousFocus.focus).toHaveBeenCalledOnce();
  });

  it("cleans up and restores focus when selecting the fallback textarea fails", async () => {
    const previousFocus = { focus: vi.fn(), isConnected: true };
    const textarea = {
      focus: vi.fn(),
      remove: vi.fn(),
      select: vi.fn().mockImplementation(() => {
        throw new Error("selection failed");
      }),
      setAttribute: vi.fn(),
      style: {} as CSSStyleDeclaration,
      value: ""
    };
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      activeElement: previousFocus,
      body: { append: vi.fn() },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand: vi.fn()
    });

    await expect(copyText("one-time-value")).rejects.toThrow("selection failed");

    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(previousFocus.focus).toHaveBeenCalledOnce();
  });
});
