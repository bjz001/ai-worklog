import { isIP } from "node:net";

const CONFIGURATION_ERROR = "Invalid LAN HTTP configuration";

function isPrivateIpv4(host) {
  if (isIP(host) !== 4) return false;
  const [first, second] = host.split(".").map(Number);
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function lanHttpOrigin(host, portValue) {
  if (
    typeof host !== "string" ||
    typeof portValue !== "string" ||
    !isPrivateIpv4(host) ||
    !/^[1-9][0-9]{3,4}$/.test(portValue)
  ) {
    throw new Error(CONFIGURATION_ERROR);
  }
  const port = Number(portValue);
  if (port < 1024 || port > 65535) throw new Error(CONFIGURATION_ERROR);
  return `http://${host}:${port}`;
}

export function updateAppBaseUrl(source, origin) {
  if (
    typeof source !== "string" ||
    typeof origin !== "string" ||
    /[\0\r\n]/.test(origin)
  ) {
    throw new Error("Invalid environment file");
  }
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const indexes = lines.flatMap((line, index) =>
    /^APP_BASE_URL=/.test(line) ? [index] : []
  );
  if (indexes.length > 1) throw new Error("Invalid environment file");
  if (indexes.length === 1) {
    lines[indexes[0]] = `APP_BASE_URL=${origin}`;
  } else {
    if (lines.at(-1) === "") lines.pop();
    lines.push(`APP_BASE_URL=${origin}`, "");
  }
  return lines.join("\n");
}
