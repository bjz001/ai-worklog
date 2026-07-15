import { createPrivateKey } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { createServer } from "node:https";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { createSecureContext, X509Certificate } from "node:tls";
import { fileURLToPath } from "node:url";

import { parseHttpsServerConfig } from "./server-config.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webDirectory = join(projectRoot, "apps/web");
const environmentPath = join(projectRoot, ".env.local");
const MAX_PRIVATE_FILE_BYTES = 1024 * 1024;

function safeEvent(phase, status) {
  process.stdout.write(
    `${JSON.stringify({
      event: "ai-worklog-web",
      phase,
      status,
      at: new Date().toISOString()
    })}\n`
  );
}

function failStartup() {
  throw new Error("Invalid HTTPS server runtime");
}

function readPrivateFile(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    failStartup();
  }

  const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !metadata ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (currentUserId !== null && metadata.uid !== currentUserId) ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size <= 0 ||
    metadata.size > MAX_PRIVATE_FILE_BYTES
  ) {
    failStartup();
  }

  return readFileSync(path);
}

function validateBuildOutput() {
  const buildIdPath = join(webDirectory, ".next/BUILD_ID");
  let metadata;
  try {
    metadata = lstatSync(buildIdPath);
  } catch {
    failStartup();
  }
  const currentUserId = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !metadata ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (currentUserId !== null && metadata.uid !== currentUserId) ||
    metadata.size <= 0 ||
    metadata.size > 1024
  ) {
    failStartup();
  }
}

function hostIsAssigned(host) {
  return Object.values(networkInterfaces()).some((addresses) =>
    addresses?.some(
      (address) => address.family === "IPv4" && address.address === host
    )
  );
}

function loadRuntime() {
  readPrivateFile(environmentPath);
  loadEnvFile(environmentPath);
  const config = parseHttpsServerConfig(process.env);

  if (!hostIsAssigned(config.bindHost)) failStartup();
  validateBuildOutput();

  const cert = readPrivateFile(config.certPath);
  const key = readPrivateFile(config.keyPath);
  let certificate;
  try {
    certificate = new X509Certificate(cert);
    if (!certificate.checkPrivateKey(createPrivateKey(key))) failStartup();
    createSecureContext({ cert, key, minVersion: "TLSv1.2" });
  } catch {
    failStartup();
  }

  const now = Date.now();
  if (
    !certificate ||
    certificate.ca ||
    certificate.checkIP(config.bindHost) !== config.bindHost ||
    !Number.isFinite(Date.parse(certificate.validFrom)) ||
    !Number.isFinite(Date.parse(certificate.validTo)) ||
    Date.parse(certificate.validFrom) > now ||
    Date.parse(certificate.validTo) <= now
  ) {
    failStartup();
  }

  return { config, cert, key };
}

async function listen(server, port, host) {
  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => rejectPromise(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
}

async function startServer(runtime) {
  if (process.env.NODE_ENV && process.env.NODE_ENV !== "production") failStartup();
  process.env.NODE_ENV = "production";
  const { default: next } = await import("next");
  const app = next({
    dev: false,
    dir: webDirectory,
    hostname: runtime.config.bindHost,
    port: runtime.config.port
  });
  await app.prepare();

  const expectedHost = new URL(runtime.config.baseUrl).host;
  const requestHandler = app.getRequestHandler();
  const handleRequest = (request, response) => {
    if (request.headers.host !== expectedHost) {
      response.writeHead(421, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "close"
      });
      response.end("Misdirected Request");
      return;
    }
    Promise.resolve(requestHandler(request, response)).catch(() => {
      safeEvent("request", "failed");
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "close"
      });
      response.end("Internal Server Error");
    });
  };

  const server = createServer(
    {
      cert: runtime.cert,
      key: runtime.key,
      minVersion: "TLSv1.2",
      maxHeaderSize: 16 * 1024
    },
    handleRequest
  );
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 100;

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    safeEvent("shutdown", "started");
    const forceCloseTimer = setTimeout(() => server.closeAllConnections(), 10_000);
    forceCloseTimer.unref();
    server.close(async () => {
      clearTimeout(forceCloseTimer);
      try {
        await app.close();
      } catch {
        safeEvent("shutdown", "failed");
        process.exitCode = 1;
        return;
      }
      safeEvent("shutdown", "completed");
      process.exitCode = 0;
    });
    server.closeIdleConnections();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.on("error", () => {
    safeEvent("server", "failed");
    shutdown();
  });

  await listen(server, runtime.config.port, runtime.config.bindHost);
  safeEvent("server", "ready");
}

async function main() {
  const validateOnly =
    process.argv.length === 3 && process.argv[2] === "--validate-only";
  if (process.argv.length > (validateOnly ? 3 : 2)) failStartup();

  const runtime = loadRuntime();
  if (validateOnly) {
    safeEvent("validation", "ok");
    return;
  }
  await startServer(runtime);
}

main().catch(() => {
  safeEvent("startup", "failed");
  process.exitCode = 1;
});
