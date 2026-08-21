import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "mysql2/promise";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_BLOB_CHUNK_BYTES } from "@ai-worklog/contracts";
import {
  BlobService,
  MysqlBlobRepository,
  validatedBlobObjectPath,
  type BlobChunkState,
  type BlobObjectState,
  type BlobRepository
} from "./blob-service";

class MemoryBlobRepository implements BlobRepository {
  readonly objects = new Map<string, BlobObjectState>();
  readonly chunks = new Map<string, BlobChunkState>();

  private objectKey(accountId: string, sha256: string) {
    return `${accountId}:${sha256}`;
  }

  async upsertObject(object: BlobObjectState): Promise<BlobObjectState> {
    const key = this.objectKey(object.accountId, object.sha256);
    const existing = this.objects.get(key);
    if (existing) return existing;
    this.objects.set(key, object);
    return object;
  }

  async getObject(accountId: string, sha256: string) {
    return this.objects.get(this.objectKey(accountId, sha256)) ?? null;
  }

  async putChunk(chunk: BlobChunkState): Promise<BlobChunkState> {
    const key = `${chunk.blobObjectId}:${chunk.index}`;
    const existing = this.chunks.get(key);
    if (existing) return existing;
    this.chunks.set(key, chunk);
    return chunk;
  }

  async listChunks(blobObjectId: string): Promise<BlobChunkState[]> {
    return [...this.chunks.values()]
      .filter((chunk) => chunk.blobObjectId === blobObjectId)
      .sort((left, right) => left.index - right.index);
  }

  async markComplete(blobObjectId: string): Promise<void> {
    for (const [key, object] of this.objects) {
      if (object.id === blobObjectId) {
        this.objects.set(key, { ...object, status: "COMPLETE" });
      }
    }
  }

  async markFailed(blobObjectId: string, reason: string): Promise<void> {
    for (const [key, object] of this.objects) {
      if (object.id === blobObjectId) {
        this.objects.set(key, { ...object, status: "FAILED", failureReason: reason });
      }
    }
  }

  async linkReferences(): Promise<void> {}
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ai-worklog-blobs-"));
  temporaryRoots.push(root);
  const repository = new MemoryBlobRepository();
  const service = new BlobService({ root, repository });
  return { root, repository, service };
}

describe("BlobService", () => {
  it("uploads out of order, resumes, deduplicates, and completes losslessly", async () => {
    const { repository, service } = await fixture();
    const content = Buffer.concat([
      Buffer.alloc(MAX_BLOB_CHUNK_BYTES, 0x61),
      Buffer.from("完整尾块\nFAKE_SECRET_CANARY=preserve")
    ]);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const manifest = {
      byteLength: content.byteLength,
      chunkSize: MAX_BLOB_CHUNK_BYTES,
      mediaType: "application/octet-stream",
      filename: "trajectory.bin"
    } as const;

    const initialized = await service.initialize("account-a", sha256, manifest);
    expect(initialized.receivedChunks).toEqual([]);

    await service.putChunk(
      "account-a",
      sha256,
      1,
      content.subarray(MAX_BLOB_CHUNK_BYTES)
    );
    await service.putChunk(
      "account-a",
      sha256,
      0,
      content.subarray(0, MAX_BLOB_CHUNK_BYTES)
    );
    const duplicate = await service.putChunk(
      "account-a",
      sha256,
      0,
      content.subarray(0, MAX_BLOB_CHUNK_BYTES)
    );
    expect(duplicate.wasDuplicate).toBe(true);

    const resumed = await service.initialize("account-a", sha256, manifest);
    expect(resumed.receivedChunks).toEqual([0, 1]);
    const completed = await service.complete("account-a", sha256, {
      byteLength: content.byteLength,
      chunkCount: 2,
      sha256
    });

    expect(completed.status).toBe("COMPLETE");
    expect(await readFile(completed.path)).toEqual(content);
    expect((await stat(completed.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(completed.path, ".."))).mode & 0o777).toBe(0o700);
    expect((await repository.getObject("account-a", sha256))?.status).toBe(
      "COMPLETE"
    );
  });

  it("rejects a conflicting duplicate chunk without overwriting it", async () => {
    const { service } = await fixture();
    const original = Buffer.alloc(MAX_BLOB_CHUNK_BYTES, 0x61);
    const announcedSha = createHash("sha256").update(original).digest("hex");
    await service.initialize("account-a", announcedSha, {
      byteLength: original.byteLength,
      chunkSize: MAX_BLOB_CHUNK_BYTES,
      mediaType: "application/octet-stream"
    });
    await service.putChunk("account-a", announcedSha, 0, original);

    await expect(service.putChunk(
      "account-a",
      announcedSha,
      0,
      Buffer.alloc(MAX_BLOB_CHUNK_BYTES, 0x62)
    )).rejects.toMatchObject({
      code: "BLOB_CHUNK_CONFLICT",
      status: 409
    });
  });

  it("rejects completion when the assembled SHA-256 differs", async () => {
    const { service } = await fixture();
    const bytes = Buffer.from("actual bytes");
    const announcedSha = createHash("sha256").update("different bytes").digest("hex");
    await service.initialize("account-a", announcedSha, {
      byteLength: bytes.byteLength,
      chunkSize: MAX_BLOB_CHUNK_BYTES,
      mediaType: "text/plain"
    });
    await service.putChunk("account-a", announcedSha, 0, bytes);

    await expect(service.complete("account-a", announcedSha, {
      byteLength: bytes.byteLength,
      chunkCount: 1,
      sha256: announcedSha
    })).rejects.toMatchObject({
      code: "BLOB_DIGEST_MISMATCH",
      status: 422
    });
  });

  it("removes an incomplete assembled file after a source chunk read fails", async () => {
    const { root, repository, service } = await fixture();
    const bytes = Buffer.from("transient source chunk");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await service.initialize("account-a", sha256, {
      byteLength: bytes.byteLength,
      chunkSize: MAX_BLOB_CHUNK_BYTES,
      mediaType: "text/plain"
    });
    await service.putChunk("account-a", sha256, 0, bytes);
    const object = await repository.getObject("account-a", sha256);
    const [chunk] = object ? await repository.listChunks(object.id) : [];
    expect(chunk).toBeDefined();
    await unlink(chunk?.storagePath ?? "");

    await expect(service.complete("account-a", sha256, {
      byteLength: bytes.byteLength,
      chunkCount: 1,
      sha256
    })).rejects.toMatchObject({ code: "ENOENT" });

    const objectDirectory = join(root, "account-a", sha256.slice(0, 2));
    expect((await readdir(objectDirectory)).filter((name) => name.endsWith(".tmp")))
      .toEqual([]);
  });
});

describe("MysqlBlobRepository", () => {
  it("updates only account-scoped references and recomputes event/run completeness", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const executor = {
      async execute(sql: unknown, values?: unknown[]) {
        calls.push({ sql: String(sql), values: values ?? [] });
        return [{ affectedRows: 1 }, []];
      }
    } as unknown as Pick<Pool, "execute">;
    const repository = new MysqlBlobRepository(executor);

    await repository.linkReferences(
      "account-a",
      "a".repeat(64),
      "blob-a",
      "CAPTURED"
    );

    expect(calls).toHaveLength(4);
    expect(calls[0]?.sql).toContain("WHERE account_id = ? AND blob_sha256 = ?");
    expect(calls[1]?.sql).toContain("UPDATE collected_events ce");
    expect(calls[2]?.sql).toContain("UPDATE sessions s");
    expect(calls[3]?.sql).toContain("UPDATE agent_capture_completeness c");
    expect(calls.every((call) => call.values.includes("account-a"))).toBe(true);
    expect(calls[1]?.sql).toContain("SUM(br.status = 'CAPTURED') = COUNT(*)");
  });
});

describe("validatedBlobObjectPath", () => {
  it("confines downloads to the account-scoped content-addressed path", async () => {
    const { root } = await fixture();
    const sha256 = "a".repeat(64);
    const expected = join(root, "account-a", "aa", sha256);
    expect(validatedBlobObjectPath(root, "account-a", sha256, expected)).toBe(
      expected
    );
    expect(() => validatedBlobObjectPath(
      root,
      "account-a",
      sha256,
      "/etc/passwd"
    )).toThrow("storage path");
  });
});
