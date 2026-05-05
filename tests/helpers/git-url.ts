import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createGitHubUrlRewrite(input: {
  owner: string;
  repo: string;
  remotePath: string;
}): Promise<{ env: Record<string, string>; url: string; gitUrl: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "om-git-url-"));
  const configPath = path.join(directory, "gitconfig");
  const url = `https://github.com/${input.owner}/${input.repo}`;
  const gitUrl = `${url}.git`;
  await writeFile(
    configPath,
    [
      `[url "${pathToFileUrl(input.remotePath)}"]`,
      `  insteadOf = ${url}`,
      `  insteadOf = ${gitUrl}`,
      "",
    ].join("\n"),
  );
  return {
    url,
    gitUrl,
    env: {
      GIT_ALLOW_PROTOCOL: "file:https",
      GIT_CONFIG_GLOBAL: configPath,
    },
  };
}

export async function createBareRemoteFromWorktree(
  worktree: string,
): Promise<string> {
  const remote = await mkdtemp(path.join(tmpdir(), "om-git-remote-"));
  await execFileAsync("git", ["init", "--bare"], { cwd: remote });
  await execFileAsync("git", ["push", remote, "main"], { cwd: worktree });
  return remote;
}

export async function createArtifactRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "om-url-artifacts-"));
  await mkdir(directory, { recursive: true });
  return directory;
}

function pathToFileUrl(value: string): string {
  const normalized = path
    .resolve(value)
    .split(path.sep)
    .map(encodeURIComponent);
  return `file://${normalized.join("/")}`;
}
