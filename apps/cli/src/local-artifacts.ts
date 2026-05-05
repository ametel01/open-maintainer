import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export const defaultLocalArtifactRetentionDays = 30;

const localArtifactRoots = [
  ".open-maintainer/triage/issues",
  ".open-maintainer/triage/runs",
  ".open-maintainer/reviews",
  ".open-maintainer/runs",
] as const;

export type ExpiredLocalArtifact = {
  path: string;
  ageDays: number;
};

export async function findExpiredLocalArtifacts(input: {
  repoRoot: string;
  maxAgeDays?: number;
  now?: Date;
}): Promise<ExpiredLocalArtifact[]> {
  const maxAgeDays = input.maxAgeDays ?? defaultLocalArtifactRetentionDays;
  const now = input.now ?? new Date();
  const expired: ExpiredLocalArtifact[] = [];
  for (const artifactRoot of localArtifactRoots) {
    await collectExpiredFiles({
      repoRoot: input.repoRoot,
      relativeDirectory: artifactRoot,
      maxAgeDays,
      now,
      expired,
    });
  }
  return expired.sort((left, right) => left.path.localeCompare(right.path));
}

export async function removeLocalArtifacts(input: {
  repoRoot: string;
  paths: readonly string[];
  dryRun?: boolean;
}): Promise<void> {
  for (const repoPath of input.paths) {
    if (!isLocalOperationalArtifactPath(repoPath)) {
      throw new Error(
        `Refusing to remove non-operational artifact: ${repoPath}`,
      );
    }
    if (!input.dryRun) {
      await rm(path.join(input.repoRoot, repoPath), { force: true });
    }
  }
}

async function collectExpiredFiles(input: {
  repoRoot: string;
  relativeDirectory: string;
  maxAgeDays: number;
  now: Date;
  expired: ExpiredLocalArtifact[];
}): Promise<void> {
  const absoluteDirectory = path.join(input.repoRoot, input.relativeDirectory);
  const entries = await readdir(absoluteDirectory, {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries) {
    const relativePath = `${input.relativeDirectory}/${entry.name}`;
    const absolutePath = path.join(input.repoRoot, relativePath);
    if (entry.isDirectory()) {
      await collectExpiredFiles({
        ...input,
        relativeDirectory: relativePath,
      });
      continue;
    }
    if (!entry.isFile() || !isLocalOperationalArtifactPath(relativePath)) {
      continue;
    }
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat) {
      continue;
    }
    const ageDays = Math.floor(
      (input.now.getTime() - fileStat.mtime.getTime()) / 86_400_000,
    );
    if (ageDays > input.maxAgeDays) {
      input.expired.push({ path: relativePath, ageDays });
    }
  }
}

function isLocalOperationalArtifactPath(repoPath: string): boolean {
  const normalizedPath = repoPath.replaceAll("\\", "/").replace(/^\/+/, "");
  return localArtifactRoots.some((root) =>
    normalizedPath.startsWith(`${root}/`),
  );
}
