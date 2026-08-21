import {
  openAgentEventContentStream,
  type AgentTextPurpose
} from "@ai-worklog/server";
import { NextRequest } from "next/server";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PURPOSES = new Set<AgentTextPurpose>([
  "RENDERED_CONTENT",
  "RAW_PAYLOAD",
  "TOOL_ARGUMENTS",
  "TOOL_RESULT",
  "SEARCH_TEXT"
]);

function eventId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) throw new Error("Invalid event id");
  return value;
}

function purpose(value: string | null): AgentTextPurpose {
  const candidate = value ?? "RENDERED_CONTENT";
  if (!PURPOSES.has(candidate as AgentTextPurpose)) {
    throw new Error("Invalid event content purpose");
  }
  return candidate as AgentTextPurpose;
}

function notFound(): Error & { status: number; code: string } {
  return Object.assign(new Error("事件正文不存在"), {
    status: 404,
    code: "AGENT_EVENT_CONTENT_NOT_FOUND"
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const id = requestId();
  try {
    const { pool, accountId } = serverContext();
    const params = await context.params;
    const content = await openAgentEventContentStream({
      pool,
      accountId,
      eventId: eventId(params.id),
      purpose: purpose(request.nextUrl.searchParams.get("purpose"))
    });
    if (!content) throw notFound();

    const contentType = content.format === "JSON"
      ? "application/json; charset=utf-8"
      : content.format === "MARKDOWN"
        ? "text/markdown; charset=utf-8"
        : "text/plain; charset=utf-8";
    return new Response(content.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Length": String(content.byteLength),
        "Content-Type": contentType,
        "X-Content-SHA256": content.contentSha256,
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return apiError(error, id);
  }
}
