import type { CompletionInput, ModelProvider } from "@open-maintainer/ai";
import type {
  ModelProviderConfig,
  RepoProfile,
  ReviewInput,
} from "@open-maintainer/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type PullRequestReviewWorkflowDeps,
  type ReviewOrchestratorError,
  type ReviewWorkflowDeps,
  createPullRequestReviewWorkflow,
  createReviewOperation,
  createReviewOperationDeps,
  createReviewOrchestrator,
  createReviewPipeline,
  createReviewWorkflow,
} from "../src";

const providerConfig: ModelProviderConfig = {
  id: "model_provider_test",
  kind: "codex-cli",
  displayName: "Test Provider",
  baseUrl: "http://localhost",
  model: "gpt-test",
  encryptedApiKey: "test",
  repoContentConsent: true,
  createdAt: "2026-05-04T00:00:00.000Z",
  updatedAt: "2026-05-04T00:00:00.000Z",
};

const provider: ModelProvider = {
  async complete(input) {
    observedPrompts.push(input);
    return {
      model: "gpt-test",
      text: JSON.stringify({
        summary: {
          overview: "The PR changes one source file.",
          changedSurfaces: ["package:review"],
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
                summary: "Changed return value.",
              },
            ],
            impact: "The behavior can regress without focused coverage.",
            recommendation: "Add or adjust a focused regression test.",
          },
        ],
        contributionTriage: {
          category: "ready_for_review",
          recommendation: "Review the focused implementation.",
          evidence: [
            {
              id: "patch:1",
              kind: "patch",
              summary: "The diff is bounded to one file.",
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
            risk: "Local fake checks do not prove CI behavior.",
            reason: "The test uses in-memory ports.",
            suggestedFollowUp: "Run repository validation.",
          },
        ],
      }),
    };
  },
};

const observedPrompts: CompletionInput[] = [];

describe("pull request review workflow", () => {
  beforeEach(() => {
    observedPrompts.length = 0;
  });

  it("publishes default PR review behavior through publisher ports", async () => {
    const published: unknown[] = [];
    const workflow = createPullRequestReviewWorkflow(
      createDeps({
        async publish(input) {
          published.push(input);
          return {
            summary: {
              action: "create",
              body: input.markdown,
              existingCommentId: null,
              commentId: 1,
              url: "https://github.com/acme/tool/pull/7#issuecomment-1",
            },
            inline: {
              comments: [
                {
                  findingId: "finding_1",
                  severity: "major",
                  path: "src/index.ts",
                  line: 2,
                  body: "inline",
                  fingerprint: "finding_1:src/index.ts:2",
                },
              ],
              skipped: [],
              reviewId: 2,
              url: "https://github.com/acme/tool/pull/7#pullrequestreview-2",
            },
            triageLabel: null,
          };
        },
      }),
    );

    const run = await workflow.reviewPullRequest({
      repoRoot: "/repo",
      pullNumber: 7,
      model: {
        provider: "codex",
        consent: { repositoryContentTransfer: true },
      },
      publication: { mode: "publish" },
    });

    expect(run.target).toEqual({
      owner: "acme",
      repo: "tool",
      pullNumber: 7,
      url: "https://github.com/acme/tool/pull/7",
      baseSha: "base-sha",
      headSha: "head-sha",
    });
    expect(run.publication.mode).toBe("published");
    expect(run.diagnostics.promptContextPaths).toEqual(["AGENTS.md"]);
    expect(run.diagnostics.changedFileCount).toBe(1);
    expect(run.diagnostics.skippedFiles).toEqual([
      { path: "dist/bundle.js", reason: "filtered" },
    ]);
    expect(published).toHaveLength(1);
    expect(published[0]).toEqual(
      expect.objectContaining({
        options: {
          summary: true,
          inline: { cap: 5 },
          triageLabel: false,
        },
      }),
    );
  });

  it("plans publication without GitHub writes", async () => {
    let publishCalled = false;
    const workflow = createPullRequestReviewWorkflow(
      createDeps({
        async plan(input) {
          return {
            summary: {
              action: "create",
              body: input.markdown,
              existingCommentId: null,
            },
            inline: {
              comments: [],
              skipped: [{ findingId: "finding", reason: "duplicate" }],
            },
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
          throw new Error("publish should not be called");
        },
      }),
    );

    const run = await workflow.reviewPullRequest({
      repoRoot: "/repo",
      pullNumber: 7,
      model: {
        provider: "codex",
        consent: { repositoryContentTransfer: true },
      },
      publication: {
        mode: "plan",
        options: {
          summary: true,
          inline: { cap: 2 },
          triageLabel: { apply: true },
        },
      },
    });

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

  it.each([
    ["draft", { isDraft: true }, "PR is draft"],
    ["merge conflict", { mergeable: "CONFLICTING" }, "PR has merge conflicts"],
    [
      "dirty merge state",
      { mergeStateStatus: "DIRTY" },
      "merge state is dirty",
    ],
    [
      "requested changes",
      { reviewDecision: "CHANGES_REQUESTED" },
      "changes are requested",
    ],
    [
      "failing check",
      {
        checkStatuses: [
          {
            name: "Tests",
            status: "COMPLETED",
            conclusion: "FAILURE",
            url: "https://example.test/check",
          },
        ],
      },
      "blocking checks: Tests",
    ],
  ] as const)(
    "refuses ready-for-review label publication when PR state is blocked by %s",
    async (_name, blockedInput, expectedReason) => {
      let publisherCalled = false;
      const workflow = createPullRequestReviewWorkflow(
        createDeps({
          reviewInput: {
            ...reviewInput(),
            ...blockedInput,
          },
          async publish() {
            publisherCalled = true;
            throw new Error("publish should not be called");
          },
        }),
      );

      await expect(
        workflow.reviewPullRequest({
          repoRoot: "/repo",
          pullNumber: 7,
          model: {
            provider: "codex",
            consent: { repositoryContentTransfer: true },
          },
          publication: {
            mode: "publish",
            options: {
              triageLabel: {
                apply: true,
                createMissingLabels: true,
              },
            },
          },
        }),
      ).rejects.toThrow(expectedReason);
      expect(publisherCalled).toBe(false);
    },
  );

  it("passes prompt context into review generation", async () => {
    const workflow = createPullRequestReviewWorkflow(createDeps());

    const run = await workflow.reviewPullRequest({
      repoRoot: "/repo",
      pullNumber: 7,
      model: {
        provider: "codex",
        consent: { repositoryContentTransfer: true },
      },
      publication: {
        mode: "publish",
        options: {
          summary: false,
          inline: false,
        },
      },
    });

    expect(run.diagnostics.promptContextPaths).toEqual(["AGENTS.md"]);
    expect(observedPrompts).toHaveLength(1);
    expect(observedPrompts[0].user).toContain(
      "Run focused tests before finishing.",
    );
  });

  it("writes markdown output through the output port except in plan mode", async () => {
    const writes: Array<{ repoRoot: string; path: string; markdown: string }> =
      [];
    const workflow = createPullRequestReviewWorkflow(
      createDeps({
        output: {
          async writeMarkdown(input) {
            writes.push(input);
          },
        },
      }),
    );

    const published = await workflow.reviewPullRequest({
      repoRoot: "/repo",
      pullNumber: 7,
      model: {
        provider: "codex",
        consent: { repositoryContentTransfer: true },
      },
      publication: {
        mode: "publish",
        options: { summary: false, inline: false },
      },
      output: { markdownPath: ".open-maintainer/review.md" },
    });
    const planned = await workflow.reviewPullRequest({
      repoRoot: "/repo",
      pullNumber: 7,
      model: {
        provider: "codex",
        consent: { repositoryContentTransfer: true },
      },
      publication: {
        mode: "plan",
        options: { summary: false, inline: false },
      },
      output: { markdownPath: ".open-maintainer/review.md" },
    });

    expect(published.output).toEqual({
      markdownPath: ".open-maintainer/review.md",
      written: true,
    });
    expect(planned.output).toEqual({
      markdownPath: ".open-maintainer/review.md",
      written: false,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(
      expect.objectContaining({
        repoRoot: "/repo",
        path: ".open-maintainer/review.md",
      }),
    );
    expect(writes[0].markdown).toContain("## OpenMaintainer Review #7");
  });

  it("requires explicit repository-content transfer consent", async () => {
    const workflow = createPullRequestReviewWorkflow(createDeps());

    await expect(
      workflow.reviewPullRequest({
        repoRoot: "/repo",
        pullNumber: 7,
        model: {
          provider: "codex",
          consent: { repositoryContentTransfer: false },
        } as never,
      }),
    ).rejects.toThrow("explicit repository-content transfer consent");
  });
});

describe("review orchestrator", () => {
  beforeEach(() => {
    observedPrompts.length = 0;
  });

  it("reviews prepared input through prompt, model, markdown, and output ports", async () => {
    const writes: Array<{ path: string; markdown: string }> = [];
    const orchestrator = createReviewOrchestrator({
      sources: {
        async prepareLocal() {
          throw new Error("prepared reviews should not call source ports");
        },
      },
      promptContext: {
        async load() {
          return {
            context: { agentsMd: "Prepared review context." },
            paths: ["AGENTS.md"],
          };
        },
      },
      modelProviders: {
        resolve() {
          return { providerConfig, provider };
        },
      },
      output: {
        async writeMarkdown(input) {
          writes.push({ path: input.path, markdown: input.markdown });
        },
      },
    });

    const run = await orchestrator.review({
      repository: {
        kind: "prepared",
        profile: repoProfile(),
        input: reviewInput(),
        repoRoot: "/repo",
      },
      model: { providerConfig, provider },
      intent: "preview",
      output: { markdownPath: ".open-maintainer/review.md" },
      publication: false,
    });

    expect(run.output).toEqual({
      markdownPath: ".open-maintainer/review.md",
      written: false,
    });
    expect(writes).toHaveLength(0);
    expect(run.markdown).toContain("## OpenMaintainer Review #7");
    expect(run.diagnostics.promptContextPaths).toEqual(["AGENTS.md"]);
    expect(observedPrompts[0].user).toContain("Prepared review context.");
  });

  it("prepares stored API previews and persists review run state", async () => {
    const storedReviews: string[] = [];
    const orchestrator = createReviewOrchestrator({
      sources: {
        async prepareLocal() {
          throw new Error(
            "API preview should not use local source preparation",
          );
        },
        async prepareStored(input) {
          expect(input.repoId).toBe("repo_1");
          expect(input.target).toEqual({
            kind: "pullRequest",
            number: 7,
            baseRef: "main",
            headRef: "feature",
          });
          return {
            profile: repoProfile(),
            input: reviewInput(),
            repoRoot: "/repo",
          };
        },
      },
      modelProviders: {
        resolve() {
          return { providerConfig, provider };
        },
      },
      persistence: {
        async startRun() {
          return runRecord("running");
        },
        async succeedRun(input) {
          return {
            ...input.run,
            status: "succeeded",
            externalId: input.review.id,
          };
        },
        async failRun(input) {
          return { ...input.run, status: "failed" };
        },
        async storeReview(input) {
          storedReviews.push(input.review.id);
        },
      },
    });

    const run = await orchestrator.review({
      repository: { kind: "stored", repoId: "repo_1" },
      target: {
        kind: "pullRequest",
        number: 7,
        baseRef: "main",
        headRef: "feature",
      },
      model: { providerId: "provider_1" },
      intent: "preview",
      publication: false,
      persistence: { run: true, review: true },
    });

    expect(run.persistence.run?.status).toBe("succeeded");
    expect(run.persistence.run?.externalId).toBe(run.review.id);
    expect(storedReviews).toEqual([run.review.id]);
  });

  it("marks persisted runs failed when model resolution fails", async () => {
    const orchestrator = createReviewOrchestrator({
      sources: {
        async prepareLocal() {
          return {
            profile: repoProfile(),
            input: reviewInput(),
            repoRoot: "/repo",
          };
        },
      },
      modelProviders: {
        resolve() {
          throw new Error("provider unavailable");
        },
      },
      persistence: {
        async startRun() {
          return runRecord("running");
        },
        async succeedRun(input) {
          return input.run;
        },
        async failRun(input) {
          return {
            ...input.run,
            status: "failed",
            safeMessage:
              input.error instanceof Error ? input.error.message : null,
          };
        },
        async storeReview() {
          throw new Error("review should not be stored after model failure");
        },
      },
    });

    await expect(
      orchestrator.review({
        repository: { kind: "local", repoRoot: "/repo" },
        model: { providerId: "provider_1" },
        persistence: { run: true, review: true },
      }),
    ).rejects.toMatchObject({
      name: "ReviewOrchestratorError",
      run: expect.objectContaining({
        status: "failed",
        safeMessage: "provider unavailable",
      }),
    } satisfies Partial<ReviewOrchestratorError>);
  });

  it("rejects consent-gated model selections before source preparation", async () => {
    let sourceCalled = false;
    const orchestrator = createReviewOrchestrator({
      sources: {
        async prepareLocal() {
          sourceCalled = true;
          throw new Error("source should not be prepared");
        },
      },
      modelProviders: {
        resolve() {
          throw new Error("model should not be resolved");
        },
      },
    });

    await expect(
      orchestrator.review({
        repository: { kind: "local", repoRoot: "/repo" },
        model: {
          provider: "codex",
          consent: { repositoryContentTransfer: false },
        } as never,
      }),
    ).rejects.toThrow("explicit repository-content transfer consent");
    expect(sourceCalled).toBe(false);
  });
});

describe("review operation boundary", () => {
  beforeEach(() => {
    observedPrompts.length = 0;
  });

  it("prepares an evidence-backed case without invoking model providers", async () => {
    let modelCalled = false;
    const pipeline = createReviewPipeline(
      createReviewOperationDeps(
        createWorkflowDeps({
          local: {
            async assembleDiff(input) {
              return reviewInput({
                prNumber: null,
                baseRef: input.baseRef,
                headRef: input.headRef,
              });
            },
          },
          modelProviders: {
            resolve() {
              modelCalled = true;
              return { providerConfig, provider };
            },
          },
        }),
      ),
    );

    const prepared = await pipeline.prepareCase({
      source: { kind: "local", repoRoot: "/repo" },
      target: { kind: "diff", baseRef: "main", headRef: "HEAD" },
      model: {
        kind: "cli",
        provider: "codex",
        consent: operationConsent("cli-flag"),
      },
      mode: "preview",
    });

    expect(modelCalled).toBe(false);
    expect(prepared.source.input.prNumber).toBeNull();
    expect(prepared.target).toBeNull();
    expect(prepared.promptContext.paths).toEqual(["AGENTS.md"]);
    expect(prepared.precheck.walkthrough).toEqual([
      "modified src/index.ts (+1/-1)",
    ]);
    expect(prepared.evidence).toEqual(
      expect.objectContaining({
        version: 1,
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "patch:1",
            kind: "patch",
            path: "src/index.ts",
          }),
          expect.objectContaining({
            id: "context:agents-md",
            kind: "agents_md",
          }),
        ]),
      }),
    );
    expect(prepared.provenance).toEqual(
      expect.objectContaining({
        sourceKind: "local",
        adapter: "local-diff",
      }),
    );
    expect(prepared.diagnostics).toEqual({
      changedFileCount: 1,
      skippedFiles: [{ path: "dist/bundle.js", reason: "filtered" }],
      promptContextPaths: ["AGENTS.md"],
      warnings: [],
      sourceFallbacks: [],
    });
  });

  it("normalizes local pull request metadata into prepared cases", async () => {
    const assembleCalls: Array<{ baseRef: string; headRef: string }> = [];
    const pipeline = createReviewPipeline(
      createReviewOperationDeps({
        local: {
          async prepareProfile() {
            return repoProfile();
          },
          async detectDefaultBranch() {
            return "main";
          },
          async assembleDiff(input) {
            assembleCalls.push({
              baseRef: input.baseRef,
              headRef: input.headRef,
            });
            return reviewInput({
              prNumber: null,
              owner: "local",
              repo: "local",
              isDraft: null,
              baseRef: input.baseRef,
              headRef: input.headRef,
            });
          },
          async fetchPullRequestMetadata(input) {
            return {
              number: input.prNumber,
              owner: "acme",
              repo: "tool",
              title: "Metadata PR",
              body: "Validation: bun test",
              url: "https://github.com/acme/tool/pull/7",
              author: "maintainer",
              isDraft: true,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              reviewDecision: "REVIEW_REQUIRED",
              baseRef: "origin/main",
              headRef: "refs/remotes/open-maintainer/pr-7",
              baseSha: "metadata-base",
              headSha: "metadata-head",
              checkStatuses: [],
              existingComments: [],
            };
          },
        },
        modelProviders: {
          resolve() {
            return { providerConfig, provider };
          },
        },
      }),
    );

    const prepared = await pipeline.prepareCase({
      source: { kind: "local", repoRoot: "/repo" },
      target: { kind: "pullRequest", number: 7 },
      model: {
        kind: "cli",
        provider: "codex",
        consent: operationConsent("cli-flag"),
      },
      mode: "preview",
    });

    expect(assembleCalls).toEqual([
      {
        baseRef: "origin/main",
        headRef: "refs/remotes/open-maintainer/pr-7",
      },
    ]);
    expect(prepared.source.input).toEqual(
      expect.objectContaining({
        owner: "acme",
        repo: "tool",
        prNumber: 7,
        title: "Metadata PR",
        isDraft: true,
        baseSha: "metadata-base",
        headSha: "metadata-head",
      }),
    );
    expect(prepared.target).toEqual(
      expect.objectContaining({
        owner: "acme",
        repo: "tool",
        pullNumber: 7,
        baseSha: "metadata-base",
        headSha: "metadata-head",
      }),
    );
    expect(prepared.provenance.adapter).toBe("local-pull-request-metadata");
  });

  it("rejects missing repository-content consent before source preparation", async () => {
    let sourceCalled = false;
    const operation = createReviewOperation(
      createReviewOperationDeps(
        createWorkflowDeps({
          local: {
            async assembleDiff() {
              sourceCalled = true;
              return reviewInput();
            },
          },
        }),
      ),
    );

    const result = await operation.run({
      source: { kind: "local", repoRoot: "/repo" },
      model: {
        kind: "cli",
        provider: "codex",
        consent: { repositoryContentTransfer: false } as never,
      },
      mode: "preview",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        phase: "consent",
        statusCode: 403,
      }),
    );
    expect(sourceCalled).toBe(false);
  });

  it("previews the common local diff path through one operation boundary", async () => {
    const assembleCalls: Array<{ baseRef: string; headRef: string }> = [];
    const operation = createReviewOperation(
      createReviewOperationDeps(
        createWorkflowDeps({
          local: {
            async assembleDiff(input) {
              assembleCalls.push({
                baseRef: input.baseRef,
                headRef: input.headRef,
              });
              return reviewInput();
            },
          },
        }),
      ),
    );

    const result = await operation.previewLocalDiff({
      repoRoot: "/repo",
      model: {
        kind: "cli",
        provider: "codex",
        consent: operationConsent("cli-flag"),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(assembleCalls).toEqual([{ baseRef: "main", headRef: "HEAD" }]);
    expect(result.run.output).toBeNull();
    expect(result.run.publication).toEqual({ mode: "skipped" });
    expect(result.run.diagnostics.promptContextPaths).toEqual(["AGENTS.md"]);
  });

  it("rejects empty sources before model invocation", async () => {
    let modelCalled = false;
    const operation = createReviewOperation(
      createReviewOperationDeps(
        createWorkflowDeps({
          local: {
            async assembleDiff() {
              return { ...reviewInput(), changedFiles: [] };
            },
          },
          modelProviders: {
            resolve() {
              modelCalled = true;
              return { providerConfig, provider };
            },
          },
        }),
      ),
    );

    const result = await operation.previewLocalDiff({
      repoRoot: "/repo",
      model: {
        kind: "cli",
        provider: "codex",
        consent: operationConsent("cli-flag"),
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        phase: "source",
        statusCode: 422,
      }),
    );
    expect(modelCalled).toBe(false);
  });

  it("plans publication and markdown output without write ports in preview mode", async () => {
    let publishCalled = false;
    let outputCalled = false;
    const operation = createReviewOperation(
      createReviewOperationDeps(
        createWorkflowDeps({
          publisher: {
            async plan() {
              return {
                summary: {
                  action: "create",
                  body: "planned summary",
                  existingCommentId: null,
                },
                inline: { comments: [], skipped: [] },
                triageLabel: null,
              };
            },
            async publish() {
              publishCalled = true;
              throw new Error("publish should not run in plan mode");
            },
          },
          output: {
            async writeMarkdown() {
              outputCalled = true;
              throw new Error("output should not be written in preview mode");
            },
          },
        }),
      ),
    );

    const result = await operation.run({
      source: {
        kind: "local",
        repoRoot: "/repo",
        target: { kind: "pullRequest", number: 7 },
      },
      model: {
        kind: "cli",
        provider: "codex",
        consent: operationConsent("cli-flag"),
      },
      mode: "preview",
      publish: {
        mode: "plan",
        summary: true,
        inline: false,
      },
      output: { markdownPath: ".open-maintainer/review.md" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.run.publication).toEqual(
      expect.objectContaining({ mode: "planned" }),
    );
    expect(result.run.output).toEqual({
      markdownPath: ".open-maintainer/review.md",
      written: false,
    });
    expect(publishCalled).toBe(false);
    expect(outputCalled).toBe(false);
  });

  it("writes markdown through the operation output port in apply mode", async () => {
    const writes: Array<{ repoRoot: string; path: string }> = [];
    const operation = createReviewOperation(
      createReviewOperationDeps(
        createWorkflowDeps({
          output: {
            async writeMarkdown(input) {
              writes.push({ repoRoot: input.repoRoot, path: input.path });
            },
          },
        }),
      ),
    );

    const result = await operation.run({
      source: {
        kind: "prepared",
        profile: repoProfile(),
        input: reviewInput(),
        repoRoot: "/repo",
      },
      model: {
        kind: "resolved",
        providerConfig,
        provider,
        consent: operationConsent("cli-flag"),
      },
      mode: "apply",
      output: { markdownPath: ".open-maintainer/review.md" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.run.output).toEqual({
      markdownPath: ".open-maintainer/review.md",
      written: true,
    });
    expect(writes).toEqual([
      { repoRoot: "/repo", path: ".open-maintainer/review.md" },
    ]);
  });

  it("returns persisted stored preview run state through the operation result", async () => {
    const storedReviews: string[] = [];
    const operation = createReviewOperation(
      createReviewOperationDeps(
        createWorkflowDeps({
          stored: {
            async prepareReview(input) {
              expect(input).toEqual(
                expect.objectContaining({
                  repoId: "repo_1",
                  target: { kind: "pullRequest", number: 7 },
                }),
              );
              return {
                profile: repoProfile(),
                input: reviewInput(),
                repoRoot: "/repo",
              };
            },
          },
          persistence: {
            async startRun() {
              return runRecord("running");
            },
            async succeedRun(input) {
              return {
                ...input.run,
                status: "succeeded",
                externalId: input.review.id,
              };
            },
            async failRun(input) {
              return { ...input.run, status: "failed" };
            },
            async storeReview(input) {
              storedReviews.push(input.review.id);
            },
          },
        }),
      ),
    );

    const result = await operation.run({
      source: {
        kind: "stored",
        repoId: "repo_1",
        target: { kind: "pullRequest", number: 7 },
      },
      model: {
        kind: "stored-provider",
        providerId: "provider_1",
        consent: operationConsent("dashboard-provider"),
      },
      mode: "preview",
      publish: false,
      persist: { run: true, review: true },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.run.persistence.run?.status).toBe("succeeded");
    expect(storedReviews).toEqual([result.run.review.id]);
  });

  it("returns failed persisted run state on model errors", async () => {
    const operation = createReviewOperation(
      createReviewOperationDeps(
        createWorkflowDeps({
          stored: {
            async prepareReview() {
              return {
                profile: repoProfile(),
                input: reviewInput(),
                repoRoot: "/repo",
              };
            },
          },
          persistence: {
            async startRun() {
              return runRecord("running");
            },
            async succeedRun(input) {
              return input.run;
            },
            async failRun(input) {
              return {
                ...input.run,
                status: "failed",
                safeMessage:
                  input.error instanceof Error ? input.error.message : null,
              };
            },
            async storeReview() {
              throw new Error(
                "review should not be stored after model failure",
              );
            },
          },
          modelProviders: {
            resolve() {
              throw new Error("provider unavailable");
            },
          },
        }),
      ),
    );

    const result = await operation.run({
      source: { kind: "stored", repoId: "repo_1" },
      model: {
        kind: "stored-provider",
        providerId: "provider_1",
        consent: operationConsent("dashboard-provider"),
      },
      mode: "preview",
      persist: { run: true, review: true },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        phase: "model",
        run: expect.objectContaining({
          status: "failed",
          safeMessage: "provider unavailable",
        }),
      }),
    );
  });

  it("reports prompt-context failures with failed persisted run state", async () => {
    const operation = createReviewOperation(
      createReviewOperationDeps(
        createWorkflowDeps({
          stored: {
            async prepareReview() {
              return {
                profile: repoProfile(),
                input: reviewInput(),
                repoRoot: "/repo",
              };
            },
          },
          promptContext: {
            async resolve() {
              throw new Error("context unavailable");
            },
          },
          persistence: {
            async startRun() {
              return runRecord("running");
            },
            async succeedRun(input) {
              return input.run;
            },
            async failRun(input) {
              return {
                ...input.run,
                status: "failed",
                safeMessage:
                  input.error instanceof Error ? input.error.message : null,
              };
            },
            async storeReview() {
              throw new Error(
                "review should not be stored after prompt failure",
              );
            },
          },
        }),
      ),
    );

    const result = await operation.run({
      source: { kind: "stored", repoId: "repo_1" },
      model: {
        kind: "stored-provider",
        providerId: "provider_1",
        consent: operationConsent("dashboard-provider"),
      },
      mode: "preview",
      persist: { run: true, review: true },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        phase: "prompt-context",
        run: expect.objectContaining({
          status: "failed",
          safeMessage: "context unavailable",
        }),
      }),
    );
  });

  it("returns publication failures before publisher writes", async () => {
    let publishCalled = false;
    const operation = createReviewOperation(
      createReviewOperationDeps(
        createWorkflowDeps({
          local: {
            async fetchPullRequest() {
              return { ...reviewInput(), isDraft: true };
            },
          },
          publisher: {
            async plan() {
              throw new Error("plan should not run");
            },
            async publish() {
              publishCalled = true;
              throw new Error("publish should not run");
            },
          },
        }),
      ),
    );

    const result = await operation.publishPullRequest({
      repoRoot: "/repo",
      prNumber: 7,
      model: {
        kind: "cli",
        provider: "codex",
        consent: operationConsent("cli-flag"),
      },
      publish: {
        triageLabel: { apply: true },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        phase: "publication",
      }),
    );
    expect(publishCalled).toBe(false);
  });
});

describe("review workflow facade", () => {
  beforeEach(() => {
    observedPrompts.length = 0;
  });

  it("rejects local reviews without repository-content consent before source preparation", async () => {
    let sourceCalled = false;
    const workflow = createReviewWorkflow(
      createWorkflowDeps({
        local: {
          async assembleDiff() {
            sourceCalled = true;
            return reviewInput();
          },
        },
      }),
    );

    await expect(
      workflow.reviewLocal({
        repoRoot: "/repo",
        model: {
          provider: "codex",
          consent: { repositoryContentTransfer: false },
        } as never,
      }),
    ).rejects.toThrow("explicit repository-content transfer consent");
    expect(sourceCalled).toBe(false);
  });

  it("defaults local diff refs and enriches diff input with profile identity", async () => {
    const assembleCalls: Array<{
      baseRef: string;
      headRef: string;
      owner: string;
      repo: string;
    }> = [];
    const workflow = createReviewWorkflow(
      createWorkflowDeps({
        local: {
          async detectDefaultBranch() {
            return null;
          },
          async assembleDiff(input) {
            assembleCalls.push({
              baseRef: input.baseRef,
              headRef: input.headRef,
              owner: input.profile.owner,
              repo: input.profile.name,
            });
            return reviewInput({ prNumber: null });
          },
        },
      }),
    );

    const run = await workflow.reviewLocal({
      repoRoot: "/repo",
      target: { diff: {} },
      model: {
        provider: "codex",
        consent: { repositoryContentTransfer: true },
      },
      mode: "preview",
    });

    expect(assembleCalls).toEqual([
      { baseRef: "main", headRef: "HEAD", owner: "acme", repo: "tool" },
    ]);
    expect(run.source.input).toEqual(
      expect.objectContaining({
        owner: "acme",
        repo: "tool",
        prNumber: null,
        isDraft: null,
      }),
    );
  });

  it("routes local PR targets through the PR port and preserves publication planning", async () => {
    const planInputs: unknown[] = [];
    const workflow = createReviewWorkflow(
      createWorkflowDeps({
        local: {
          async fetchPullRequest(input) {
            expect(input.prNumber).toBe(7);
            return reviewInput({ prNumber: input.prNumber });
          },
        },
        publisher: {
          async plan(input) {
            planInputs.push(input);
            return {
              summary: {
                action: "create",
                body: input.markdown,
                existingCommentId: null,
              },
              inline: { comments: [], skipped: [] },
              triageLabel: null,
            };
          },
          async publish() {
            throw new Error("publish should not run in plan mode");
          },
        },
      }),
    );

    const run = await workflow.reviewLocal({
      repoRoot: "/repo",
      target: { pr: 7 },
      model: {
        provider: "codex",
        consent: { repositoryContentTransfer: true },
      },
      publish: {
        mode: "plan",
        summary: true,
        inline: false,
      },
    });

    expect(run.publication).toEqual(
      expect.objectContaining({ mode: "planned" }),
    );
    expect(planInputs).toHaveLength(1);
  });

  it("previews stored reviews with persistence through the package boundary", async () => {
    const storedReviews: string[] = [];
    const workflow = createReviewWorkflow(
      createWorkflowDeps({
        stored: {
          async prepareReview(input) {
            expect(input).toEqual(
              expect.objectContaining({
                repoId: "repo_1",
                target: {
                  kind: "pullRequest",
                  number: 7,
                  baseRef: "main",
                  headRef: "feature",
                },
              }),
            );
            return {
              profile: repoProfile(),
              input: reviewInput(),
              repoRoot: "/repo",
            };
          },
        },
        persistence: {
          async startRun() {
            return runRecord("running");
          },
          async succeedRun(input) {
            return {
              ...input.run,
              status: "succeeded",
              externalId: input.review.id,
            };
          },
          async failRun(input) {
            return { ...input.run, status: "failed" };
          },
          async storeReview(input) {
            storedReviews.push(input.review.id);
          },
        },
      }),
    );

    const run = await workflow.previewStored({
      repoId: "repo_1",
      modelProviderId: "provider_1",
      target: { pr: 7, baseRef: "main", headRef: "feature" },
    });

    expect(run.persistence.run?.status).toBe("succeeded");
    expect(run.persistence.run?.externalId).toBe(run.review.id);
    expect(storedReviews).toEqual([run.review.id]);
  });

  it("plans output without writing in preview and writes when apply semantics allow it", async () => {
    const writes: Array<{ path: string; markdown: string }> = [];
    const workflow = createReviewWorkflow(
      createWorkflowDeps({
        output: {
          async writeMarkdown(input) {
            writes.push({ path: input.path, markdown: input.markdown });
          },
        },
      }),
    );

    const preview = await workflow.reviewPrepared({
      profile: repoProfile(),
      input: reviewInput(),
      repoRoot: "/repo",
      model: { providerConfig, provider },
      mode: "preview",
      output: { markdownPath: ".open-maintainer/review.md" },
      publish: false,
    });
    const apply = await workflow.reviewPrepared({
      profile: repoProfile(),
      input: reviewInput(),
      repoRoot: "/repo",
      model: { providerConfig, provider },
      mode: "apply",
      output: { markdownPath: ".open-maintainer/review.md" },
    });

    expect(preview.output).toEqual({
      markdownPath: ".open-maintainer/review.md",
      written: false,
    });
    expect(apply.output).toEqual({
      markdownPath: ".open-maintainer/review.md",
      written: true,
    });
    expect(writes).toHaveLength(1);
  });
});

function createDeps(
  overrides: {
    reviewInput?: ReviewInput;
    plan?: PullRequestReviewWorkflowDeps["publisher"]["plan"];
    publish?: PullRequestReviewWorkflowDeps["publisher"]["publish"];
    output?: PullRequestReviewWorkflowDeps["output"];
  } = {},
): PullRequestReviewWorkflowDeps {
  return {
    repoProfile: {
      async load() {
        return repoProfile();
      },
    },
    pullRequests: {
      async fetchReviewInput() {
        return overrides.reviewInput ?? reviewInput();
      },
    },
    promptContext: {
      async load() {
        return {
          context: { agentsMd: "Run focused tests before finishing." },
          paths: ["AGENTS.md"],
        };
      },
    },
    modelProviders: {
      create() {
        return { providerConfig, provider };
      },
    },
    publisher: {
      async plan(input) {
        if (overrides.plan) {
          return overrides.plan(input);
        }
        return {
          summary: {
            action: "create",
            body: input.markdown,
            existingCommentId: null,
          },
          inline: { comments: [], skipped: [] },
          triageLabel: null,
        };
      },
      async publish(input) {
        if (overrides.publish) {
          return overrides.publish(input);
        }
        return {
          summary: null,
          inline: null,
          triageLabel: null,
        };
      },
    },
    ...(overrides.output ? { output: overrides.output } : {}),
  };
}

function createWorkflowDeps(
  overrides: {
    local?: Partial<NonNullable<ReviewWorkflowDeps["local"]>>;
    stored?: ReviewWorkflowDeps["stored"];
    publisher?: ReviewWorkflowDeps["publisher"];
    output?: ReviewWorkflowDeps["output"];
    persistence?: ReviewWorkflowDeps["persistence"];
    modelProviders?: ReviewWorkflowDeps["modelProviders"];
    promptContext?: ReviewWorkflowDeps["promptContext"];
  } = {},
): ReviewWorkflowDeps {
  return {
    local: {
      prepareProfile:
        overrides.local?.prepareProfile ??
        (async () => {
          return repoProfile();
        }),
      detectDefaultBranch:
        overrides.local?.detectDefaultBranch ??
        (async () => {
          return "main";
        }),
      async assembleDiff(input) {
        if (overrides.local?.assembleDiff) {
          return overrides.local.assembleDiff(input);
        }
        return reviewInput({ prNumber: null });
      },
      async fetchPullRequest(input) {
        if (overrides.local?.fetchPullRequest) {
          return overrides.local.fetchPullRequest(input);
        }
        return reviewInput({ prNumber: input.prNumber });
      },
    },
    ...(overrides.stored ? { stored: overrides.stored } : {}),
    promptContext: overrides.promptContext ?? {
      async resolve() {
        return {
          context: { agentsMd: "Workflow prompt context." },
          paths: ["AGENTS.md"],
        };
      },
    },
    modelProviders: overrides.modelProviders ?? {
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
    ...(overrides.output ? { output: overrides.output } : {}),
    ...(overrides.persistence ? { persistence: overrides.persistence } : {}),
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

function reviewInput(): ReviewInput {
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
  };
}

function operationConsent(
  grantedBy: "cli-flag" | "dashboard-provider" | "github-action-input",
) {
  return {
    repositoryContentTransfer: true as const,
    grantedBy,
    grantedAt: "2026-05-04T00:00:00.000Z",
  };
}

function runRecord(status: "running" | "succeeded" | "failed") {
  return {
    id: "run_1",
    repoId: "repo_1",
    type: "review" as const,
    status,
    inputSummary: "Review acme/tool main...feature.",
    safeMessage: null,
    artifactVersions: [],
    repoProfileVersion: 1,
    provider: "Test Provider",
    model: "gpt-test",
    externalId: null,
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
  };
}
