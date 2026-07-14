import { NextRequest, NextResponse } from "next/server";
import {
  dashboardAuthConfig,
  hasValidDashboardAuthorization
} from "@/lib/dashboard-auth";

function unauthorized(request: NextRequest, unavailable = false): NextResponse {
  const status = unavailable ? 503 : 401;
  const message = unavailable
    ? "Dashboard authentication is not configured"
    : "Dashboard authentication is required";
  const response = request.nextUrl.pathname.startsWith("/api/")
    ? NextResponse.json(
        {
          error: {
            code: unavailable ? "AUTH_NOT_CONFIGURED" : "UNAUTHORIZED",
            message,
            retryable: false,
            requestId: crypto.randomUUID()
          }
        },
        { status }
      )
    : new NextResponse(message, { status });
  if (!unavailable) {
    response.headers.set(
      "WWW-Authenticate",
      'Basic realm="AI Worklog", charset="UTF-8"'
    );
  }
  return response;
}

export async function middleware(request: NextRequest) {
  const localDevelopment =
    process.env.NODE_ENV === "development" &&
    ["127.0.0.1", "localhost", "::1"].includes(request.nextUrl.hostname);
  if (localDevelopment) return NextResponse.next();

  let config;
  try {
    config = dashboardAuthConfig(process.env);
  } catch {
    return unauthorized(request, true);
  }
  if (
    !(await hasValidDashboardAuthorization(
      request.headers.get("authorization"),
      config
    ))
  ) {
    return unauthorized(request);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/v1/sync/batches).*)"
  ]
};
