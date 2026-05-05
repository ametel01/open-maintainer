import path from "node:path";
import {
  type AnalyzeRepoInput,
  type AnalyzerFile,
  type RepositoryWorkspaceDeps,
  createRepositoryWorkspace,
  parseGitHubRepositoryUrl,
} from "@open-maintainer/analyzer";
import type { RepoProfile } from "@open-maintainer/shared";
import { describe, expect, it } from "vitest";

const sampleFiles: AnalyzerFile[] = [
  {
    path: "package.json",
    content: JSON.stringify({ scripts: { test: "vitest run" } }),
  },
];

describe("repository workspace", () => {
  it("scans with the default limit and analyzes local profile defaults", async () => {
    const { workspace, scanCalls, analyzeCalls } = createWorkspace();
    const repoRoot = path.join("/tmp", "owner-from-path", "repo-from-path");

    const profile = await workspace.profile(repoRoot);

    expect(profile.owner).toBe("owner-from-path");
    expect(profile.name).toBe("repo-from-path");
    expect(scanCalls).toEqual([{ repoRoot, options: { maxFiles: 800 } }]);
    expect(analyzeCalls).toEqual([
      expect.objectContaining({
        repoId: "local",
        owner: "owner-from-path",
        name: "repo-from-path",
        defaultBranch: "main",
        version: 1,
        files: sampleFiles,
      }),
    ]);
  });

  it("reuses supplied files without rescanning", async () => {
    const { workspace, scanCalls, analyzeCalls } = createWorkspace();
    const repoRoot = path.join("/tmp", "acme", "tool");
    const files = [{ path: "AGENTS.md", content: "# Instructions\n" }];

    const profile = await workspace.profile({
      repoRoot,
      files,
      repoId: "repo_custom",
      version: 3,
    });

    expect(profile.repoId).toBe("repo_custom");
    expect(profile.version).toBe(3);
    expect(scanCalls).toEqual([]);
    expect(analyzeCalls[0]).toEqual(
      expect.objectContaining({
        repoId: "repo_custom",
        version: 3,
        files,
      }),
    );
  });

  it("infers owner and name from GitHub HTTPS remotes", async () => {
    const { workspace } = createWorkspace({
      gitOutput: gitOutputs({
        remote: "https://github.com/Open-Maintainer/open-maintainer.git",
        branch: "origin/trunk",
      }),
    });

    const profile = await workspace.profile(path.join("/tmp", "local", "repo"));

    expect(profile.owner).toBe("Open-Maintainer");
    expect(profile.name).toBe("open-maintainer");
    expect(profile.defaultBranch).toBe("trunk");
    await expect(workspace.defaultBranch("/tmp/repo")).resolves.toBe("trunk");
  });

  it("infers owner and name from GitHub SSH remotes", async () => {
    const { workspace } = createWorkspace({
      gitOutput: gitOutputs({
        remote: "git@github.com:Open-Maintainer/open-maintainer.git",
        branch: "origin/main",
      }),
    });

    const profile = await workspace.profile(path.join("/tmp", "local", "repo"));

    expect(profile.owner).toBe("Open-Maintainer");
    expect(profile.name).toBe("open-maintainer");
  });

  it("falls back to path identity and null default branch when Git facts are unavailable", async () => {
    const { workspace } = createWorkspace({
      gitOutput: async () => null,
    });
    const repoRoot = path.join("/tmp", "fallback-owner", "fallback-name");

    const profile = await workspace.profile(repoRoot);

    expect(profile.owner).toBe("fallback-owner");
    expect(profile.name).toBe("fallback-name");
    expect(profile.defaultBranch).toBe("main");
    await expect(workspace.defaultBranch(repoRoot)).resolves.toBeNull();
  });

  it("falls back to path identity when the remote is unparsable", async () => {
    const { workspace } = createWorkspace({
      gitOutput: gitOutputs({
        remote: "not-a-git-remote",
        branch: "origin/release",
      }),
    });
    const repoRoot = path.join("/tmp", "fallback-owner", "fallback-name");

    const profile = await workspace.profile(repoRoot);

    expect(profile.owner).toBe("fallback-owner");
    expect(profile.name).toBe("fallback-name");
    expect(profile.defaultBranch).toBe("release");
  });

  it("does not throw when Git commands fail during identity resolution", async () => {
    const { workspace } = createWorkspace({
      async gitOutput() {
        throw new Error("git unavailable");
      },
    });
    const repoRoot = path.join("/tmp", "fallback-owner", "fallback-name");

    const profile = await workspace.profile(repoRoot);

    expect(profile.owner).toBe("fallback-owner");
    expect(profile.name).toBe("fallback-name");
    expect(profile.defaultBranch).toBe("main");
  });
});

describe("GitHub repository URL references", () => {
  it("parses HTTPS GitHub repository URLs with or without .git", () => {
    expect(
      parseGitHubRepositoryUrl("https://github.com/Open-Maintainer/tool"),
    ).toEqual({
      owner: "Open-Maintainer",
      name: "tool",
      htmlUrl: "https://github.com/Open-Maintainer/tool",
      cloneUrl: "https://github.com/Open-Maintainer/tool.git",
    });
    expect(
      parseGitHubRepositoryUrl("https://github.com/Open-Maintainer/tool.git"),
    ).toEqual({
      owner: "Open-Maintainer",
      name: "tool",
      htmlUrl: "https://github.com/Open-Maintainer/tool",
      cloneUrl: "https://github.com/Open-Maintainer/tool.git",
    });
  });

  it("rejects unsupported URL shapes", () => {
    expect(
      parseGitHubRepositoryUrl("https://github.com/acme/tool/pull/1"),
    ).toBe(null);
    expect(
      parseGitHubRepositoryUrl("https://example.com/acme/tool"),
    ).toBeNull();
    expect(parseGitHubRepositoryUrl("/tmp/acme/tool")).toBeNull();
  });
});

function createWorkspace(overrides: Partial<RepositoryWorkspaceDeps> = {}): {
  workspace: ReturnType<typeof createRepositoryWorkspace>;
  scanCalls: Array<{
    repoRoot: string;
    options: Parameters<RepositoryWorkspaceDeps["scanRepository"]>[1];
  }>;
  analyzeCalls: AnalyzeRepoInput[];
} {
  const scanCalls: Array<{
    repoRoot: string;
    options: Parameters<RepositoryWorkspaceDeps["scanRepository"]>[1];
  }> = [];
  const analyzeCalls: AnalyzeRepoInput[] = [];
  const workspace = createRepositoryWorkspace({
    async scanRepository(repoRoot, options) {
      scanCalls.push({ repoRoot, options });
      return sampleFiles;
    },
    analyzeRepo(input) {
      analyzeCalls.push(input);
      return repoProfile(input);
    },
    async gitOutput() {
      return null;
    },
    ...overrides,
  });
  return { workspace, scanCalls, analyzeCalls };
}

function gitOutputs(input: {
  remote: string | null;
  branch: string | null;
}): RepositoryWorkspaceDeps["gitOutput"] {
  return async (_repoRoot, args) => {
    if (args.join(" ") === "remote get-url origin") {
      return input.remote;
    }
    if (args.join(" ") === "symbolic-ref --short refs/remotes/origin/HEAD") {
      return input.branch;
    }
    return null;
  };
}

function repoProfile(input: AnalyzeRepoInput): RepoProfile {
  return {
    id: "profile_test",
    repoId: input.repoId,
    version: input.version,
    owner: input.owner,
    name: input.name,
    defaultBranch: input.defaultBranch,
    commands: [],
    detectedRiskAreas: [],
    riskHintPaths: [],
    environmentVariables: [],
    ownershipHints: [],
    generatedFilePaths: [],
    agentReadiness: {
      score: 0,
      categories: [],
      missingItems: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    },
  } as RepoProfile;
}
