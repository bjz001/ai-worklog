import { describe, expect, it } from "vitest";
import {
  decryptApiKey,
  encryptApiKey,
  parseLlmEncryptionKey
} from "./llm-crypto";

describe("LLM credential encryption", () => {
  const masterKey = Buffer.from("11".repeat(32), "hex");

  it("round-trips with randomized AES-256-GCM ciphertext", () => {
    const first = encryptApiKey("sk-test-secret", masterKey, "account-a");
    const second = encryptApiKey("sk-test-secret", masterKey, "account-a");

    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("sk-test-secret");
    expect(decryptApiKey(first, masterKey, "account-a")).toBe("sk-test-secret");
    expect(() => decryptApiKey(first, masterKey, "account-b")).toThrow(
      "LLM credential could not be decrypted"
    );
  });

  it("fails closed when ciphertext is modified", () => {
    const encrypted = encryptApiKey("sk-test-secret", masterKey, "account-a");
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;

    expect(() => decryptApiKey(tampered, masterKey, "account-a")).toThrow(
      "LLM credential could not be decrypted"
    );
  });

  it("requires a dedicated 256-bit hex master key", () => {
    expect(
      parseLlmEncryptionKey({ LLM_SETTINGS_ENCRYPTION_KEY: "ab".repeat(32) })
    ).toEqual(Buffer.from("ab".repeat(32), "hex"));
    expect(() => parseLlmEncryptionKey({})).toThrow(
      "LLM_SETTINGS_ENCRYPTION_KEY"
    );
    expect(() =>
      parseLlmEncryptionKey({ LLM_SETTINGS_ENCRYPTION_KEY: "short" })
    ).toThrow("LLM_SETTINGS_ENCRYPTION_KEY");
  });
});
