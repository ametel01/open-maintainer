import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  RepositoryIgnoreRule,
  ReviewChangedFile,
  ReviewInput,
  ReviewSkippedFile,
} from "@open-maintainer/shared";
import {
  buildRepositoryIgnoreRules,
  isRepositoryPathIgnored,
  nowIso,
  repositoryIgnoreFileNames,
} from "@open-maintainer/shared";

const execFileAsync = promisify(execFile);

export type LocalReviewInputOptions = {
  repoRoot: string;
  repoId: string;
  baseRef: string;
  headRef: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
};

const defaultLimits = {
  maxFiles: 80,
  maxFileBytes: 128 * 1024,
  maxTotalBytes: 768 * 1024,
};

const skippedPathSegments = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const skippedExtensions = new Set([
  ".7z",
  ".avif",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".dmg",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp4",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".tgz",
  ".wasm",
  ".webp",
  ".zip",
]);

export async function assembleLocalReviewInput(
  options: LocalReviewInputOptions,
): Promise<ReviewInput> {
  const limits = { ...defaultLimits, ...options };
  const [baseSha, headSha, statusOutput, numstatOutput] = await Promise.all([
    gitOutput(options.repoRoot, ["rev-parse", options.baseRef]),
    gitOutput(options.repoRoot, ["rev-parse", options.headRef]),
    gitOutput(options.repoRoot, [
      "diff",
      "--name-status",
      "--find-renames",
      `${options.baseRef}...${options.headRef}`,
    ]),
    gitOutput(options.repoRoot, [
      "diff",
      "--numstat",
      "--find-renames",
      `${options.baseRef}...${options.headRef}`,
    ]),
  ]);
  const ignoreRules = await loadRepositoryIgnoreRules(options.repoRoot);
  const numstats = parseNumstat(numstatOutput);
  const changedFiles: ReviewChangedFile[] = [];
  const skippedFiles: ReviewSkippedFile[] = [];
  let totalBytes = 0;

  for (const changedPath of parseNameStatus(statusOutput)) {
    const path = changedPath.path;
    if (
      shouldSkipReviewPath(path) ||
      isRepositoryPathIgnored(path, ignoreRules)
    ) {
      skippedFiles.push({ path, reason: "filtered" });
      continue;
    }
    if (changedFiles.length >= limits.maxFiles) {
      skippedFiles.push({ path, reason: "max_files" });
      continue;
    }
    const stat = numstats.get(path);
    if (stat?.binary) {
      skippedFiles.push({ path, reason: "binary" });
      continue;
    }
    const patch = await gitOutput(options.repoRoot, [
      "diff",
      "--unified=80",
      `${options.baseRef}...${options.headRef}`,
      "--",
      path,
    ]).catch(() => "");
    const patchBytes = Buffer.byteLength(patch, "utf8");
    if (patchBytes > limits.maxFileBytes) {
      skippedFiles.push({ path, reason: "max_file_bytes" });
      continue;
    }
    if (totalBytes + patchBytes > limits.maxTotalBytes) {
      skippedFiles.push({ path, reason: "max_total_bytes" });
      continue;
    }

    totalBytes += patchBytes;
    changedFiles.push({
      path,
      status: changedPath.status,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      patch,
      previousPath: changedPath.previousPath,
    });
  }

  return {
    repoId: options.repoId,
    owner: "local",
    repo: "local",
    prNumber: null,
    title: null,
    body: "",
    url: null,
    author: null,
    isDraft: null,
    mergeable: null,
    mergeStateStatus: null,
    reviewDecision: null,
    baseRef: options.baseRef,
    headRef: options.headRef,
    baseSha: baseSha.trim(),
    headSha: headSha.trim(),
    changedFiles,
    commits: await listLocalCommits(
      options.repoRoot,
      options.baseRef,
      options.headRef,
    ),
    checkStatuses: [],
    issueContext: [],
    existingComments: [],
    skippedFiles,
    createdAt: nowIso(),
  };
}

async function listLocalCommits(
  repoRoot: string,
  baseRef: string,
  headRef: string,
): Promise<string[]> {
  const output = await gitOutput(repoRoot, [
    "log",
    "--format=%H",
    `${baseRef}..${headRef}`,
  ]);
  return output.split(/\r?\n/).filter(Boolean);
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function loadRepositoryIgnoreRules(
  repoRoot: string,
): Promise<RepositoryIgnoreRule[]> {
  const ignoreFiles = await Promise.all(
    repositoryIgnoreFileNames.map(async (fileName) => {
      const content = await readFile(
        path.join(repoRoot, fileName),
        "utf8",
      ).catch(() => null);
      return content === null ? null : { path: fileName, content };
    }),
  );
  return buildRepositoryIgnoreRules(
    ignoreFiles.filter(
      (file): file is NonNullable<(typeof ignoreFiles)[number]> =>
        file !== null,
    ),
  );
}

function parseNameStatus(output: string): Array<{
  path: string;
  previousPath: string | null;
  status: ReviewChangedFile["status"];
}> {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [rawStatus = "M", firstPath = "", secondPath] = line.split("\t");
      const statusCode = rawStatus.charAt(0);
      if (statusCode === "R") {
        return {
          path: secondPath ?? firstPath,
          previousPath: firstPath,
          status: "renamed" as const,
        };
      }
      return {
        path: firstPath,
        previousPath: null,
        status: mapGitStatus(statusCode),
      };
    });
}

function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const stats = new Map<
    string,
    { additions: number; deletions: number; binary: boolean }
  >();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [additions = "0", deletions = "0", path = ""] = line.split("\t");
    const binary = additions === "-" || deletions === "-";
    stats.set(path, {
      additions: binary ? 0 : Number(additions),
      deletions: binary ? 0 : Number(deletions),
      binary,
    });
  }
  return stats;
}

function mapGitStatus(status: string): ReviewChangedFile["status"] {
  if (status === "A") {
    return "added";
  }
  if (status === "D") {
    return "removed";
  }
  if (status === "C") {
    return "copied";
  }
  return "modified";
}

function shouldSkipReviewPath(repoPath: string): boolean {
  const normalizedPath = repoPath.replace(/^\/+/, "");
  const segments = normalizedPath
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  const fileName = segments.at(-1)?.toLowerCase() ?? "";
  const lowerPath = normalizedPath.toLowerCase();
  const extension = fileName.includes(".")
    ? `.${fileName.split(".").at(-1) ?? ""}`
    : "";

  return (
    segments.some((segment) => skippedPathSegments.has(segment)) ||
    skippedExtensions.has(extension) ||
    lowerPath.endsWith(".min.js") ||
    lowerPath.endsWith(".min.css")
  );
}
