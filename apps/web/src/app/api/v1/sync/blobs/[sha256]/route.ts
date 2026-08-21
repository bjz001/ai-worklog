import {
  BlobInitializeResponseSchema,
  BlobManifestRequestSchema,
  MAX_BLOB_CHUNK_BYTES
} from "@ai-worklog/contracts";
import { NextRequest, NextResponse } from "next/server";
import {
  BlobRouteBoundaryError,
  authenticatedBlobContext,
  readSmallJson
} from "../../../../../../lib/device-blob-route";
import { apiError, requestId } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ sha256: string }> }
) {
  const id = requestId();
  try {
    const { sha256 } = await context.params;
    const { identity, service } = await authenticatedBlobContext(request);
    const parsed = BlobManifestRequestSchema.safeParse(await readSmallJson(request));
    if (!parsed.success) {
      throw new BlobRouteBoundaryError("INVALID_BLOB_MANIFEST", 422, "Blob 清单格式无效");
    }
    const result = await service.initialize(identity.accountId, sha256, parsed.data);
    const response = BlobInitializeResponseSchema.parse({
      data: {
        sha256,
        status: result.status,
        chunkSize: MAX_BLOB_CHUNK_BYTES,
        chunkCount: result.chunkCount,
        receivedChunks: result.receivedChunks
      }
    });
    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    return apiError(error, id);
  }
}
