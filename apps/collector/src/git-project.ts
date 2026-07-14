import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeGitRemote, repositoryRootName } from "@ai-worklog/core";

const execFileAsync = promisify(execFile);

export interface LocalProjectIdentity {
  gitRemoteKey: string | null;
  repoRootName: string | null;
  pathForHmac: string;
}

async function gitOutput(cwd: string, arguments_: string[]): Promise<string | null> {
  if (!cwd.trim() || cwd.length > 4_096) return null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, ...arguments_],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0"
        }
      }
    );
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

export async function resolveLocalProjectIdentity(options: {
  cwd: string;
  reportedGitRemote?: string;
}): Promise<LocalProjectIdentity> {
  const gitRoot = await gitOutput(options.cwd, ["rev-parse", "--show-toplevel"]);
  const pathForHmac = gitRoot ?? options.cwd;
  const reportedRemote = options.reportedGitRemote
    ? normalizeGitRemote(options.reportedGitRemote)
    : null;
  if (reportedRemote) {
    return {
      gitRemoteKey: reportedRemote,
      repoRootName: repositoryRootName(pathForHmac),
      pathForHmac
    };
  }

  const configuredRemote = await gitOutput(options.cwd, [
    "config",
    "--local",
    "--get",
    "remote.origin.url"
  ]);
  const normalizedRemote = configuredRemote
    ? normalizeGitRemote(configuredRemote)
    : null;
  if (normalizedRemote) {
    return {
      gitRemoteKey: normalizedRemote,
      repoRootName: repositoryRootName(pathForHmac),
      pathForHmac
    };
  }

  return {
    gitRemoteKey: null,
    repoRootName: repositoryRootName(pathForHmac),
    pathForHmac
  };
}
