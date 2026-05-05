import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assertProviderConsent,
  buildProvider as buildAiProvider,
} from "@open-maintainer/ai";
import type { MemoryStore } from "@open-maintainer/db";
import {
  type GitHubAppInstallationAuth,
  fetchPullRequestReviewContext,
} from "@open-maintainer/github";
import {
  ReviewOrchestratorError,
  ReviewWorkflowSourceError,
  assembleLocalReviewInput,
  createReviewOperation,
  createReviewOperationDeps,
  createStoredProviderReviewOperationModelRequest,
  loadReviewPromptContext,
  reviewOperationTargetFromShortcut,
} from "@open-maintainer/review";
import type { ReviewOperationDeps } from "@open-maintainer/review";
import type {
  ModelProviderConfig,
  Repo,
  RepoProfile,
  ReviewInput,
  ReviewResult,
  RunRecord,
} from "@open-maintainer/shared";
import {
  contextArtifactPathsForTargets,
  nowIso,
} from "@open-maintainer/shared";
import { z } from "zod";
import type { RepositorySourceLifecycle } from "./repository-source-analysis";

const execFileAsync = promisify(execFile);

export type DashboardReviewPreviewInput = {
  repoId: string;
  baseRef?: string;
  headRef?: string;
  prNumber?: number;
  providerId?: string;
};

export type DashboardReviewPreviewResult =
  | {
      ok: true;
      run: RunRecord | null;
      review: ReviewResult;
    }
  | {
      ok: false;
      statusCode: 403 | 404 | 409 | 422;
      error: string;
      run: RunRecord | null;
    };

export type DashboardReviewService = {
  preview(
    input: DashboardReviewPreviewInput,
  ): Promise<DashboardReviewPreviewResult>;
};

export type DashboardReviewCommandRunner = (input: {
  tool: "gh";
  command: string;
  args: string[];
  cwd: string;
}) => Promise<string>;

export function createDashboardReviewService(input: {
  store: MemoryStore;
  repositorySources: RepositorySourceLifecycle;
  getInstallationAuth?: (
    installationId: string,
  ) => GitHubAppInstallationAuth | null;
  runCommand?: DashboardReviewCommandRunner;
  buildProvider?: typeof buildAiProvider;
}): DashboardReviewService {
  const runCommand = input.runCommand ?? defaultReviewCommandRunner;
  const buildProvider = input.buildProvider ?? buildAiProvider;

  return {
    async preview(request) {
      const repo = input.store.repos.get(request.repoId);
      if (!repo) {
        return {
          ok: false,
          statusCode: 404,
          error: "Unknown repo.",
          run: null,
        };
      }
      const provider = request.providerId
        ? (input.store.providers.get(request.providerId) ?? null)
        : null;
      if (request.providerId && !provider) {
        return {
          ok: false,
          statusCode: 404,
          error: "Unknown model provider.",
          run: null,
        };
      }
      if (!provider) {
        return {
          ok: false,
          statusCode: 403,
          error:
            "Review preview requires an explicit model provider with repo-content consent.",
          run: null,
        };
      }
      try {
        assertProviderConsent(provider);
      } catch (error) {
        return {
          ok: false,
          statusCode: 403,
          error:
            error instanceof Error
              ? error.message
              : "Review generation blocked.",
          run: null,
        };
      }

      const operation = createReviewOperation(
        createApiReviewOperationDeps({
          repo,
          provider,
          store: input.store,
          repositorySources: input.repositorySources,
          runCommand,
          buildProvider,
          ...(input.getInstallationAuth
            ? { getInstallationAuth: input.getInstallationAuth }
            : {}),
        }),
      );
      try {
        const target = reviewOperationTargetFromShortcut(
          request.prNumber
            ? {
                pr: request.prNumber,
                ...(request.baseRef ? { baseRef: request.baseRef } : {}),
                ...(request.headRef ? { headRef: request.headRef } : {}),
              }
            : {
                diff: {
                  ...(request.baseRef ? { baseRef: request.baseRef } : {}),
                  ...(request.headRef ? { headRef: request.headRef } : {}),
                },
              },
        );
        const result = await operation.run({
          source: {
            kind: "stored",
            repoId: request.repoId,
            ...(target ? { target } : {}),
          },
          model: createStoredProviderReviewOperationModelRequest({
            providerId: provider.id,
            consent: {
              repositoryContentTransfer: true,
              grantedBy: "dashboard-provider",
              grantedAt: nowIso(),
            },
          }),
          mode: "preview",
          publish: false,
          persist: { run: true, review: true },
        });
        if (!result.ok) {
          return {
            ok: false,
            statusCode: result.statusCode ?? 422,
            error: result.error.message,
            run: result.run,
          };
        }
        return {
          ok: true,
          run: result.run.persistence.run,
          review: result.run.review,
        };
      } catch (error) {
        return {
          ok: false,
          statusCode: reviewPreviewStatusCode(error),
          error:
            error instanceof Error
              ? error.message
              : "Unable to generate review preview.",
          run: error instanceof ReviewOrchestratorError ? error.run : null,
        };
      }
    },
  };
}

function createApiReviewOperationDeps(input: {
  repo: Repo;
  repositorySources: RepositorySourceLifecycle;
  provider: ModelProviderConfig;
  store: MemoryStore;
  getInstallationAuth?: (
    installationId: string,
  ) => GitHubAppInstallationAuth | null;
  runCommand: DashboardReviewCommandRunner;
  buildProvider: typeof buildAiProvider;
}): ReviewOperationDeps {
  return createReviewOperationDeps({
    stored: {
      async prepareReview(request) {
        const prepared = await prepareReviewPreviewInput({
          repoId: input.repo.id,
          repo: input.repo,
          repositorySources: input.repositorySources,
          runCommand: input.runCommand,
          ...(input.getInstallationAuth
            ? { getInstallationAuth: input.getInstallationAuth }
            : {}),
          ...(request.target?.baseRef
            ? { baseRef: request.target.baseRef }
            : {}),
          ...(request.target?.headRef
            ? { headRef: request.target.headRef }
            : {}),
          ...(request.target?.kind === "pullRequest"
            ? { prNumber: request.target.number }
            : {}),
        }).catch((error) => ({
          ok: false as const,
          statusCode: 422 as const,
          error:
            error instanceof Error
              ? error.message
              : "Unable to prepare PR review preview.",
        }));
        if (!prepared.ok) {
          throw new ReviewWorkflowSourceError(
            prepared.statusCode,
            prepared.error,
          );
        }
        return {
          profile: prepared.profile,
          input: prepared.reviewInput,
          repoRoot: prepared.worktreeRoot,
        };
      },
    },
    promptContext: {
      async resolve(request) {
        return loadReviewPromptContext({
          profile: request.source.profile,
          worktreeRoot: request.source.repoRoot,
          artifacts: input.store.artifacts.get(input.repo.id) ?? [],
          includeGeneratedInstructionArtifacts: true,
          includeGenericSkillFallbacks: true,
          generatedContextPaths: reviewGeneratedContextPaths(input.repo.name),
          generatedContextSource: "artifacts",
        });
      },
    },
    modelProviders: {
      resolve(request) {
        assertProviderConsent(input.provider);
        return {
          providerConfig: input.provider,
          provider: input.buildProvider(input.provider, {
            ...(request.source.repoRoot
              ? { cwd: request.source.repoRoot }
              : {}),
          }),
        };
      },
    },
    persistence: {
      async startRun(request) {
        return input.store.recordRun({
          repoId: input.repo.id,
          type: "review",
          status: "running",
          inputSummary: `Review ${input.repo.fullName} ${request.source.input.baseRef}...${request.source.input.headRef}.`,
          safeMessage: null,
          artifactVersions: [],
          repoProfileVersion: request.source.profile.version,
          provider: input.provider.displayName,
          model: input.provider.model,
          externalId: null,
        });
      },
      async succeedRun(request) {
        return input.store.updateRun(request.run.id, {
          status: "succeeded",
          safeMessage: `Review preview generated for ${request.source.input.baseRef}...${request.source.input.headRef}.`,
          externalId: request.review.id,
        });
      },
      async failRun(request) {
        return input.store.updateRun(request.run.id, {
          status: "failed",
          safeMessage:
            request.error instanceof Error
              ? request.error.message
              : "Unable to generate review preview.",
        });
      },
      async storeReview(request) {
        input.store.reviews.set(request.review.id, request.review);
      },
    },
  });
}

function reviewGeneratedContextPaths(repoName: string): string[] {
  return contextArtifactPathsForTargets({
    repoName,
    targets: ["report", "claude", "copilot", "cursor"],
  });
}

function reviewPreviewStatusCode(error: unknown): 409 | 422 {
  if (error instanceof ReviewWorkflowSourceError) {
    return error.statusCode;
  }
  return 422;
}

async function prepareReviewPreviewInput(input: {
  repoId: string;
  repo: Repo;
  repositorySources: RepositorySourceLifecycle;
  getInstallationAuth?: (
    installationId: string,
  ) => GitHubAppInstallationAuth | null;
  runCommand: DashboardReviewCommandRunner;
  baseRef?: string;
  headRef?: string;
  prNumber?: number;
}): Promise<
  | {
      ok: true;
      profile: RepoProfile;
      reviewInput: ReviewInput;
      worktreeRoot: string | null;
    }
  | { ok: false; statusCode: 409 | 422; error: string }
> {
  if (input.prNumber) {
    const githubReviewInput = await githubReviewInputForPullRequest(input);
    if (githubReviewInput) {
      if (githubReviewInput.changedFiles.length === 0) {
        return {
          ok: false,
          statusCode: 422,
          error: `No changed files were detected for PR #${input.prNumber}. Check the pull request before creating a review preview.`,
        };
      }
      const workspace = await input.repositorySources.prepare({
        repoId: input.repoId,
        intent: {
          kind: "review-preview",
          baseRef: githubReviewInput.baseRef,
          ...(input.prNumber ? { prNumber: input.prNumber } : {}),
        },
      });
      if (!workspace.ok) {
        return {
          ok: false,
          statusCode:
            workspace.error.statusCode === 404
              ? 409
              : workspace.error.statusCode,
          error: workspace.error.message,
        };
      }
      return {
        ok: true,
        profile: workspace.value.profile,
        reviewInput: githubReviewInput,
        worktreeRoot: workspace.value.worktreeRoot,
      };
    }
  }

  const workspace = await input.repositorySources.prepare({
    repoId: input.repoId,
    intent: {
      kind: "review-preview",
      ...(input.baseRef ? { baseRef: input.baseRef } : {}),
      ...(input.headRef ? { headRef: input.headRef } : {}),
      ...(input.prNumber ? { prNumber: input.prNumber } : {}),
    },
  });
  if (!workspace.ok) {
    return {
      ok: false,
      statusCode:
        workspace.error.statusCode === 404 ? 409 : workspace.error.statusCode,
      error: workspace.error.message,
    };
  }
  const worktreeRoot = workspace.value.worktreeRoot;
  if (!worktreeRoot) {
    return {
      ok: false,
      statusCode: 409,
      error: input.prNumber
        ? "PR number review requires GitHub App credentials or a registered local repository worktree with gh available."
        : "Review preview requires a registered local repository worktree in this release.",
    };
  }

  let localPullRequest: Awaited<
    ReturnType<typeof localPullRequestMetadata>
  > | null = null;
  let localPullRequestError: string | null = null;
  if (input.prNumber) {
    try {
      localPullRequest = await localPullRequestMetadata({
        worktreeRoot,
        prNumber: input.prNumber,
        runCommand: input.runCommand,
      });
    } catch (error) {
      localPullRequestError =
        error instanceof Error ? error.message : "Unable to resolve PR refs.";
    }
  }
  if (input.prNumber && !input.baseRef && !localPullRequest) {
    return {
      ok: false,
      statusCode: 422,
      error:
        `Unable to resolve the base ref for PR #${input.prNumber}. Enter a base ref manually or authenticate gh in the API environment. ${localPullRequestError ?? ""}`.trim(),
    };
  }
  const baseRef =
    input.baseRef ?? localPullRequest?.baseRef ?? input.repo.defaultBranch;
  const headRef = input.headRef ?? "HEAD";
  const localReviewInput = await assembleLocalReviewInput({
    repoRoot: worktreeRoot,
    repoId: input.repoId,
    baseRef,
    headRef,
  });
  if (localReviewInput.changedFiles.length === 0) {
    return {
      ok: false,
      statusCode: 422,
      error: `No changed files were detected for ${baseRef}...${headRef}. Check the base/head refs before creating a review preview.`,
    };
  }

  return {
    ok: true,
    profile: workspace.value.profile,
    reviewInput: {
      ...localReviewInput,
      owner: input.repo.owner,
      repo: input.repo.name,
      prNumber: input.prNumber ?? null,
      title: localPullRequest?.title ?? localReviewInput.title,
      body: localPullRequest?.body ?? localReviewInput.body,
      url: localPullRequest?.url ?? localReviewInput.url,
      author: localPullRequest?.author ?? localReviewInput.author,
      isDraft: localPullRequest?.isDraft ?? localReviewInput.isDraft,
      mergeable: localPullRequest?.mergeable ?? localReviewInput.mergeable,
      mergeStateStatus:
        localPullRequest?.mergeStateStatus ?? localReviewInput.mergeStateStatus,
      reviewDecision:
        localPullRequest?.reviewDecision ?? localReviewInput.reviewDecision,
    },
    worktreeRoot,
  };
}

async function githubReviewInputForPullRequest(input: {
  repoId: string;
  repo: Repo;
  prNumber?: number;
  getInstallationAuth?: (
    installationId: string,
  ) => GitHubAppInstallationAuth | null;
}): Promise<ReviewInput | null> {
  if (!input.prNumber) {
    return null;
  }
  const auth = input.getInstallationAuth?.(input.repo.installationId) ?? null;
  if (!auth) {
    return null;
  }
  return fetchPullRequestReviewContext({
    repoId: input.repoId,
    owner: input.repo.owner,
    repo: input.repo.name,
    pullNumber: input.prNumber,
    auth,
  });
}

async function localPullRequestMetadata(input: {
  worktreeRoot: string;
  prNumber: number;
  runCommand: DashboardReviewCommandRunner;
}): Promise<{
  baseRef: string;
  title: string | null;
  body: string;
  url: string | null;
  author: string | null;
  isDraft: boolean | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
}> {
  const output = await input.runCommand({
    tool: "gh",
    command: process.env.OPEN_MAINTAINER_GH_COMMAND ?? "gh",
    cwd: input.worktreeRoot,
    args: [
      "pr",
      "view",
      String(input.prNumber),
      "--json",
      "baseRefName,title,body,url,author,isDraft,mergeable,mergeStateStatus,reviewDecision",
    ],
  });
  const parsed = z
    .object({
      baseRefName: z.string().min(1),
      title: z.string().nullable().optional(),
      body: z.string().nullable().optional(),
      url: z.string().url().nullable().optional(),
      author: z.object({ login: z.string().nullable().optional() }).optional(),
      isDraft: z.boolean().nullable().optional(),
      mergeable: z.string().nullable().optional(),
      mergeStateStatus: z.string().nullable().optional(),
      reviewDecision: z.string().nullable().optional(),
    })
    .parse(JSON.parse(output));
  return {
    baseRef: parsed.baseRefName,
    title: parsed.title ?? null,
    body: parsed.body ?? "",
    url: parsed.url ?? null,
    author: parsed.author?.login ?? null,
    isDraft: parsed.isDraft ?? null,
    mergeable: parsed.mergeable ?? null,
    mergeStateStatus: parsed.mergeStateStatus ?? null,
    reviewDecision: parsed.reviewDecision ?? null,
  };
}

async function defaultReviewCommandRunner(input: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(input.command, input.args, {
      cwd: input.cwd,
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    });
    return stdout;
  } catch (error) {
    if (error instanceof Error) {
      const execError = error as Error & { stdout?: string; stderr?: string };
      const details = [execError.stderr, execError.stdout, execError.message]
        .filter((part) => typeof part === "string" && part.trim().length > 0)
        .join("\n")
        .trim();
      throw new Error(
        `${input.command} ${input.args.join(" ")} failed: ${details}`,
      );
    }
    throw error;
  }
}
