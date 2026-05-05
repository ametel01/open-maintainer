import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseGitHubRepositoryUrl } from "@open-maintainer/analyzer";

const execFileAsync = promisify(execFile);

export type CliRepositoryReference =
  | {
      kind: "local";
      input: string;
      repoRoot: string;
      cleanup(): Promise<void>;
    }
  | {
      kind: "github-url";
      input: string;
      repoRoot: string;
      owner: string;
      name: string;
      url: string;
      cloneUrl: string;
      tempRoot: string;
      artifactRoot: string;
      cleanup(): Promise<void>;
    };

export type PersistedRepositoryArtifacts = {
  artifactRoot: string;
  copiedPaths: string[];
};

export async function resolveCliRepositoryReference(
  repoArg: string,
): Promise<CliRepositoryReference> {
  const github = parseGitHubRepositoryUrl(repoArg);
  if (!github) {
    if (looksLikeUrl(repoArg)) {
      throw new Error(
        "Unsupported repository URL. Expected https://github.com/OWNER/REPO.",
      );
    }
    return {
      kind: "local",
      input: repoArg,
      repoRoot: path.resolve(repoArg),
      async cleanup() {
        return;
      },
    };
  }

  const tempRoot = await mkdtemp(
    path.join(tmpdir(), "open-maintainer-github-repo-"),
  );
  const repoRoot = path.join(tempRoot, "worktree");
  try {
    await runGit(["clone", "--", github.cloneUrl, repoRoot]);
    await runGit([
      "-C",
      repoRoot,
      "remote",
      "set-url",
      "origin",
      github.cloneUrl,
    ]);
    return {
      kind: "github-url",
      input: repoArg,
      repoRoot,
      owner: github.owner,
      name: github.name,
      url: github.htmlUrl,
      cloneUrl: github.cloneUrl,
      tempRoot,
      artifactRoot: path.join(
        defaultUrlArtifactRoot(),
        github.owner,
        github.name,
      ),
      async cleanup() {
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function persistRepositoryReferenceArtifacts(
  reference: CliRepositoryReference,
  artifactPaths: readonly string[],
): Promise<PersistedRepositoryArtifacts | null> {
  if (reference.kind !== "github-url") {
    return null;
  }
  const copiedPaths: string[] = [];
  for (const artifactPath of artifactPaths) {
    const repoRelativePath = normalizeArtifactPath(artifactPath);
    if (!repoRelativePath) {
      continue;
    }
    const source = path.join(reference.repoRoot, repoRelativePath);
    const sourceStat = await stat(source).catch(() => null);
    if (!sourceStat) {
      continue;
    }
    const destination = path.join(reference.artifactRoot, repoRelativePath);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: sourceStat.isDirectory() });
    copiedPaths.push(repoRelativePath);
  }
  return {
    artifactRoot: reference.artifactRoot,
    copiedPaths,
  };
}

function defaultUrlArtifactRoot(): string {
  return path.resolve(
    process.env.OPEN_MAINTAINER_REMOTE_ARTIFACT_ROOT ??
      path.join(process.cwd(), ".open-maintainer", "url-repos"),
  );
}

function normalizeArtifactPath(value: string): string | null {
  if (path.isAbsolute(value)) {
    return null;
  }
  const normalized = path.normalize(value);
  if (
    normalized === "." ||
    normalized.length === 0 ||
    normalized.startsWith("..") ||
    path.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

async function runGit(args: string[]): Promise<string> {
  const command = process.env.OPEN_MAINTAINER_GIT_COMMAND ?? "git";
  try {
    const { stdout } = await execFileAsync(command, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
    return stdout;
  } catch (error) {
    if (error instanceof Error) {
      const details = [
        "stderr" in error && typeof error.stderr === "string"
          ? error.stderr
          : "",
        "stdout" in error && typeof error.stdout === "string"
          ? error.stdout
          : "",
        error.message,
      ]
        .filter((part) => part.trim().length > 0)
        .join("\n");
      throw new Error(`${command} ${args.join(" ")} failed: ${details}`);
    }
    throw error;
  }
}

function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
