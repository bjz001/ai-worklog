import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env.local");
const temporaryPath = `${envPath}.tmp-${process.pid}`;
const name = "LLM_SETTINGS_ENCRYPTION_KEY";

let source;
try {
  source = await readFile(envPath, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error(".env.local is missing; create it from .env.example first");
  }
  throw error;
}

const existingMatch = source.match(/^LLM_SETTINGS_ENCRYPTION_KEY=(.*)$/m);
const existing = existingMatch?.[1];
if (existing && /^[a-fA-F0-9]{64}$/.test(existing)) {
  await chmod(envPath, 0o600);
  process.stdout.write("LLM encryption master key is already configured.\n");
  process.exit(0);
}
if (
  existingMatch &&
  existing !== "" &&
  existing !== "replace-with-64-hex-characters"
) {
  throw new Error("Existing LLM_SETTINGS_ENCRYPTION_KEY is invalid");
}

const keyLine = `${name}=${randomBytes(32).toString("hex")}`;
const marker = /^(APP_TIME_ZONE=.*)$/m;
const updated = existingMatch
  ? source.replace(/^LLM_SETTINGS_ENCRYPTION_KEY=.*$/m, keyLine)
  : marker.test(source)
    ? source.replace(marker, `$1\n${keyLine}`)
    : `${source.replace(/\n?$/, "\n")}${keyLine}\n`;

await writeFile(temporaryPath, updated, { encoding: "utf8", mode: 0o600 });
await rename(temporaryPath, envPath);
await chmod(envPath, 0o600);
process.stdout.write("LLM encryption master key configured in .env.local.\n");
