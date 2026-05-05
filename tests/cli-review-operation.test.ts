import type { CompletionInput, ModelProvider } from "@open-maintainer/ai";
import type {
  ModelProviderConfig,
  RepoProfile,
  ReviewInput,
} from "@open-maintainer/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ReviewOperationPorts,
  createReviewOperationRuntime,
} from "../apps/cli/src/review-operation";

const providerConfig: ModelProviderConfig = {
  id: "model_provider_cli_review_test",
  kind: "codex-cli",
  displayName: "Test CLI Provider",
  baseUrl: "http://localhost",
  model: "gpt-test",
  encryptedApiKey: "local-cli",
  repoContentConsent: true,
  createdAt: "2026-05-04T00:00:00.000Z",
  updatedAt: "2026-05-04T00:00:00.000Z",
};

const observedPrompts: CompletionInput[] = [];

const provider: ModelProvider = {
  async complete(input) {
    observedPrompts.push(input);
    return {
      model: "gpt-test",
      text: JSON.stringify({
        summary: {
          overview: "The operation reviewed one changed source file.",
          changedSurfaces: ["cli"],
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
            line: 2,
            evidence: [
              {
                id: "patch:1",
                kind: "patch",
                summary: "The changed return value needs coverage.",
              },
            ],
            impact: "The behavior can regress without focused tests.",
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
              summary: "The diff and PR context are available.",
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
            risk: "In-memory tests do not exercise real git or gh.",
            reason: "The operation boundary uses mock ports here.",
            suggestedFollowUp: "Run CLI integration coverage.",
          },
        ],
      }),
    };
  },
};

describe("CLI review operation runtime", () => {
  beforeEach(() => {
    observedPrompts.length = 0;
  });

  it("reviews a local diff through operation ports and writes markdown in apply mode", async () => {
    const writes: Array<{ repoRoot: string; path: string; markdown: string }> =
      [];
    const assembleCalls: Array<{ baseRef: string; headRef: string }> = [];
    const operation = createReviewOperationRuntime(
      createPorts({
        async assembleDiff(input) {
          assembleCalls.push({
            baseRef: input.baseRef,
            headRef: input.headRef,
          });
          return reviewInput({ prNumber: null });
        },
        output: {
          async writeMarkdown(input) {
            writes.push(input);
          },
        },
      }),
    );

    const run = await operation.review({
      repoRoot: "/repo",
      target: { kind: "diff", baseRef: "main", headRef: "HEAD" },
      model: {
        provider: "codex",
        consent: { repositoryContentTransfer: true },
      },
      intent: "apply",
      output: { markdownPath: ".open-maintainer/review.md" },
    });

    expect(assembleCalls).toEqual([{ baseRef: "main", headRef: "HEAD" }]);
    expect(run.output).toEqual({
      markdownPath: ".open-maintainer/review.md",
      written: true,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.markdown).toContain("## OpenMaintainer Review local");
    expect(run.diagnostics).toEqual({
      promptContextPaths: ["AGENTS.md"],
      skippedFiles: [{ path: "dist/bundle.js", reason: "filtered" }],
      changedFileCount: 1,
    });
    expect(observedPrompts[0]?.user).toContain("Operation prompt context.");
  });

  it("reports planned markdown output without writing in preview mode", async () => {
    const writes: unknown[] = [];
    const operation = createReviewOperationRuntime(
      createPorts({
        output: {
          async writeMarkdown(input) {
            writes.push(input);
          },
        },
      }),
    );

    const run = await operation.review({
      repoRoot: "/repo",
      target: { kind: "diff" },
      model: {
        provider: "codex",
        consent: { repositoryContentTransfer: true },
      },
      intent: "preview",
      output: { markdownPath: ".open-maintainer/review.md" },
    });

    expect(run.output).toEqual({
      markdownPath: ".open-maintainer/review.md",
      written: false,
    });
    expect(writes).toHaveLength(0);
  });

  it("plans pull request publication without calling publisher writes", async () => {
    let fetchPrNumber = 0;
    let publishCalled = false;
    const operation = createReviewOperationRuntime(
      createPorts({
        async fetchPullRequestMetadata(input) {
          fetchPrNumber = input.prNumber;
          return reviewPullRequestMetadata({ number: input.prNumber });
        },
        publisher: {
          async plan(input) {
            return {
              summary: {
                action: "create",
                body: input.markdown,
                existingCommentId: null,
              },
              inline: { comments: [], skipped: [] },
              triageLabel: {
                label: "open-maintainer/ready-for-review",
                apply: true,
                createMissingLabels: false,
                labelsToCreate: [],
                labelsToRemove: [],
              },
            };
          },
          async publish() {
            publishCalled = true;
            throw new Error("publish should not run for plan mode");
          },
        },
      }),
    );

    const run = await operation.review({
      repoRoot: "/repo",
      target: { kind: "pullRequest", number: 7 },
      model: {
        provider: "codex",
        consent: { repositoryContentTransfer: true },
      },
      intent: "preview",
      publication: {
        mode: "plan",
        summary: true,
        inline: { cap: 2 },
        triageLabel: { apply: true },
      },
    });

    expect(fetchPrNumber).toBe(7);
    expect(publishCalled).toBe(false);
    expect(run.publication).toEqual(
      expect.objectContaining({
        mode: "planned",
        summary: expect.objectContaining({ action: "create" }),
        inline: expect.objectContaining({ comments: [] }),
        triageLabel: expect.objectContaining({
          label: "open-maintainer/ready-for-review",
        }),
      }),
    );
  });

  it("routes summary, inline, and triage label publication through the publisher port", async () => {
    const publishedOptions: unknown[] = [];
    const operation = createReviewOperationRuntime(
      createPorts({
        publisher: {
          async plan() {
            throw new Error("plan should not run in publish mode");
          },
          async publish(input) {
            publishedOptions.push(input.options);
            return {
              summary: {
                action: "create",
                body: input.markdown,
                existingCommentId: null,
                commentId: 1,
                url: "https://github.com/acme/tool/pull/7#issuecomment-1",
              },
              inline: {
                comments: [],
                skipped: [],
                reviewId: 2,
                url: "https://github.com/acme/tool/pull/7#pullrequestreview-2",
              },
              triageLabel: {
                label: "open-maintainer/ready-for-review",
                apply: true,
                createMissingLabels: true,
                labelsToCreate: [],
                labelsToRemove: [],
                applied: true,
                created: 0,
                removed: [],
              },
            };
          },
        },
      }),
    );

    const run = await operation.review({
      repoRoot: "/repo",
      target: { kind: "pullRequest", number: 7 },
      model: {
        provider: "codex",
        model: "gpt-test",
        consent: { repositoryContentTransfer: true },
      },
      intent: "apply",
      publication: {
        mode: "publish",
        summary: true,
        inline: { cap: 3 },
        triageLabel: { apply: true, createMissingLabels: true },
      },
    });

    expect(run.publication.mode).toBe("published");
    expect(publishedOptions).toEqual([
      {
        summary: true,
        inline: { cap: 3 },
        triageLabel: { apply: true, createMissingLabels: true },
      },
    ]);
  });

  it("fails consent-gated model requests before source preparation", async () => {
    let sourceCalled = false;
    const operation = createReviewOperationRuntime(
      createPorts({
        async assembleDiff() {
          sourceCalled = true;
          throw new Error("source should not be prepared");
        },
      }),
    );

    await expect(
      operation.review({
        repoRoot: "/repo",
        target: { kind: "diff" },
        model: {
          provider: "codex",
          consent: { repositoryContentTransfer: false },
        } as never,
        intent: "preview",
      }),
    ).rejects.toThrow("explicit repository-content transfer consent");
    expect(sourceCalled).toBe(false);
  });

  it("refuses ready-for-review triage labels for blocked PR state before publisher writes", async () => {
    let publishCalled = false;
    const operation = createReviewOperationRuntime(
      createPorts({
        async fetchPullRequestMetadata(input) {
          return reviewPullRequestMetadata({
            number: input.prNumber,
            isDraft: true,
          });
        },
        publisher: {
          async plan() {
            throw new Error("plan should not run");
          },
          async publish() {
            publishCalled = true;
            throw new Error("publish should not run for blocked PR state");
          },
        },
      }),
    );

    await expect(
      operation.review({
        repoRoot: "/repo",
        target: { kind: "pullRequest", number: 7 },
        model: {
          provider: "codex",
          consent: { repositoryContentTransfer: true },
        },
        intent: "apply",
        publication: {
          mode: "publish",
          triageLabel: { apply: true },
        },
      }),
    ).rejects.toThrow("PR is draft");
    expect(publishCalled).toBe(false);
  });
});

function createPorts(
  overrides: {
    assembleDiff?: ReviewOperationPorts["source"]["assembleDiff"];
    fetchPullRequestMetadata?: ReviewOperationPorts["source"]["fetchPullRequestMetadata"];
    publisher?: ReviewOperationPorts["publisher"];
    output?: ReviewOperationPorts["output"];
  } = {},
): ReviewOperationPorts {
  return {
    workspace: {
      async prepareProfile() {
        return repoProfile();
      },
      async detectDefaultBranch() {
        return "main";
      },
    },
    source: {
      async assembleDiff(input) {
        if (overrides.assembleDiff) {
          return overrides.assembleDiff(input);
        }
        return reviewInput({ prNumber: null });
      },
      async fetchPullRequestMetadata(input) {
        if (overrides.fetchPullRequestMetadata) {
          return overrides.fetchPullRequestMetadata(input);
        }
        return reviewPullRequestMetadata({ number: input.prNumber });
      },
    },
    promptContext: {
      async load() {
        return {
          context: { agentsMd: "Operation prompt context." },
          paths: ["AGENTS.md"],
        };
      },
    },
    modelProvider: {
      resolve() {
        return { providerConfig, provider };
      },
    },
    publisher: overrides.publisher ?? {
      async plan() {
        return { summary: null, inline: null, triageLabel: null };
      },
      async publish() {
        return { summary: null, inline: null, triageLabel: null };
      },
    },
    output: overrides.output ?? {
      async writeMarkdown() {},
    },
  };
}

function repoProfile(): RepoProfile {
  return {
    id: "profile_1",
    repoId: "repo_1",
    version: 1,
    owner: "acme",
    name: "tool",
    defaultBranch: "main",
    primaryLanguages: ["TypeScript"],
    frameworks: [],
    packageManager: "bun",
    commands: [
      {
        name: "test",
        command: "bun test",
        source: "package.json",
      },
    ],
    ciWorkflows: [],
    importantDocs: ["AGENTS.md"],
    repoTemplates: [],
    architecturePathGroups: [],
    generatedFileHints: [],
    generatedFilePaths: [],
    existingContextFiles: ["AGENTS.md"],
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

function reviewPullRequestMetadata(
  overrides: {
    number?: number;
    isDraft?: boolean | null;
  } = {},
) {
  return {
    number: overrides.number ?? 7,
    owner: "acme",
    repo: "tool",
    title: "Change value",
    body: "Validation: bun test",
    url: "https://github.com/acme/tool/pull/7",
    author: "author",
    isDraft: overrides.isDraft ?? false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "REVIEW_REQUIRED",
    baseRef: "main",
    headRef: "feature",
    baseSha: "base-sha",
    headSha: "head-sha",
    checkStatuses: [
      {
        name: "Tests",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        url: "https://example.test/check",
      },
    ],
    existingComments: [],
  };
}

function reviewInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    repoId: "repo_1",
    owner: "acme",
    repo: "tool",
    prNumber: 7,
    title: "Change value",
    body: "Validation: bun test",
    url: "https://github.com/acme/tool/pull/7",
    author: "author",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "REVIEW_REQUIRED",
    baseRef: "main",
    headRef: "feature",
    baseSha: "base-sha",
    headSha: "head-sha",
    changedFiles: [
      {
        path: "src/index.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1\n-export const value = 1;\n+export const value = 2;",
        previousPath: null,
      },
    ],
    commits: ["head-sha"],
    checkStatuses: [
      {
        name: "Tests",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        url: "https://example.test/check",
      },
    ],
    issueContext: [],
    existingComments: [],
    skippedFiles: [{ path: "dist/bundle.js", reason: "filtered" }],
    createdAt: "2026-05-04T00:00:00.000Z",
    ...overrides,
  };
}
