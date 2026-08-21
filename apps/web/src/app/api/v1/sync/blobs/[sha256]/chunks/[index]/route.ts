import { BlobChunkResponseSchema } from "@ai-worklog/contracts";
import { NextRequest, NextResponse } from "next/server";
import {
  authenticatedBlobContext,
  parseChunkIndex,
  readBlobChunk
} from "../../../../../../../../lib/device-blob-route";
import { apiError, requestId } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ sha256: string; index: string }> }
) {
  const id = requestId();
  try {
    const { sha256, index: rawIndex } = await context.params;
    const { identity, service } = await authenticatedBlobContext(request);
    const index = parseChunkIndex(rawIndex);
    const bytes = await readBlobChunk(request);
    const result = await service.putChunk(identity.accountId, sha256, index, bytes);
    const response = BlobChunkResponseSchema.parse({
      data: {
        sha256,
        index: result.index,
        chunkSha256: result.sha256,
        wasDuplicate: result.wasDuplicate
      }
    });
    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    return apiError(error, id);
  }
}
