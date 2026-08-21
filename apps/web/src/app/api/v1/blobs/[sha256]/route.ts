import {
  blobRootFromEnvironment,
  getBlobDownload
} from "@ai-worklog/server";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextRequest } from "next/server";
import { apiError, requestId, serverContext } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function digest(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid Blob digest");
  return value;
}

function encodedFilename(value: string | null, sha256: string): string {
  const filename = (value?.trim() || sha256).replace(/[\r\n]/gu, "_");
  return encodeURIComponent(filename).replace(/[!'()*]/gu, (character) =>
    `%${character.codePointAt(0)?.toString(16).toUpperCase()}`
  );
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ sha256: string }> }
) {
  const id = requestId();
  try {
    const { pool, accountId } = serverContext();
    const params = await context.params;
    const sha256 = digest(params.sha256);
    const blob = await getBlobDownload({
      pool,
      accountId,
      sha256,
      root: blobRootFromEnvironment()
    });
    const nodeStream = createReadStream(blob.path);
    const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodedFilename(blob.filename, sha256)}`,
        "Content-Length": String(blob.byteLength),
        "Content-Type": blob.mediaType || "application/octet-stream",
        "X-Content-SHA256": blob.sha256,
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return apiError(error, id);
  }
}
