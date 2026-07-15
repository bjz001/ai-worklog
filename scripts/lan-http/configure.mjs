import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { lanHttpOrigin, updateAppBaseUrl } from "./config.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let environmentPath = join(projectRoot, ".env.local");
let host = "";
let port = "3000";

function failConfiguration() {
  throw new Error("Invalid LAN HTTP configuration");
}

for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!value) failConfiguration();
  if (flag === "--env") environmentPath = value;
  else if (flag === "--host") host = value;
  else if (flag === "--port") port = value;
  else failConfiguration();
}
if (!isAbsolute(environmentPath) || /[\0\r\n]/.test(environmentPath)) {
  failConfiguration();
}
const origin = lanHttpOrigin(host, port);

const metadata = await lstat(environmentPath).catch(() => null);
const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
if (
  !metadata ||
  !metadata.isFile() ||
  metadata.isSymbolicLink() ||
  (currentUserId !== null && metadata.uid !== currentUserId) ||
  (metadata.mode & 0o077) !== 0 ||
  metadata.size <= 0 ||
  metadata.size > 1024 * 1024
) {
  failConfiguration();
}

const source = await readFile(environmentPath, "utf8");
const updated = updateAppBaseUrl(source, origin);
const temporaryPath = `${environmentPath}.lan-http-${process.pid}`;
let handle;
try {
  handle = await open(temporaryPath, "wx", 0o600);
  await handle.writeFile(updated, "utf8");
  await handle.sync();
  await handle.close();
  handle = undefined;
  await rename(temporaryPath, environmentPath);
  await chmod(environmentPath, 0o600);
} catch (error) {
  if (handle) await handle.close().catch(() => undefined);
  await unlink(temporaryPath).catch(() => undefined);
  throw error;
}

process.stdout.write("LAN HTTP address configured without exposing environment values.\n");
