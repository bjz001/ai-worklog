import type { NextConfig } from "next";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

for (const candidate of [
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), "../../.env.local")
]) {
  try {
    loadEnvFile(candidate);
    break;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      continue;
    }
    throw error;
  }
}

const developmentScriptPolicy =
  process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["mysql2"],
  transpilePackages: [
    "@ai-worklog/contracts",
    "@ai-worklog/core",
    "@ai-worklog/db",
    "@ai-worklog/insights",
    "@ai-worklog/server",
    "@ai-worklog/sync"
  ],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              `default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline'${developmentScriptPolicy}; style-src 'self' 'unsafe-inline'`
          },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()"
          }
        ]
      }
    ];
  }
};

export default nextConfig;
