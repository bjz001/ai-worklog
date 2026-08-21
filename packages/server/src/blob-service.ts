import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import type {
  BlobCompleteRequest,
  BlobManifestRequest
} from "@ai-worklog/contracts";
import { MAX_BLOB_CHUNK_BYTES } from "@ai-worklog/contracts";
import { sha256Hex } from "@ai-worklog/core";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export class BlobServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "BlobServiceError";
  }
}

export interface BlobObjectState {
  id: string;
  accountId: string;
  sha256: string;
  byteLength: number;
  chunkSize: number;
  chunkCount: number;
  mediaType: string;
  filename: string | null;
  storagePath: string;
  status: "PENDING" | "UPLOADING" | "COMPLETE" | "FAILED" | "STORAGE_FULL";
  failureReason?: string | null;
}

export interface BlobChunkState {
  blobObjectId: string;
  index: number;
  byteLength: number;
  sha256: string;
  storagePath: string;
}

export interface BlobRepository {
  upsertObject(object: BlobObjectState): Promise<BlobObjectState>;
  getObject(accountId: string, sha256: string): Promise<BlobObjectState | null>;
  putChunk(chunk: BlobChunkState): Promise<BlobChunkState>;
  listChunks(blobObjectId: string): Promise<BlobChunkState[]>;
  markComplete(blobObjectId: string): Promise<void>;
  markFailed(blobObjectId: string, reason: string): Promise<void>;
  linkReferences(
    accountId: string,
    sha256: string,
    blobObjectId: string,
    status: "PENDING" | "CAPTURED" | "STORAGE_FULL"
  ): Promise<void>;
}

function stableDatabaseId(prefix: string, ...parts: string[]): string {
  const digest = sha256Hex([prefix, ...parts].join("\u001f"));
  return `${prefix}_${digest.slice(0, 64 - prefix.length - 1)}`;
}

function assertAccountId(accountId: string): void {
  if (!/^[A-Za-z0-9_-]{3,64}$/u.test(accountId)) {
    throw new BlobServiceError("INVALID_ACCOUNT_ID", 400, "账户标识无效");
  }
}

function assertSha256(sha256: string): void {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new BlobServiceError("INVALID_BLOB_SHA256", 400, "Blob SHA-256 无效");
  }
}

export function validatedBlobObjectPath(
  root: string,
  accountId: string,
  sha256: string,
  storedPath: string
): string {
  assertAccountId(accountId);
  assertSha256(sha256);
  const expected = resolve(root, accountId, sha256.slice(0, 2), sha256);
  if (resolve(storedPath) !== expected) {
    throw new BlobServiceError(
      "BLOB_STORE_PATH_INVALID",
      500,
      "Invalid Blob storage path"
    );
  }
  return expected;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

async function sha256File(path: string): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    byteLength += bytes.byteLength;
  }
  return { sha256: hash.digest("hex"), byteLength };
}

function expectedChunkLength(object: BlobObjectState, index: number): number {
  if (object.chunkCount === 0 || index < 0 || index >= object.chunkCount) {
    throw new BlobServiceError("INVALID_BLOB_CHUNK", 422, "Blob 分块索引无效");
  }
  if (index < object.chunkCount - 1) return object.chunkSize;
  return object.byteLength - object.chunkSize * (object.chunkCount - 1);
}

export interface BlobInitializeResult {
  status: BlobObjectState["status"];
  chunkCount: number;
  receivedChunks: number[];
}

export interface BlobChunkResult {
  index: number;
  sha256: string;
  wasDuplicate: boolean;
}

export interface BlobCompleteResult {
  status: "COMPLETE";
  sha256: string;
  byteLength: number;
  path: string;
}

export class BlobService {
  readonly root: string;
  private readonly repository: BlobRepository;

  constructor(options: { root: string; repository: BlobRepository }) {
    if (!isAbsolute(options.root)) {
      throw new BlobServiceError(
        "INVALID_BLOB_ROOT",
        500,
        "AI_WORKLOG_BLOB_ROOT 必须是绝对路径"
      );
    }
    const root = resolve(options.root);
    if (root === parse(root).root) {
      throw new BlobServiceError(
        "INVALID_BLOB_ROOT",
        500,
        "AI_WORKLOG_BLOB_ROOT 不能是文件系统根目录"
      );
    }
    this.root = root;
    this.repository = options.repository;
  }

  private paths(accountId: string, sha256: string) {
    const accountRoot = join(this.root, accountId);
    const objectDirectory = join(accountRoot, sha256.slice(0, 2));
    const objectPath = join(objectDirectory, sha256);
    const chunkDirectory = join(accountRoot, ".chunks", sha256);
    return { accountRoot, objectDirectory, objectPath, chunkDirectory };
  }

  private async ensureDirectories(accountId: string, sha256: string) {
    const paths = this.paths(accountId, sha256);
    for (const directory of [
      this.root,
      paths.accountRoot,
      paths.objectDirectory,
      dirname(paths.chunkDirectory),
      paths.chunkDirectory
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    return paths;
  }

  async initialize(
    accountId: string,
    sha256: string,
    manifest: BlobManifestRequest
  ): Promise<BlobInitializeResult> {
    assertAccountId(accountId);
    assertSha256(sha256);
    if (manifest.chunkSize !== MAX_BLOB_CHUNK_BYTES) {
      throw new BlobServiceError("INVALID_CHUNK_SIZE", 422, "Blob 分块必须为 1 MiB");
    }
    const chunkCount = Math.ceil(manifest.byteLength / manifest.chunkSize);
    const paths = await this.ensureDirectories(accountId, sha256);
    const proposed: BlobObjectState = {
      id: stableDatabaseId("blob", accountId, sha256),
      accountId,
      sha256,
      byteLength: manifest.byteLength,
      chunkSize: manifest.chunkSize,
      chunkCount,
      mediaType: manifest.mediaType,
      filename: manifest.filename ?? null,
      storagePath: paths.objectPath,
      status: "PENDING",
      failureReason: null
    };
    const object = await this.repository.upsertObject(proposed);
    if (
      object.accountId !== accountId ||
      object.sha256 !== sha256 ||
      object.byteLength !== manifest.byteLength ||
      object.chunkSize !== manifest.chunkSize ||
      object.chunkCount !== chunkCount
    ) {
      throw new BlobServiceError(
        "BLOB_MANIFEST_CONFLICT",
        409,
        "同一 Blob 摘要已使用不同清单"
      );
    }
    validatedBlobObjectPath(this.root, accountId, sha256, object.storagePath);
    await this.repository.linkReferences(
      accountId,
      sha256,
      object.id,
      object.status === "COMPLETE"
        ? "CAPTURED"
        : object.status === "STORAGE_FULL"
          ? "STORAGE_FULL"
          : "PENDING"
    );
    const chunks = object.status === "COMPLETE"
      ? []
      : await this.repository.listChunks(object.id);
    return {
      status: object.status,
      chunkCount: object.chunkCount,
      receivedChunks: chunks.map((chunk) => chunk.index)
    };
  }

  async putChunk(
    accountId: string,
    sha256: string,
    index: number,
    bytes: Uint8Array
  ): Promise<BlobChunkResult> {
    assertAccountId(accountId);
    assertSha256(sha256);
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new BlobServiceError("INVALID_BLOB_CHUNK", 422, "Blob 分块索引无效");
    }
    const object = await this.repository.getObject(accountId, sha256);
    if (!object) {
      throw new BlobServiceError("BLOB_NOT_INITIALIZED", 404, "Blob 尚未初始化");
    }
    const expectedLength = expectedChunkLength(object, index);
    if (bytes.byteLength !== expectedLength || bytes.byteLength > MAX_BLOB_CHUNK_BYTES) {
      throw new BlobServiceError("INVALID_BLOB_CHUNK_SIZE", 422, "Blob 分块长度不匹配");
    }
    const paths = await this.ensureDirectories(accountId, sha256);
    validatedBlobObjectPath(this.root, accountId, sha256, object.storagePath);
    const chunkPath = join(paths.chunkDirectory, `${index}.part`);
    const chunkSha256 = sha256Hex(bytes);
    let wasDuplicate = false;
    try {
      await writeFile(chunkPath, bytes, { flag: "wx", mode: 0o600 });
      await chmod(chunkPath, 0o600);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        if (isNodeError(error, "ENOSPC")) {
          await this.repository.markFailed(object.id, "STORAGE_FULL");
          await this.repository.linkReferences(
            accountId,
            sha256,
            object.id,
            "STORAGE_FULL"
          );
          throw new BlobServiceError("BLOB_STORAGE_FULL", 507, "Blob 存储空间不足");
        }
        throw error;
      }
      const existing = await readFile(chunkPath);
      if (existing.byteLength !== bytes.byteLength || sha256Hex(existing) !== chunkSha256) {
        throw new BlobServiceError(
          "BLOB_CHUNK_CONFLICT",
          409,
          "同一分块索引已包含不同内容"
        );
      }
      wasDuplicate = true;
    }
    const stored = await this.repository.putChunk({
      blobObjectId: object.id,
      index,
      byteLength: bytes.byteLength,
      sha256: chunkSha256,
      storagePath: chunkPath
    });
    if (
      stored.byteLength !== bytes.byteLength ||
      stored.sha256 !== chunkSha256 ||
      resolve(stored.storagePath) !== chunkPath
    ) {
      throw new BlobServiceError(
        "BLOB_CHUNK_CONFLICT",
        409,
        "同一分块索引已包含不同内容"
      );
    }
    return { index, sha256: chunkSha256, wasDuplicate };
  }

  async complete(
    accountId: string,
    sha256: string,
    request: BlobCompleteRequest
  ): Promise<BlobCompleteResult> {
    assertAccountId(accountId);
    assertSha256(sha256);
    if (request.sha256 !== sha256) {
      throw new BlobServiceError("BLOB_DIGEST_MISMATCH", 422, "Blob 摘要不匹配");
    }
    const object = await this.repository.getObject(accountId, sha256);
    if (!object) {
      throw new BlobServiceError("BLOB_NOT_INITIALIZED", 404, "Blob 尚未初始化");
    }
    if (
      request.byteLength !== object.byteLength ||
      request.chunkCount !== object.chunkCount
    ) {
      throw new BlobServiceError("BLOB_MANIFEST_CONFLICT", 409, "Blob 完成清单不匹配");
    }
    const paths = await this.ensureDirectories(accountId, sha256);
    if (object.status === "COMPLETE") {
      const existing = await sha256File(paths.objectPath);
      if (existing.sha256 !== sha256 || existing.byteLength !== object.byteLength) {
        throw new BlobServiceError("BLOB_STORE_CORRUPT", 500, "已完成 Blob 校验失败");
      }
      return {
        status: "COMPLETE",
        sha256,
        byteLength: object.byteLength,
        path: paths.objectPath
      };
    }
    const chunks = await this.repository.listChunks(object.id);
    if (
      chunks.length !== object.chunkCount ||
      chunks.some((chunk, index) =>
        chunk.index !== index ||
        chunk.byteLength !== expectedChunkLength(object, index)
      )
    ) {
      throw new BlobServiceError("BLOB_CHUNKS_INCOMPLETE", 409, "Blob 分块尚未齐全");
    }

    const temporaryPath = `${paths.objectPath}.${randomUUID()}.tmp`;
    const hash = createHash("sha256");
    let totalBytes = 0;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      let position = 0;
      for (const chunk of chunks) {
        for await (const value of createReadStream(chunk.storagePath)) {
          const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
          hash.update(bytes);
          totalBytes += bytes.byteLength;
          await handle.write(bytes, 0, bytes.byteLength, position);
          position += bytes.byteLength;
        }
      }
      await handle.sync();
      await handle.close();
      handle = null;
      const actualSha256 = hash.digest("hex");
      if (actualSha256 !== sha256 || totalBytes !== object.byteLength) {
        await unlink(temporaryPath);
        await this.repository.markFailed(object.id, "DIGEST_MISMATCH");
        throw new BlobServiceError("BLOB_DIGEST_MISMATCH", 422, "Blob 摘要不匹配");
      }
      await chmod(temporaryPath, 0o600);
      try {
        await rename(temporaryPath, paths.objectPath);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const existing = await sha256File(paths.objectPath);
        if (existing.sha256 !== sha256 || existing.byteLength !== object.byteLength) {
          throw new BlobServiceError("BLOB_STORE_CORRUPT", 500, "Blob 目标文件冲突");
        }
        await unlink(temporaryPath);
      }
      await chmod(paths.objectPath, 0o600);
      await this.repository.markComplete(object.id);
      await this.repository.linkReferences(
        accountId,
        sha256,
        object.id,
        "CAPTURED"
      );
      for (const chunk of chunks) {
        try {
          await unlink(chunk.storagePath);
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
      }
      try {
        await rmdir(paths.chunkDirectory);
      } catch (error) {
        if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) {
          throw error;
        }
      }
      return {
        status: "COMPLETE",
        sha256,
        byteLength: object.byteLength,
        path: paths.objectPath
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch((cleanupError: unknown) => {
        if (!isNodeError(cleanupError, "ENOENT")) throw cleanupError;
      });
      if (isNodeError(error, "ENOSPC")) {
        await this.repository.markFailed(object.id, "STORAGE_FULL");
        await this.repository.linkReferences(
          accountId,
          sha256,
          object.id,
          "STORAGE_FULL"
        );
        throw new BlobServiceError("BLOB_STORAGE_FULL", 507, "Blob 存储空间不足");
      }
      throw error;
    }
  }
}

interface BlobObjectRow extends RowDataPacket {
  id: string;
  account_id: string;
  sha256: string;
  byte_length: number | string;
  chunk_size: number;
  chunk_count: number | string;
  media_type: string;
  filename: string | null;
  storage_path: string;
  status: BlobObjectState["status"];
  failure_reason: string | null;
}

interface BlobChunkRow extends RowDataPacket {
  blob_object_id: string;
  chunk_index: number | string;
  byte_length: number;
  sha256: string;
  storage_path: string;
}

function objectFromRow(row: BlobObjectRow): BlobObjectState {
  return {
    id: row.id,
    accountId: row.account_id,
    sha256: row.sha256,
    byteLength: Number(row.byte_length),
    chunkSize: Number(row.chunk_size),
    chunkCount: Number(row.chunk_count),
    mediaType: row.media_type,
    filename: row.filename,
    storagePath: row.storage_path,
    status: row.status,
    failureReason: row.failure_reason
  };
}

export class MysqlBlobRepository implements BlobRepository {
  constructor(private readonly pool: Pick<Pool, "execute">) {}

  async upsertObject(object: BlobObjectState): Promise<BlobObjectState> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO blob_objects
         (id, account_id, sha256, byte_length, chunk_size, chunk_count,
          media_type, filename, storage_path, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        object.id,
        object.accountId,
        object.sha256,
        object.byteLength,
        object.chunkSize,
        object.chunkCount,
        object.mediaType,
        object.filename,
        object.storagePath,
        object.status
      ]
    );
    const stored = await this.getObject(object.accountId, object.sha256);
    if (!stored) throw new Error("BLOB_OBJECT_NOT_FOUND_AFTER_INSERT");
    return stored;
  }

  async getObject(accountId: string, sha256: string): Promise<BlobObjectState | null> {
    const [rows] = await this.pool.execute<BlobObjectRow[]>(
      `SELECT id, account_id, sha256, byte_length, chunk_size, chunk_count,
              media_type, filename, storage_path, status, failure_reason
         FROM blob_objects
        WHERE account_id = ? AND sha256 = ?
        LIMIT 1`,
      [accountId, sha256]
    );
    return rows[0] ? objectFromRow(rows[0]) : null;
  }

  async putChunk(chunk: BlobChunkState): Promise<BlobChunkState> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO blob_chunks
         (blob_object_id, chunk_index, byte_length, sha256, storage_path)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE blob_object_id = blob_object_id`,
      [
        chunk.blobObjectId,
        chunk.index,
        chunk.byteLength,
        chunk.sha256,
        chunk.storagePath
      ]
    );
    const [rows] = await this.pool.execute<BlobChunkRow[]>(
      `SELECT blob_object_id, chunk_index, byte_length, sha256, storage_path
         FROM blob_chunks
        WHERE blob_object_id = ? AND chunk_index = ?
        LIMIT 1`,
      [chunk.blobObjectId, chunk.index]
    );
    const row = rows[0];
    if (!row) throw new Error("BLOB_CHUNK_NOT_FOUND_AFTER_INSERT");
    return {
      blobObjectId: row.blob_object_id,
      index: Number(row.chunk_index),
      byteLength: Number(row.byte_length),
      sha256: row.sha256,
      storagePath: row.storage_path
    };
  }

  async listChunks(blobObjectId: string): Promise<BlobChunkState[]> {
    const [rows] = await this.pool.execute<BlobChunkRow[]>(
      `SELECT blob_object_id, chunk_index, byte_length, sha256, storage_path
         FROM blob_chunks
        WHERE blob_object_id = ?
        ORDER BY chunk_index ASC`,
      [blobObjectId]
    );
    return rows.map((row) => ({
      blobObjectId: row.blob_object_id,
      index: Number(row.chunk_index),
      byteLength: Number(row.byte_length),
      sha256: row.sha256,
      storagePath: row.storage_path
    }));
  }

  async markComplete(blobObjectId: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE blob_objects
          SET status = 'COMPLETE', failure_reason = NULL,
              completed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
        WHERE id = ?`,
      [blobObjectId]
    );
  }

  async markFailed(blobObjectId: string, reason: string): Promise<void> {
    const status = reason === "STORAGE_FULL" ? "STORAGE_FULL" : "FAILED";
    await this.pool.execute<ResultSetHeader>(
      `UPDATE blob_objects
          SET status = ?, failure_reason = ?, updated_at = UTC_TIMESTAMP(6)
        WHERE id = ?`,
      [status, reason, blobObjectId]
    );
  }

  async linkReferences(
    accountId: string,
    sha256: string,
    blobObjectId: string,
    status: "PENDING" | "CAPTURED" | "STORAGE_FULL"
  ): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE event_blob_references
          SET blob_object_id = ?, status = ?,
              failure_reason = IF(? = 'STORAGE_FULL', 'Blob storage full', NULL),
              updated_at = UTC_TIMESTAMP(6)
        WHERE account_id = ? AND blob_sha256 = ?`,
      [blobObjectId, status, status, accountId, sha256]
    );
    const aggregateStatus = `CASE
      WHEN SUM(br.status = 'PENDING') > 0 THEN 'PENDING'
      WHEN SUM(br.status = 'STORAGE_FULL') > 0 THEN 'STORAGE_FULL'
      WHEN SUM(br.status = 'READ_ERROR') > 0 THEN 'READ_ERROR'
      WHEN SUM(br.status = 'MISSING') > 0 THEN 'MISSING'
      WHEN SUM(br.status = 'NOT_REGULAR') > 0 THEN 'NOT_REGULAR'
      WHEN COUNT(*) > 0 AND SUM(br.status = 'CAPTURED') = COUNT(*) THEN 'CAPTURED'
      ELSE 'NOT_APPLICABLE' END`;
    await this.pool.execute<ResultSetHeader>(
      `UPDATE collected_events ce
          SET attachment_status = (
            SELECT ${aggregateStatus}
              FROM event_blob_references br
             WHERE br.account_id = ce.account_id
               AND br.collected_event_id = ce.id
          )
        WHERE ce.account_id = ? AND ce.id IN (
          SELECT refs.collected_event_id
            FROM event_blob_references refs
           WHERE refs.account_id = ? AND refs.blob_sha256 = ?
             AND refs.collected_event_id IS NOT NULL
        )`,
      [accountId, accountId, sha256]
    );
    await this.pool.execute<ResultSetHeader>(
      `UPDATE sessions s
          SET attachment_status = (
            SELECT ${aggregateStatus}
              FROM event_blob_references br
             WHERE br.account_id = s.account_id AND br.session_id = s.id
          ), updated_at = UTC_TIMESTAMP(6)
        WHERE s.account_id = ? AND s.id IN (
          SELECT refs.session_id
            FROM event_blob_references refs
           WHERE refs.account_id = ? AND refs.blob_sha256 = ?
        )`,
      [accountId, accountId, sha256]
    );
    await this.pool.execute<ResultSetHeader>(
      `UPDATE agent_capture_completeness c
       JOIN sessions s ON s.id = c.session_id AND s.account_id = c.account_id
          SET c.attachment_status = s.attachment_status,
              c.pending_blob_count = (
                SELECT COUNT(*) FROM event_blob_references br
                 WHERE br.account_id = c.account_id
                   AND br.session_id = c.session_id
                   AND br.status = 'PENDING'
              ), c.updated_at = UTC_TIMESTAMP(6)
        WHERE c.account_id = ? AND c.session_id IN (
          SELECT refs.session_id
            FROM event_blob_references refs
           WHERE refs.account_id = ? AND refs.blob_sha256 = ?
        )`,
      [accountId, accountId, sha256]
    );
  }
}

export function blobRootFromEnvironment(
  environment: Record<string, string | undefined> = process.env
): string {
  const value = environment.AI_WORKLOG_BLOB_ROOT?.trim();
  if (!value || !isAbsolute(value)) {
    throw new BlobServiceError(
      "BLOB_ROOT_NOT_CONFIGURED",
      500,
      "AI_WORKLOG_BLOB_ROOT 未配置为绝对路径"
    );
  }
  return value;
}

export interface BlobDownload {
  path: string;
  byteLength: number;
  mediaType: string;
  filename: string | null;
  sha256: string;
}

export async function getBlobDownload(options: {
  pool: Pick<Pool, "execute">;
  accountId: string;
  sha256: string;
  root: string;
}): Promise<BlobDownload> {
  const repository = new MysqlBlobRepository(options.pool);
  const object = await repository.getObject(options.accountId, options.sha256);
  if (!object || object.status !== "COMPLETE") {
    throw new BlobServiceError("BLOB_NOT_FOUND", 404, "Blob 不存在或尚未完成");
  }
  const path = validatedBlobObjectPath(
    options.root,
    options.accountId,
    options.sha256,
    object.storagePath
  );
  let file;
  try {
    file = await stat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new BlobServiceError("BLOB_NOT_FOUND", 404, "Blob 文件不存在");
    }
    throw error;
  }
  if (!file.isFile() || file.size !== object.byteLength) {
    throw new BlobServiceError("BLOB_STORE_CORRUPT", 500, "Blob 文件状态无效");
  }
  return {
    path,
    byteLength: object.byteLength,
    mediaType: object.mediaType,
    filename: object.filename,
    sha256: object.sha256
  };
}
