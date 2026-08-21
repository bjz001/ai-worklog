import {
  BlobCompleteRequestSchema,
  BlobCompleteResponseSchema
} from "@ai-worklog/contracts";
import { NextRequest, NextResponse } from "next/server";
import {
  BlobRouteBoundaryError,
  authenticatedBlobContext,
  readSmallJson
} from "../../../../../../../lib/device-blob-route";
import { apiError, requestId } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sha256: string }> }
) {
  const id = requestId();
  try {
    const { sha256 } = await context.params;
    const { identity, service } = await authenticatedBlobContext(request);
    const parsed = BlobCompleteRequestSchema.safeParse(await readSmallJson(request));
    if (!parsed.success) {
      throw new BlobRouteBoundaryError("INVALID_BLOB_COMPLETION", 422, "Blob 完成清单格式无效");
    }
    const result = await service.complete(identity.accountId, sha256, parsed.data);
    const response = BlobCompleteResponseSchema.parse({
      data: {
        sha256: result.sha256,
        status: result.status,
        byteLength: result.byteLength
      }
    });
    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    return apiError(error, id);
  }
}
