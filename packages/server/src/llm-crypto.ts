import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";

const ENCRYPTION_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
function aad(accountId: string): Buffer {
  if (!accountId) throw new Error("invalid account");
  return Buffer.from(`ai-worklog-llm-credential-v1\0${accountId}`, "utf8");
}

function encoded(value: Buffer): string {
  return value.toString("base64url");
}

function decoded(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding");
  const result = Buffer.from(value, "base64url");
  if (encoded(result) !== value) throw new Error("invalid encoding");
  return result;
}

export function parseLlmEncryptionKey(
  environment: Record<string, string | undefined> = process.env
): Buffer {
  const value = environment.LLM_SETTINGS_ENCRYPTION_KEY;
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(
      "LLM_SETTINGS_ENCRYPTION_KEY must be a 64-character hexadecimal value"
    );
  }
  return Buffer.from(value, "hex");
}

export function encryptApiKey(
  apiKey: string,
  masterKey: Buffer,
  accountId: string
): string {
  if (masterKey.length !== 32) {
    throw new Error("LLM encryption master key must contain 32 bytes");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  cipher.setAAD(aad(accountId));
  const ciphertext = Buffer.concat([
    cipher.update(apiKey, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [ENCRYPTION_VERSION, encoded(iv), encoded(tag), encoded(ciphertext)].join(
    "."
  );
}

export function decryptApiKey(
  encrypted: string,
  masterKey: Buffer,
  accountId: string
): string {
  try {
    if (masterKey.length !== 32) throw new Error("invalid key");
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] =
      encrypted.split(".");
    if (
      version !== ENCRYPTION_VERSION ||
      !encodedIv ||
      !encodedTag ||
      !encodedCiphertext ||
      extra !== undefined
    ) {
      throw new Error("invalid envelope");
    }
    const iv = decoded(encodedIv);
    const tag = decoded(encodedTag);
    const ciphertext = decoded(encodedCiphertext);
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error("invalid envelope");
    }
    const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
    decipher.setAAD(aad(accountId));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new Error("LLM credential could not be decrypted");
  }
}
