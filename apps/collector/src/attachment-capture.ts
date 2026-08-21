import { createHash, randomBytes } from "node:crypto";
import { COPYFILE_EXCL } from "node:constants";
import {
  createReadStream,
  createWriteStream
} from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  realpath,
  stat,
  unlink
} from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AgentSyncRecordSchema, type AttachmentStatus } from "@ai-worklog/contracts";
import { buildAgentBlobReferenceId } from "@ai-worklog/core";
import type { AgentCapture } from "./agent-connector.js";
import type { Outbox } from "./outbox.js";

type CaptureFailureStatus = "MISSING" | "READ_ERROR" | "NOT_REGULAR" |
  "STORAGE_FULL";

export type CapturedFile = {
  status: "CAPTURED";
  requestedPath: string;
  realPath: string;
  localPath: string;
  filename: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
  capturedAt: string;
  sourceModifiedAt: string;
} | {
  status: CaptureFailureStatus;
  requestedPath: string;
  realPath: string | null;
  failureReason: string;
};

function nodeCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function mediaType(path: string): string {
  const types: Record<string, string> = {
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".log": "text/plain",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".zip": "application/zip"
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function failure(
  requestedPath: string,
  realPath: string | null,
  status: CaptureFailureStatus,
  reason: string
): CapturedFile {
  return {
    status,
    requestedPath,
    realPath,
    failureReason: reason.slice(0, 4_096)
  };
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

async function installCasObject(
  temporaryPath: string,
  localPath: string
): Promise<void> {
  try {
    await link(temporaryPath, localPath);
    return;
  } catch (error) {
    const code = nodeCode(error);
    if (code === "EEXIST") return;
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code ?? "")) throw error;
  }
  try {
    await copyFile(temporaryPath, localPath, COPYFILE_EXCL);
  } catch (error) {
    if (nodeCode(error) !== "EEXIST") throw error;
  }
}

export async function captureRequestedFile(options: {
  requestedPath: string;
  cwd: string;
  blobRoot: string;
}): Promise<CapturedFile> {
  const requestedPath = options.requestedPath;
  const resolved = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(options.cwd, requestedPath);
  let sourcePath: string;
  try {
    const requestedStat = await lstat(resolved);
    if (requestedStat.isSymbolicLink()) {
      sourcePath = await realpath(resolved);
    } else {
      sourcePath = resolved;
    }
  } catch (error) {
    const code = nodeCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return failure(requestedPath, null, "MISSING", "File did not exist at capture time");
    }
    return failure(requestedPath, null, "READ_ERROR", `Unable to resolve file (${code ?? "IO_ERROR"})`);
  }

  let before;
  try {
    before = await stat(sourcePath);
  } catch (error) {
    return failure(
      requestedPath,
      sourcePath,
      "READ_ERROR",
      `Unable to stat file (${nodeCode(error) ?? "IO_ERROR"})`
    );
  }
  if (!before.isFile()) {
    return failure(requestedPath, sourcePath, "NOT_REGULAR", "Path was not a regular file");
  }
  if (!Number.isSafeInteger(before.size)) {
    return failure(requestedPath, sourcePath, "READ_ERROR", "File size exceeds safe integer range");
  }

  await mkdir(options.blobRoot, { recursive: true, mode: 0o700 });
  await chmod(options.blobRoot, 0o700);
  const temporaryPath = join(
    options.blobRoot,
    `.capture-${randomBytes(12).toString("hex")}.tmp`
  );
  const digest = createHash("sha256");
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(
      createReadStream(sourcePath),
      hasher,
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 })
    );
    const after = await stat(sourcePath);
    if (
      !after.isFile() ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      await unlink(temporaryPath).catch(() => undefined);
      return failure(
        requestedPath,
        sourcePath,
        "READ_ERROR",
        "File changed while it was being captured"
      );
    }
    const sha256 = digest.digest("hex");
    const directory = join(options.blobRoot, sha256.slice(0, 2));
    const localPath = join(directory, sha256);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await installCasObject(temporaryPath, localPath);
    await unlink(temporaryPath);
    await chmod(localPath, 0o600);
    const stored = await stat(localPath);
    if (!stored.isFile() || stored.size !== before.size) {
      return failure(requestedPath, sourcePath, "READ_ERROR", "Local Blob snapshot is invalid");
    }
    if (await sha256File(localPath) !== sha256) {
      return failure(
        requestedPath,
        sourcePath,
        "READ_ERROR",
        "Local Blob snapshot digest does not match its CAS path"
      );
    }
    return {
      status: "CAPTURED",
      requestedPath,
      realPath: sourcePath,
      localPath,
      filename: basename(sourcePath),
      mediaType: mediaType(sourcePath),
      sha256,
      byteLength: before.size,
      capturedAt: new Date().toISOString(),
      sourceModifiedAt: before.mtime.toISOString()
    };
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    const code = nodeCode(error);
    if (code === "ENOSPC" || code === "EDQUOT") {
      return failure(requestedPath, sourcePath, "STORAGE_FULL", "Local Blob storage is full");
    }
    if (code === "ENOENT") {
      return failure(requestedPath, sourcePath, "MISSING", "File disappeared during capture");
    }
    return failure(
      requestedPath,
      sourcePath,
      "READ_ERROR",
      `Unable to copy file (${code ?? "IO_ERROR"})`
    );
  }
}

const STRUCTURED_PATH_KEY = /^(?:path|file_path|filepath|transcript_path|persisted_transcript_path|output_path|artifact_path|attachment_path|image_path|local_path|local_images)$/iu;
const COMMAND_KEY = /^(?:command|cmd|script|shell_command)$/iu;
const JSON_CONTAINER_KEY = /^(?:arguments|args|input|tool_input)$/iu;

function shellTokens(command: string): string[] {
  const tokens = command.match(/'(?:[^']*)'|"(?:[^"\\]|\\.)*"|[^\s;&|<>]+/gu) ?? [];
  return tokens.map((token) => {
    if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
    if (token.startsWith("\"") && token.endsWith("\"")) {
      return token.slice(1, -1).replace(/\\([\\"])/gu, "$1");
    }
    return token;
  });
}

function safeLiteralPath(value: string, allowBareRelative = false): string | null {
  const candidate = value.trim().replace(/^[(),]+|[(),:]+$/gu, "");
  const dynamicCharacters = ["$", "`", "*", "?", "[", "]", "{", "}", "~"];
  if (
    !candidate ||
    dynamicCharacters.some((character) => candidate.includes(character)) ||
    /%[^%]+%/u.test(candidate)
  ) {
    return null;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(candidate)) return null;
  const isPosix = candidate.startsWith("/");
  const isWindows = /^[A-Za-z]:[\\/]/u.test(candidate) || candidate.startsWith("\\\\");
  const isRelative = /[\\/]/u.test(candidate) && !candidate.startsWith("-");
  const isBareRelative = allowBareRelative &&
    !candidate.startsWith("-") &&
    candidate !== "." &&
    candidate !== "..";
  return isPosix || isWindows || isRelative || isBareRelative ? candidate : null;
}

export function extractLiteralFilePaths(value: unknown): string[] {
  const paths = new Set<string>();
  const seen = new Set<object>();
  function visit(candidate: unknown, key = "", depth = 0): void {
    if (depth > 16 || candidate === null || candidate === undefined) return;
    if (typeof candidate === "string") {
      if (STRUCTURED_PATH_KEY.test(key)) {
        const path = safeLiteralPath(candidate, true);
        if (path) paths.add(path);
      } else if (COMMAND_KEY.test(key)) {
        for (const token of shellTokens(candidate)) {
          const path = safeLiteralPath(token);
          if (path) paths.add(path);
        }
      } else if (
        JSON_CONTAINER_KEY.test(key) &&
        ["[", "{"].some((prefix) => candidate.trim().startsWith(prefix))
      ) {
        try {
          visit(JSON.parse(candidate), key, depth + 1);
        } catch {
          // An opaque non-JSON argument string is not interpreted as a command.
        }
      }
      return;
    }
    if (typeof candidate !== "object") return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, key, depth + 1);
      return;
    }
    for (const [childKey, child] of Object.entries(candidate)) {
      visit(child, childKey, depth + 1);
    }
  }
  visit(value);
  return [...paths];
}

function aggregateStatus(statuses: AttachmentStatus[]): AttachmentStatus {
  if (statuses.includes("PENDING")) return "PENDING";
  if (statuses.length === 0) return "NOT_APPLICABLE";
  if (statuses.every((status) => status === "CAPTURED")) return "CAPTURED";
  return statuses.find((status) => status !== "CAPTURED") ?? "CAPTURED";
}

export async function stageCaptureAttachments(options: {
  capture: AgentCapture;
  outbox: Outbox;
  blobRoot: string;
  cwd: string;
}): Promise<AgentCapture> {
  const references = [];
  const statusByEvent = new Map<string, AttachmentStatus[]>();
  const runStatuses: AttachmentStatus[] = [];
  for (const request of options.capture.attachmentRequests) {
    const captured = await captureRequestedFile({
      requestedPath: request.requestedPath,
      cwd: options.cwd,
      blobRoot: options.blobRoot
    });
    const status: AttachmentStatus = captured.status === "CAPTURED"
      ? "PENDING"
      : captured.status;
    runStatuses.push(status);
    if (request.eventId) {
      const statuses = statusByEvent.get(request.eventId) ?? [];
      statuses.push(status);
      statusByEvent.set(request.eventId, statuses);
    }
    if (captured.status === "CAPTURED") {
      options.outbox.enqueueBlob({
        sha256: captured.sha256,
        localPath: captured.localPath,
        byteLength: captured.byteLength,
        mediaType: request.mediaType ?? captured.mediaType,
        filename: request.filename ?? captured.filename,
        createdAt: captured.capturedAt
      });
    }
    const referenceId = buildAgentBlobReferenceId({
      runId: request.runId,
      eventId: request.eventId,
      purpose: request.purpose,
      requestedPath: request.requestedPath
    });
    references.push(AgentSyncRecordSchema.parse({
      recordType: "BLOB_REFERENCE",
      referenceId,
      eventId: request.eventId ?? null,
      runId: request.runId,
      blobSha256: captured.status === "CAPTURED" ? captured.sha256 : null,
      purpose: request.purpose,
      requestedPath: request.requestedPath,
      realPath: captured.realPath,
      filename: request.filename ??
        (captured.status === "CAPTURED" ? captured.filename : basename(request.requestedPath)),
      mediaType: request.mediaType ??
        (captured.status === "CAPTURED" ? captured.mediaType : mediaType(request.requestedPath)),
      byteLength: captured.status === "CAPTURED" ? captured.byteLength : null,
      capturedAt: captured.status === "CAPTURED" ? captured.capturedAt : null,
      status,
      failureReason: captured.status === "CAPTURED" ? null : captured.failureReason,
      metadata: {
        ...(request.metadata ?? {}),
        localCaptureStatus: captured.status,
        ...(captured.status === "CAPTURED"
          ? { sourceModifiedAt: captured.sourceModifiedAt }
          : {})
      }
    }));
  }

  const updated = options.capture.records.map((record) => {
    if (record.recordType === "RUN") {
      return {
        ...record,
        attachmentStatus: aggregateStatus(runStatuses)
      };
    }
    if (record.recordType === "EVENT") {
      const statuses = statusByEvent.get(record.eventId);
      return statuses
        ? { ...record, attachmentStatus: aggregateStatus(statuses) }
        : record;
    }
    return record;
  });
  return {
    ...options.capture,
    records: [...updated, ...references],
    attachmentRequests: []
  };
}
