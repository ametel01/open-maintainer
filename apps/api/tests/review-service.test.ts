import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ModelProvider } from "@open-maintainer/ai";
import { MemoryStore } from "@open-maintainer/db";
import type {
  ModelProviderConfig,
  Repo,
  RepoProfile,
} from "@open-maintainer/shared";
import { describe, expect, it } from "vitest";
import type { RepositorySourceLifecycle } from "../src/repository-source-analysis";
import {
  type DashboardReviewCommandRunner,
  createDashboardReviewService,
} from "../src/review-service";

const execFileAsync = promisify(execFile);

describe("dashboard review service", () => {
  it("previews local diffs through source, model, and persistence ports", async () => {
    const repoRoot = await createReviewRepo();
    const store = new MemoryStore();
    const { repo, profile, provider } = seedReviewState(store, repoRoot);
    const prepareCalls: unknown[] = [];
    const service = createDashboardReviewService({
      store,
      repositorySources: reviewSources({
        repo,
        profile,
        worktreeRoot: repoRoot,
        prepareCalls,
      }),
      buildProvider: () => fakeModelProvider,
    });

    try {
      const result = await service.preview({
        repoId: repo.id,
        providerId: provider.id,
        baseRef: "HEAD~1",
        headRef: "HEAD",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(prepareCalls).toEqual([
        {
          repoId: repo.id,
          intent: {
            kind: "review-preview",
            baseRef: "HEAD~1",
            headRef: "HEAD",
          },
        },
      ]);
      expect(result.review.changedFiles.map((file) => file.path)).toEqual([
        "src/index.ts",
      ]);
      expect(result.run?.status).toBe("succeeded");
      expect(store.reviews.get(result.review.id)?.id).toBe(result.review.id);
      expect(result.review.modelProvider).toBe("Codex CLI");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("uses injectable gh metadata before local PR review preparation", async () => {
    const repoRoot = await createReviewRepo();
    const store = new MemoryStore();
    const { repo, profile, provider } = seedReviewState(store, repoRoot);
    const commands: Array<{ tool: "gh"; args: string[]; cwd: string }> = [];
    const runCommand: DashboardReviewCommandRunner = async (input) => {
      commands.push({ tool: input.tool, args: input.args, cwd: input.cwd });
      return JSON.stringify({
        baseRefName: "HEAD~1",
        headRefName: "HEAD",
        headRefOid: "head-sha",
        title: "Review service PR",
        body: "Validation: bun test",
        url: "https://github.com/acme/review-tool/pull/7",
        author: { login: "maintainer" },
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "REVIEW_REQUIRED",
      });
    };
    const service = createDashboardReviewService({
      store,
      repositorySources: reviewSources({
        repo,
        profile,
        worktreeRoot: repoRoot,
      }),
      buildProvider: () => fakeModelProvider,
      runCommand,
    });

    try {
      const result = await service.preview({
        repoId: repo.id,
        providerId: provider.id,
        prNumber: 7,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(commands).toEqual([
        {
          tool: "gh",
          cwd: repoRoot,
          args: [
            "pr",
            "view",
            "7",
            "--json",
            "baseRefName,headRefName,headRefOid,title,body,url,author,isDraft,mergeable,mergeStateStatus,reviewDecision",
          ],
        },
      ]);
      expect(result.review.prNumber).toBe(7);
      expect(result.review.baseRef).toBe("HEAD~1");
      expect(result.review.headRef).toBe("HEAD");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects missing provider consent before repository source preparation", async () => {
    const store = new MemoryStore();
    const repo = reviewRepo("/repo");
    const provider = reviewProvider({ repoContentConsent: false });
    let sourceCalled = false;
    store.repos.set(repo.id, repo);
    store.providers.set(provider.id, provider);
    const service = createDashboardReviewService({
      store,
      repositorySources: {
        async prepare() {
          sourceCalled = true;
          throw new Error("source should not be prepared");
        },
      } as RepositorySourceLifecycle,
      buildProvider: () => fakeModelProvider,
    });

    const result = await service.preview({
      repoId: repo.id,
      providerId: provider.id,
      baseRef: "main",
      headRef: "HEAD",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        statusCode: 403,
      }),
    );
    expect(sourceCalled).toBe(false);
  });
});

async function createReviewRepo(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "api-review-service-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: directory,
  });
  await execFileAsync("git", ["config", "user.name", "Test User"], {
    cwd: directory,
  });
  await mkdir(path.join(directory, "src"), { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ scripts: { test: "bun test", build: "tsc -b" } }),
  );
  await writeFile(
    path.join(directory, "src", "index.ts"),
    "export const value = 1;\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });
  await writeFile(
    path.join(directory, "src", "index.ts"),
    "export const value = 2;\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "change value"], {
    cwd: directory,
  });
  return directory;
}

function seedReviewState(store: MemoryStore, repoRoot: string) {
  const repo = reviewRepo(repoRoot);
  const profile = reviewProfile(repo, repoRoot);
  const provider = reviewProvider();
  store.repos.set(repo.id, repo);
  store.addProfile(profile);
  store.providers.set(provider.id, provider);
  return { repo, profile, provider };
}

function reviewSources(input: {
  repo: Repo;
  profile: RepoProfile;
  worktreeRoot: string;
  prepareCalls?: unknown[];
}): RepositorySourceLifecycle {
  return {
    async prepare(request) {
      input.prepareCalls?.push(request);
      return {
        ok: true,
        value: {
          repo: input.repo,
          files: [],
          profile: input.profile,
          profileCreated: false,
          run: null,
          source: "local-worktree",
          worktreeRoot: input.worktreeRoot,
        },
      };
    },
  };
}

function reviewRepo(_repoRoot: string): Repo {
  return {
    id: "repo_review_service",
    installationId: "installation_review_service",
    owner: "acme",
    name: "review-tool",
    fullName: "acme/review-tool",
    defaultBranch: "main",
    private: false,
    permissions: { contents: true, metadata: true, pull_requests: true },
  };
}

function reviewProvider(
  overrides: Partial<ModelProviderConfig> = {},
): ModelProviderConfig {
  return {
    id: "model_provider_review_service",
    kind: "codex-cli",
    displayName: "Codex CLI",
    baseUrl: "http://localhost",
    model: "gpt-test",
    encryptedApiKey: "local-cli",
    repoContentConsent: true,
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
    ...overrides,
  };
}

function reviewProfile(repo: Repo, _repoRoot: string): RepoProfile {
  return {
    id: "profile_review_service",
    repoId: repo.id,
    version: 1,
    owner: repo.owner,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
    primaryLanguages: ["TypeScript"],
    frameworks: [],
    packageManager: "bun",
    commands: [{ name: "test", command: "bun test", source: "package.json" }],
    ciWorkflows: [],
    importantDocs: ["AGENTS.md"],
    repoTemplates: [],
    architecturePathGroups: [],
    generatedFileHints: [],
    generatedFilePaths: [],
    existingContextFiles: [],
    detectedRiskAreas: [],
    riskHintPaths: [],
    ownershipHints: [],
    environmentFiles: [],
    environmentVariables: [],
    ignoreFiles: [],
    testFilePaths: [],
    reviewRuleCandidates: ["Run `bun test`."],
    evidence: [],
    workspaceManifests: ["package.json"],
    lockfiles: [],
    configFiles: [],
    trackedFileHashes: [],
    contextArtifactHashes: [],
    agentReadiness: {
      score: 80,
      categories: [],
      missingItems: [],
      generatedAt: "2026-05-04T00:00:00.000Z",
    },
    createdAt: "2026-05-04T00:00:00.000Z",
  };
}

const fakeModelProvider: ModelProvider = {
  async complete() {
    return {
      model: "gpt-test",
      text: JSON.stringify({
        summary: {
          overview: "The review service generated a focused preview.",
          changedSurfaces: ["api"],
          riskLevel: "medium",
          validationSummary: "Validation evidence is present.",
          docsSummary: "No docs impact was found.",
        },
        findings: [
          {
            severity: "major",
            category: "tests",
            title: "Cover the changed behavior",
            file: "src/index.ts",
            line: 1,
            evidence: [
              {
                id: "patch:1",
                kind: "patch",
                summary: "The changed value is visible in the diff.",
              },
            ],
            impact: "The behavior can regress without focused coverage.",
            recommendation: "Add or adjust a regression test.",
          },
        ],
        contributionTriage: {
          category: "ready_for_review",
          recommendation: "Proceed with maintainer review.",
          evidence: [
            {
              id: "patch:1",
              kind: "patch",
              summary: "The diff and PR metadata are available.",
            },
          ],
          missingInformation: [],
          requiredActions: [],
        },
        mergeReadiness: {
          status: "conditionally_ready",
          reason: "Review after validation is confirmed.",
          requiredActions: ["Confirm focused tests."],
        },
        residualRisk: [
          {
            risk: "The test uses fake model output.",
            reason: "The service boundary should not call a real provider.",
            suggestedFollowUp: "Run integration coverage separately.",
          },
        ],
      }),
    };
  },
};
