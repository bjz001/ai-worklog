import { describe, expect, it } from "vitest";
import { searchableJson } from "./agent-source-utils.js";

describe("searchableJson", () => {
  it("keeps long human-readable prompt tokens searchable", () => {
    const prompt = `FACT_${"ReadableInstruction".repeat(20)}`;
    expect(searchableJson({ prompt })).toContain(prompt);
  });

  it("omits explicitly labelled binary and ciphertext fields from search text", () => {
    const searchable = searchableJson({
      prompt: "keep this prompt",
      encryptedContent: "A".repeat(512),
      image_base64: "B".repeat(512)
    });

    expect(searchable).toContain("keep this prompt");
    expect(searchable).not.toContain("A".repeat(128));
    expect(searchable).not.toContain("B".repeat(128));
  });
});
