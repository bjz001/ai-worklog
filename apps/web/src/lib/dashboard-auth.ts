export interface DashboardAuthConfig {
  username: string;
  password: string;
}

function isPrivateLanHttpBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password) return false;
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
      return true;
    }
    const octets = url.hostname.split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return false;
    }
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  } catch {
    return false;
  }
}

export function dashboardAuthConfig(
  environment: Record<string, string | undefined>
): DashboardAuthConfig {
  const username = environment.DASHBOARD_USERNAME?.trim() ?? "";
  const password = environment.DASHBOARD_PASSWORD ?? "";
  const weakPasswordAllowed =
    environment.DASHBOARD_ALLOW_WEAK_PASSWORD === "true" &&
    isPrivateLanHttpBaseUrl(environment.APP_BASE_URL);
  const passwordLengthValid =
    password.length >= 16 || (weakPasswordAllowed && password.length >= 5);
  if (
    !/^[A-Za-z0-9._-]{1,64}$/.test(username) ||
    !passwordLengthValid ||
    password.length > 256 ||
    !/^[\x20-\x7e]+$/.test(password)
  ) {
    throw new Error("Invalid DASHBOARD authentication configuration");
  }
  return { username, password };
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  );
}

export async function hasValidDashboardAuthorization(
  authorization: string | null,
  config: DashboardAuthConfig
): Promise<boolean> {
  const expected = `Basic ${btoa(`${config.username}:${config.password}`)}`;
  const [actualDigest, expectedDigest] = await Promise.all([
    digest(authorization ?? ""),
    digest(expected)
  ]);
  let difference = actualDigest.length ^ expectedDigest.length;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= (actualDigest[index] ?? 0) ^ (expectedDigest[index] ?? 0);
  }
  return difference === 0;
}
