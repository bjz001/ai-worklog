import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalProjectIdentity } from "./git-project";

describe("resolveLocalProjectIdentity", () => {
  it("reads a local Git origin without retaining URL credentials", async () => {
    const repository = mkdtempSync(join(tmpdir(), "collector-git-"));
    const nested = join(repository, "packages", "web");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "--quiet", repository]);
    execFileSync("git", [
      "-C",
      repository,
      "remote",
      "add",
      "origin",
      "https://fixture-user:fixture-secret@example.com/acme/worklog.git"
    ]);

    const identity = await resolveLocalProjectIdentity({ cwd: nested });

    expect(identity.gitRemoteKey).toBe("example.com/acme/worklog");
    expect(identity.pathForHmac).toBe(realpathSync(repository));
    expect(identity.repoRootName).toBe(basename(repository));
    expect(JSON.stringify(identity)).not.toContain("fixture-secret");
  });

  it("uses the Git root name when the source already reports a remote", async () => {
    const repository = mkdtempSync(join(tmpdir(), "collector-reported-git-"));
    const nested = join(repository, "packages", "web");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "--quiet", repository]);

    const identity = await resolveLocalProjectIdentity({
      cwd: nested,
      reportedGitRemote: "git@example.com:acme/worklog.git"
    });

    expect(identity.gitRemoteKey).toBe("example.com/acme/worklog");
    expect(identity.pathForHmac).toBe(realpathSync(repository));
    expect(identity.repoRootName).toBe(basename(repository));
  });

  it("uses the actual Git root for a credential-free fallback", async () => {
    const repository = mkdtempSync(join(tmpdir(), "collector-git-root-"));
    const nested = join(repository, "src", "feature");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "--quiet", repository]);

    const identity = await resolveLocalProjectIdentity({ cwd: nested });

    expect(identity.gitRemoteKey).toBeNull();
    expect(identity.pathForHmac).toBe(realpathSync(repository));
    expect(identity.repoRootName).toBe(basename(repository));
  });
});
