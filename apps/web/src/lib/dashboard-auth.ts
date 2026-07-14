export interface DashboardAuthConfig {
  username: string;
  password: string;
}

export function dashboardAuthConfig(
  environment: Record<string, string | undefined>
): DashboardAuthConfig {
  const username = environment.DASHBOARD_USERNAME?.trim() ?? "";
  const password = environment.DASHBOARD_PASSWORD ?? "";
  if (
    !/^[A-Za-z0-9._-]{1,64}$/.test(username) ||
    password.length < 16 ||
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
