import { lstat, readdir, realpath } from "node:fs/promises";
import { extname, join } from "node:path";

const MAX_DEPTH = 8;
const MAX_FILES = 1_000;

export async function discoverCodexFiles(sourcePath: string): Promise<string[]> {
  const originalStat = await lstat(sourcePath);
  if (originalStat.isSymbolicLink()) throw new Error("Codex source symlinks are not allowed");
  const safeRoot = await realpath(sourcePath);
  if (originalStat.isFile()) {
    if (extname(safeRoot).toLowerCase() !== ".jsonl") {
      throw new Error("Codex source must be a .jsonl file or directory");
    }
    return [safeRoot];
  }
  if (!originalStat.isDirectory()) throw new Error("Codex source must be a file or directory");

  const files: string[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error("Codex source exceeds the directory depth limit");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".jsonl") {
        files.push(await realpath(path));
        if (files.length > MAX_FILES) throw new Error("Codex source exceeds the file count limit");
      }
    }
  }

  await walk(safeRoot, 0);
  return files;
}
