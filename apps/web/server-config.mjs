import { isIP } from "node:net";
import { isAbsolute } from "node:path";

const CONFIGURATION_ERROR = "Invalid HTTPS server configuration";

function failConfiguration() {
  throw new Error(CONFIGURATION_ERROR);
}

function requiredValue(environment, key) {
  const value = environment?.[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    failConfiguration();
  }
  return value;
}

function isPrivateIpv4(host) {
  const octets = host.split(".").map(Number);
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

export function parseHttpsServerConfig(environment) {
  const baseUrlValue = requiredValue(environment, "APP_BASE_URL");
  const bindHost = requiredValue(environment, "AI_WORKLOG_HTTPS_BIND_HOST");
  const certPath = requiredValue(environment, "AI_WORKLOG_TLS_CERT_PATH");
  const keyPath = requiredValue(environment, "AI_WORKLOG_TLS_KEY_PATH");

  let baseUrl;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    failConfiguration();
  }

  const authorityMatch = baseUrlValue.match(
    /^https:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})\/?$/
  );
  const port = authorityMatch ? Number(authorityMatch[2]) : Number.NaN;

  if (
    !baseUrl ||
    baseUrl.protocol !== "https:" ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.pathname !== "/" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== "" ||
    !authorityMatch ||
    isIP(baseUrl.hostname) !== 4 ||
    !isPrivateIpv4(baseUrl.hostname) ||
    baseUrl.hostname === "0.0.0.0" ||
    bindHost !== baseUrl.hostname ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !isAbsolute(certPath) ||
    !isAbsolute(keyPath) ||
    certPath === keyPath
  ) {
    failConfiguration();
  }

  return {
    baseUrl: baseUrl.origin,
    bindHost,
    port,
    certPath,
    keyPath
  };
}
