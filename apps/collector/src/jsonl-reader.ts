import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { extname } from "node:path";
import { createInterface } from "node:readline";

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;

export type JsonRecord = Record<string, unknown>;

export interface JsonlEntry {
  record: JsonRecord | null;
  lineNumber: number;
}

export async function* readJsonlRecords(
  filePath: string,
  sourceLabel: string
): AsyncGenerator<JsonlEntry> {
  if (extname(filePath).toLowerCase() !== ".jsonl") {
    throw new Error(`${sourceLabel} source must be a .jsonl file`);
  }
  const sourceStat = await lstat(filePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`${sourceLabel} source symlinks are not allowed`);
  }
  if (!sourceStat.isFile()) {
    throw new Error(`${sourceLabel} source must be a regular file`);
  }
  if (sourceStat.size > MAX_FILE_BYTES) {
    throw new Error(`${sourceLabel} source exceeds the 256 MiB safety limit`);
  }

  const safePath = await realpath(filePath);
  const input = createReadStream(safePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim().length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        throw new Error(`${sourceLabel} JSONL line exceeds the safety limit`);
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        throw new Error(`Invalid ${sourceLabel} JSONL at line ${lineNumber}`);
      }
      yield {
        record:
          decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
            ? decoded as JsonRecord
            : null,
        lineNumber
      };
    }
  } finally {
    lines.close();
    input.destroy();
  }
}
