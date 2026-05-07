import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertProviderConsent, buildProvider } from "@open-maintainer/ai";
import type { MemoryStore } from "@open-maintainer/db";
import {
  type GitHubAppInstallationAuth,
  applyPullRequestLabelsForDashboard,
  fetchPullRequestDetailForDashboard,
  listPullRequestsForDashboard,
} from "@open-maintainer/github";
import { assembleLocalReviewInput } from "@open-maintainer/review";
import type {
  PullRequestCommit,
  PullRequestDetail,
  PullRequestListItem,
  PullRequestTimelineItem,
  ReviewChangedFile,
  ReviewCheckStatus,
  RunRecord,
} from "@open-maintainer/shared";
import {
  PullRequestDetailSchema,
  PullRequestListItemSchema,
  inferPullRequestTriageTags,
} from "@open-maintainer/shared";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export type PullRequestListState = "open" | "closed" | "all";
export type PullRequestListSort = "updated" | "created" | "number";
export type PullRequestListDirection = "asc" | "desc";

export type DashboardPullRequestServiceResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      statusCode: 403 | 404 | 409 | 422 | 502;
      error: string;
    };

export type DashboardPullRequestCommandRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
}) => Promise<string>;

export type DashboardPullRequestService = {
  list(input: {
    repoId: string;
    state?: PullRequestListState;
    search?: string;
    sort?: PullRequestListSort;
    direction?: PullRequestListDirection;
  }): Promise<
    DashboardPullRequestServiceResult<{
      pullRequests: PullRequestListItem[];
      source: "github-app" | "local-gh";
    }>
  >;
  detail(input: {
    repoId: string;
    pullNumber: number;
  }): Promise<
    DashboardPullRequestServiceResult<{
      pullRequest: PullRequestDetail;
      source: "github-app" | "local-gh";
    }>
  >;
  triage(input: {
    repoId: string;
    providerId?: string;
    pullNumbers: number[];
  }): Promise<
    DashboardPullRequestServiceResult<{
      run: RunRecord;
      results: PullRequestTriageApplyResult[];
      source: "github-app" | "local-gh";
    }>
  >;
};

type PullRequestTriageApplyResult = {
  number: number;
  title: string | null;
  labels: string[];
  appliedLabels: string[];
  reason: string;
  status: "labeled" | "no_labels" | "failed";
  error?: string;
};

export function createDashboardPullRequestService(input: {
  store: MemoryStore;
  getInstallationAuth: (
    installationId: string,
  ) => GitHubAppInstallationAuth | null;
  runCommand?: DashboardPullRequestCommandRunner;
}): DashboardPullRequestService {
  const runCommand = input.runCommand ?? defaultPullRequestCommandRunner;

  return {
    async list(request) {
      const repo = input.store.repos.get(request.repoId);
      if (!repo) {
        return serviceError(404, "Unknown repo.");
      }
      const auth = input.getInstallationAuth(repo.installationId);
      if (auth) {
        try {
          return {
            ok: true,
            value: {
              pullRequests: await listPullRequestsForDashboard({
                owner: repo.owner,
                repo: repo.name,
                state: request.state ?? "open",
                search: request.search ?? "",
                sort: request.sort ?? "updated",
                direction: request.direction ?? "desc",
                auth,
              }),
              source: "github-app",
            },
          };
        } catch (error) {
          return serviceError(
            422,
            `GitHub pull requests could not be loaded: ${errorMessage(error)}`,
          );
        }
      }

      const worktreeRoot = input.store.repoWorktrees.get(request.repoId);
      if (!worktreeRoot) {
        return serviceError(
          409,
          "Pull request data requires GitHub App credentials or a registered local Git worktree with gh available.",
        );
      }
      try {
        return {
          ok: true,
          value: {
            pullRequests: await listLocalPullRequests({
              repoId: request.repoId,
              worktreeRoot,
              state: request.state ?? "open",
              search: request.search ?? "",
              sort: request.sort ?? "updated",
              direction: request.direction ?? "desc",
              runCommand,
            }),
            source: "local-gh",
          },
        };
      } catch (error) {
        return serviceError(
          422,
          `Local pull requests could not be loaded with gh: ${localGhErrorMessage(error)}`,
        );
      }
    },

    async detail(request) {
      const repo = input.store.repos.get(request.repoId);
      if (!repo) {
        return serviceError(404, "Unknown repo.");
      }
      const auth = input.getInstallationAuth(repo.installationId);
      if (auth) {
        try {
          return {
            ok: true,
            value: {
              pullRequest: await fetchPullRequestDetailForDashboard({
                repoId: request.repoId,
                owner: repo.owner,
                repo: repo.name,
                pullNumber: request.pullNumber,
                auth,
              }),
              source: "github-app",
            },
          };
        } catch (error) {
          return serviceError(
            422,
            `GitHub pull request details could not be loaded: ${errorMessage(error)}`,
          );
        }
      }

      const worktreeRoot = input.store.repoWorktrees.get(request.repoId);
      if (!worktreeRoot) {
        return serviceError(
          409,
          "Pull request details require GitHub App credentials or a registered local Git worktree with gh available.",
        );
      }
      try {
        return {
          ok: true,
          value: {
            pullRequest: await fetchLocalPullRequestDetail({
              repoId: request.repoId,
              worktreeRoot,
              pullNumber: request.pullNumber,
              runCommand,
            }),
            source: "local-gh",
          },
        };
      } catch (error) {
        return serviceError(
          422,
          `Local pull request details could not be loaded with gh: ${localGhErrorMessage(error)}`,
        );
      }
    },

    async triage(request) {
      const repo = input.store.repos.get(request.repoId);
      if (!repo) {
        return serviceError(404, "Unknown repo.");
      }
      const pullNumbers = uniquePositiveIntegers(request.pullNumbers).slice(
        0,
        25,
      );
      if (pullNumbers.length === 0) {
        return serviceError(422, "Select at least one pull request to triage.");
      }

      const provider = request.providerId
        ? (input.store.providers.get(request.providerId) ?? null)
        : ([...input.store.providers.values()].find(
            (candidate) => candidate.repoContentConsent,
          ) ??
          [...input.store.providers.values()][0] ??
          null);
      if (!provider) {
        return serviceError(
          404,
          "Batch PR triage requires a configured model provider.",
        );
      }
      try {
        assertProviderConsent(provider);
      } catch (error) {
        return serviceError(
          403,
          error instanceof Error
            ? error.message
            : "Batch PR triage requires repo-content consent.",
        );
      }

      const auth = input.getInstallationAuth(repo.installationId);
      const worktreeRoot =
        input.store.repoWorktrees.get(request.repoId) ?? null;
      const source = auth ? "github-app" : "local-gh";
      if (!auth && !worktreeRoot) {
        return serviceError(
          409,
          "Batch PR triage requires GitHub App credentials or a registered local Git worktree with gh available.",
        );
      }

      const run = input.store.recordRun({
        repoId: request.repoId,
        type: "ai",
        status: "running",
        inputSummary: `Run batch PR triage for ${pullNumbers.length} selected pull request(s).`,
        safeMessage: null,
        artifactVersions: [],
        repoProfileVersion:
          input.store.latestProfile(request.repoId)?.version ?? null,
        provider: provider.displayName,
        model: provider.model,
        externalId: null,
      });

      try {
        const contexts = await Promise.all(
          pullNumbers.map((pullNumber) =>
            fetchPullRequestTriageContext({
              repoId: request.repoId,
              owner: repo.owner,
              repo: repo.name,
              pullNumber,
              auth,
              worktreeRoot,
              runCommand,
            }),
          ),
        );
        const modelProvider = buildProvider(provider, {
          cwd: worktreeRoot ?? process.cwd(),
        });
        const completion = await modelProvider.complete(
          batchPullRequestTriagePrompt({
            repoFullName: repo.fullName,
            contexts,
          }),
          { outputSchema: batchPullRequestTriageOutputJsonSchema },
        );
        const decisions = parseBatchPullRequestTriageOutput(completion.text);
        const results: PullRequestTriageApplyResult[] = [];

        for (const context of contexts) {
          const decision = decisions.get(context.number);
          const labels = labelDefinitionsForNames(
            triageLabelsWithFallback(context, decision?.labels ?? []),
          );
          const reason =
            compactPreview(
              decision?.reason ?? "The model returned no label.",
              240,
            ) || "The model returned no label.";
          if (labels.length === 0) {
            results.push({
              number: context.number,
              title: context.title,
              labels: [],
              appliedLabels: [],
              reason,
              status: "no_labels",
            });
            continue;
          }
          try {
            const appliedLabels = auth
              ? await applyPullRequestLabelsForDashboard({
                  owner: repo.owner,
                  repo: repo.name,
                  pullNumber: context.number,
                  labels,
                  auth,
                })
              : await applyLocalPullRequestLabels({
                  worktreeRoot: worktreeRoot ?? process.cwd(),
                  pullNumber: context.number,
                  labels,
                  runCommand,
                });
            results.push({
              number: context.number,
              title: context.title,
              labels: labels.map((label) => label.name),
              appliedLabels,
              reason,
              status: appliedLabels.length > 0 ? "labeled" : "no_labels",
            });
          } catch (error) {
            results.push({
              number: context.number,
              title: context.title,
              labels: labels.map((label) => label.name),
              appliedLabels: [],
              reason,
              status: "failed",
              error: errorMessage(error),
            });
          }
        }

        const appliedCount = results.reduce(
          (count, result) => count + result.appliedLabels.length,
          0,
        );
        input.store.updateRun(run.id, {
          status: "succeeded",
          safeMessage: `Batch PR triage applied ${appliedCount} label(s) across ${results.length} selected pull request(s).`,
        });
        return {
          ok: true,
          value: {
            run: input.store.runs.get(run.id) ?? run,
            results,
            source,
          },
        };
      } catch (error) {
        input.store.updateRun(run.id, {
          status: "failed",
          safeMessage:
            error instanceof Error
              ? `Batch PR triage failed: ${error.message}`
              : "Batch PR triage failed.",
        });
        return serviceError(
          502,
          error instanceof Error
            ? `Batch PR triage failed: ${error.message}`
            : "Batch PR triage failed.",
        );
      }
    },
  };
}

const localPullRequestListFields = [
  "number",
  "title",
  "state",
  "body",
  "url",
  "author",
  "isDraft",
  "labels",
  "reviewDecision",
  "mergeStateStatus",
  "updatedAt",
  "createdAt",
  "changedFiles",
  "additions",
  "deletions",
  "headRefName",
  "headRefOid",
  "baseRefName",
  "assignees",
  "reviewRequests",
].join(",");

const localPullRequestDetailFields = [
  localPullRequestListFields,
  "statusCheckRollup",
  "comments",
  "commits",
  "headRefOid",
  "mergeable",
  "reviews",
].join(",");

const localPullRequestTriageFields = [localPullRequestListFields, "files"].join(
  ",",
);

const LocalUserSchema = z
  .object({
    login: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const LocalLabelSchema = z
  .union([
    z.string(),
    z.object({ name: z.string().nullable().optional() }).passthrough(),
  ])
  .nullable();

const LocalCheckSchema = z
  .object({
    name: z.string().nullable().optional(),
    context: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    conclusion: z.string().nullable().optional(),
    detailsUrl: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough();

const LocalPullRequestFileSchema = z
  .object({
    path: z.string().nullable().optional(),
    filename: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    additions: z.number().int().min(0).nullable().optional(),
    deletions: z.number().int().min(0).nullable().optional(),
  })
  .passthrough();

const LocalCommentSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    body: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    author: LocalUserSchema.nullable().optional(),
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .passthrough();

const LocalReviewSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    body: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    author: LocalUserSchema.nullable().optional(),
    submittedAt: z.string().nullable().optional(),
  })
  .passthrough();

const LocalCommitSchema = z
  .object({
    oid: z.string().nullable().optional(),
    sha: z.string().nullable().optional(),
    messageHeadline: z.string().nullable().optional(),
    authoredDate: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    authors: z.array(LocalUserSchema).nullable().optional(),
  })
  .passthrough();

const LocalPullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    author: LocalUserSchema.nullable().optional(),
    isDraft: z.boolean().nullable().optional(),
    labels: z.array(LocalLabelSchema).nullable().optional(),
    reviewDecision: z.string().nullable().optional(),
    mergeable: z.string().nullable().optional(),
    mergeStateStatus: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
    statusCheckRollup: z.array(LocalCheckSchema).nullable().optional(),
    comments: z.union([z.number(), z.array(LocalCommentSchema)]).optional(),
    reviews: z.array(LocalReviewSchema).nullable().optional(),
    commits: z.union([z.number(), z.array(LocalCommitSchema)]).optional(),
    changedFiles: z.number().int().min(0).nullable().optional(),
    additions: z.number().int().min(0).nullable().optional(),
    deletions: z.number().int().min(0).nullable().optional(),
    headRefName: z.string().nullable().optional(),
    headRefOid: z.string().nullable().optional(),
    baseRefName: z.string().nullable().optional(),
    baseRefOid: z.string().nullable().optional(),
    assignees: z.array(LocalUserSchema).nullable().optional(),
    reviewRequests: z.array(LocalUserSchema).nullable().optional(),
    files: z.array(LocalPullRequestFileSchema).nullable().optional(),
  })
  .passthrough();

const supportedPullRequestTriageLabels = [
  "open-maintainer/ready-for-review",
  "open-maintainer/needs-author-input",
  "open-maintainer/needs-maintainer-design",
  "open-maintainer/not-agent-ready",
  "open-maintainer/possible-spam",
  "open-maintainer/llm-authored",
  "open-maintainer/context-update",
] as const;

const PullRequestTriageLabelSchema = z.enum(supportedPullRequestTriageLabels);

const BatchPullRequestTriageOutputSchema = z.object({
  pullRequests: z.array(
    z.object({
      number: z.number().int().positive(),
      labels: z.array(PullRequestTriageLabelSchema).default([]),
      reason: z.string().min(1),
    }),
  ),
});

const batchPullRequestTriageOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pullRequests"],
  properties: {
    pullRequests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "labels", "reason"],
        properties: {
          number: { type: "integer", minimum: 1 },
          labels: {
            type: "array",
            items: { type: "string", enum: supportedPullRequestTriageLabels },
          },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

type PullRequestTriageContext = {
  number: number;
  title: string;
  body: string;
  author: string | null;
  baseRef: string;
  headRef: string;
  labels: string[];
  isDraft: boolean | null;
  attention: PullRequestListItem["attention"];
  reviewDecision: string | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  checksSummary: PullRequestListItem["checksSummary"];
  changedFiles: number;
  additions: number;
  deletions: number;
  filePaths: string[];
  inferredLabels: string[];
};

const pullRequestTriageLabelDefinitions = {
  "open-maintainer/ready-for-review": {
    name: "open-maintainer/ready-for-review",
    color: "0e8a16",
    description: "PR is ready for normal human maintainer review.",
  },
  "open-maintainer/needs-author-input": {
    name: "open-maintainer/needs-author-input",
    color: "fbca04",
    description: "PR needs author changes, validation, or clarification.",
  },
  "open-maintainer/needs-maintainer-design": {
    name: "open-maintainer/needs-maintainer-design",
    color: "d876e3",
    description: "PR needs maintainer product or design direction first.",
  },
  "open-maintainer/not-agent-ready": {
    name: "open-maintainer/not-agent-ready",
    color: "b60205",
    description: "PR is not ready for automated agent handling.",
  },
  "open-maintainer/possible-spam": {
    name: "open-maintainer/possible-spam",
    color: "5319e7",
    description: "PR has possible spam or low-signal contribution markers.",
  },
  "open-maintainer/llm-authored": {
    name: "open-maintainer/llm-authored",
    color: "6f42c1",
    description: "PR appears authored by an LLM or coding agent.",
  },
  "open-maintainer/context-update": {
    name: "open-maintainer/context-update",
    color: "0e8a16",
    description: "PR updates Open Maintainer generated context artifacts.",
  },
} as const;

async function listLocalPullRequests(input: {
  repoId: string;
  worktreeRoot: string;
  state: PullRequestListState;
  search: string;
  sort: PullRequestListSort;
  direction: PullRequestListDirection;
  runCommand: DashboardPullRequestCommandRunner;
}): Promise<PullRequestListItem[]> {
  const output = await input.runCommand({
    command: ghCommand(),
    cwd: input.worktreeRoot,
    args: [
      "pr",
      "list",
      "--state",
      input.state,
      "--limit",
      "100",
      "--json",
      localPullRequestListFields,
    ],
  });
  const parsed = z.array(LocalPullRequestSchema).parse(JSON.parse(output));
  return sortPullRequests(
    filterPullRequests(
      parsed.map((pullRequest) =>
        mapLocalPullRequestListItem({
          repoId: input.repoId,
          pullRequest,
          files: null,
        }),
      ),
      input.search,
    ),
    input.sort,
    input.direction,
  );
}

async function fetchLocalPullRequestDetail(input: {
  repoId: string;
  worktreeRoot: string;
  pullNumber: number;
  runCommand: DashboardPullRequestCommandRunner;
}): Promise<PullRequestDetail> {
  const output = await input.runCommand({
    command: ghCommand(),
    cwd: input.worktreeRoot,
    args: [
      "pr",
      "view",
      String(input.pullNumber),
      "--json",
      localPullRequestDetailFields,
    ],
  });
  const pullRequest = LocalPullRequestSchema.parse(JSON.parse(output));
  const baseRef = pullRequest.baseRefName ?? "main";
  const headRef = pullRequest.headRefName ?? "HEAD";
  const localInput = await assembleLocalReviewInput({
    repoRoot: input.worktreeRoot,
    repoId: input.repoId,
    baseRef,
    headRef,
  });
  const detail = {
    summary: mapLocalPullRequestListItem({
      repoId: input.repoId,
      pullRequest,
      files: localInput.changedFiles,
    }),
    body: pullRequest.body ?? "",
    baseSha: pullRequest.baseRefOid ?? localInput.baseSha,
    headSha: pullRequest.headRefOid ?? localInput.headSha,
    mergeable: pullRequest.mergeable ?? null,
    mergeStateStatus: pullRequest.mergeStateStatus ?? null,
    reviewDecision: pullRequest.reviewDecision ?? null,
    files: localInput.changedFiles,
    skippedFiles: localInput.skippedFiles,
    commits: localCommits(pullRequest, localInput.commits),
    timeline: localTimeline(pullRequest),
    checks: localChecks(pullRequest.statusCheckRollup ?? []),
  } satisfies PullRequestDetail;
  return PullRequestDetailSchema.parse(detail);
}

async function fetchPullRequestTriageContext(input: {
  repoId: string;
  owner: string;
  repo: string;
  pullNumber: number;
  auth: GitHubAppInstallationAuth | null;
  worktreeRoot: string | null;
  runCommand: DashboardPullRequestCommandRunner;
}): Promise<PullRequestTriageContext> {
  if (input.auth) {
    const detail = await fetchPullRequestDetailForDashboard({
      repoId: input.repoId,
      owner: input.owner,
      repo: input.repo,
      pullNumber: input.pullNumber,
      auth: input.auth,
    });
    return pullRequestTriageContextFromSummary({
      summary: detail.summary,
      body: detail.body,
      filePaths: detail.files.map((file) => file.path),
    });
  }

  if (!input.worktreeRoot) {
    throw new Error("Local pull request triage requires a worktree.");
  }
  const output = await input.runCommand({
    command: ghCommand(),
    cwd: input.worktreeRoot,
    args: [
      "pr",
      "view",
      String(input.pullNumber),
      "--json",
      localPullRequestTriageFields,
    ],
  });
  const pullRequest = LocalPullRequestSchema.parse(JSON.parse(output));
  const filePaths = (pullRequest.files ?? [])
    .map((file) => file.path ?? file.filename)
    .filter((filePath): filePath is string => Boolean(filePath));
  const summary = mapLocalPullRequestListItem({
    repoId: input.repoId,
    pullRequest,
    files: filePaths.map((filePath) => ({
      path: filePath,
      status: "modified" as const,
      additions: 0,
      deletions: 0,
      patch: null,
      previousPath: null,
    })),
  });
  return pullRequestTriageContextFromSummary({
    summary,
    body: pullRequest.body ?? "",
    filePaths,
  });
}

function pullRequestTriageContextFromSummary(input: {
  summary: PullRequestListItem;
  body: string;
  filePaths: string[];
}): PullRequestTriageContext {
  return {
    number: input.summary.number,
    title: input.summary.title,
    body: input.body,
    author: input.summary.author,
    baseRef: input.summary.baseRef,
    headRef: input.summary.headRef,
    labels: input.summary.labels,
    isDraft: input.summary.isDraft,
    attention: input.summary.attention,
    reviewDecision: input.summary.reviewDecision,
    mergeable: input.summary.mergeable,
    mergeStateStatus: input.summary.mergeStateStatus,
    checksSummary: input.summary.checksSummary,
    changedFiles: input.summary.changedFiles,
    additions: input.summary.additions,
    deletions: input.summary.deletions,
    filePaths: input.filePaths,
    inferredLabels: input.summary.triageTags.map((tag) => tag.githubLabel),
  };
}

function mapLocalPullRequestListItem(input: {
  repoId: string;
  pullRequest: z.infer<typeof LocalPullRequestSchema>;
  files: ReviewChangedFile[] | null;
}): PullRequestListItem {
  const labels = labelNames(input.pullRequest.labels ?? []);
  const title =
    input.pullRequest.title ?? `Pull request #${input.pullRequest.number}`;
  const body = input.pullRequest.body ?? "";
  const headRef = input.pullRequest.headRefName ?? "head";
  const checks = localChecks(input.pullRequest.statusCheckRollup ?? []);
  const changedFiles =
    input.pullRequest.changedFiles ?? input.files?.length ?? 0;
  const additions =
    input.pullRequest.additions ??
    input.files?.reduce((total, file) => total + file.additions, 0) ??
    0;
  const deletions =
    input.pullRequest.deletions ??
    input.files?.reduce((total, file) => total + file.deletions, 0) ??
    0;
  return PullRequestListItemSchema.parse({
    number: input.pullRequest.number,
    title,
    bodyPreview: compactPreview(body, 180),
    url: urlOrNull(input.pullRequest.url),
    author: input.pullRequest.author?.login ?? null,
    state: localPullRequestState(input.pullRequest.state),
    isDraft: input.pullRequest.isDraft ?? null,
    labels,
    reviewers: userNames(input.pullRequest.reviewRequests ?? []),
    assignees: userNames(input.pullRequest.assignees ?? []),
    baseRef: input.pullRequest.baseRefName ?? "base",
    headRef,
    headSha: input.pullRequest.headRefOid ?? null,
    createdAt: input.pullRequest.createdAt ?? null,
    updatedAt: input.pullRequest.updatedAt ?? null,
    comments: commentCount(input.pullRequest.comments),
    reviewComments: 0,
    commits: commitCount(input.pullRequest.commits),
    changedFiles,
    additions,
    deletions,
    reviewDecision: input.pullRequest.reviewDecision ?? null,
    mergeable: input.pullRequest.mergeable ?? null,
    mergeStateStatus: input.pullRequest.mergeStateStatus ?? null,
    checksSummary: summarizeChecks(checks),
    attention: attentionForPullRequest({
      isDraft: input.pullRequest.isDraft ?? null,
      reviewDecision: input.pullRequest.reviewDecision ?? null,
      mergeable: input.pullRequest.mergeable ?? null,
      mergeStateStatus: input.pullRequest.mergeStateStatus ?? null,
      checks,
    }),
    unread: false,
    triageTags: inferPullRequestTriageTags({
      author: input.pullRequest.author?.login ?? null,
      body,
      files: input.files,
      headRef,
      labels,
      title,
    }),
  });
}

function localChecks(checks: readonly z.infer<typeof LocalCheckSchema>[]) {
  return checks.map(
    (check, index): ReviewCheckStatus => ({
      name: check.name ?? check.context ?? `check-${index + 1}`,
      status: check.status ?? "unknown",
      conclusion: check.conclusion ?? null,
      url: urlOrNull(check.detailsUrl ?? check.url ?? null),
    }),
  );
}

function localPullRequestState(
  state: string | null | undefined,
): PullRequestListItem["state"] {
  const normalized = state?.toLowerCase();
  if (normalized === "closed") {
    return "closed";
  }
  if (normalized === "merged") {
    return "merged";
  }
  return "open";
}

function localCommits(
  pullRequest: z.infer<typeof LocalPullRequestSchema>,
  fallbackShas: string[],
): PullRequestCommit[] {
  if (Array.isArray(pullRequest.commits)) {
    return pullRequest.commits
      .filter((commit) => commit.oid || commit.sha)
      .map((commit) => ({
        sha: commit.oid ?? commit.sha ?? "",
        message: commit.messageHeadline ?? null,
        author: commit.authors?.[0]?.login ?? commit.authors?.[0]?.name ?? null,
        authoredAt: commit.authoredDate ?? null,
        url: urlOrNull(commit.url),
      }));
  }
  return fallbackShas.map((sha) => ({
    sha,
    message: null,
    author: null,
    authoredAt: null,
    url: null,
  }));
}

function localTimeline(
  pullRequest: z.infer<typeof LocalPullRequestSchema>,
): PullRequestTimelineItem[] {
  const comments = Array.isArray(pullRequest.comments)
    ? pullRequest.comments
    : [];
  const reviews = pullRequest.reviews ?? [];
  return [
    {
      id: `opened-${pullRequest.number}`,
      kind: "opened" as const,
      author: pullRequest.author?.login ?? null,
      body: pullRequest.body ?? "",
      state: null,
      path: null,
      line: null,
      url: urlOrNull(pullRequest.url),
      createdAt: pullRequest.createdAt ?? null,
      updatedAt: pullRequest.updatedAt ?? null,
    },
    ...comments.map((comment, index) => ({
      id: `comment-${comment.id ?? index}`,
      kind: "comment" as const,
      author: comment.author?.login ?? null,
      body: comment.body ?? "",
      state: null,
      path: null,
      line: null,
      url: urlOrNull(comment.url),
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
    ...reviews.map((review, index) => ({
      id: `review-${review.id ?? index}`,
      kind: "review" as const,
      author: review.author?.login ?? null,
      body: review.body ?? "",
      state: review.state ?? null,
      path: null,
      line: null,
      url: urlOrNull(review.url),
      createdAt: review.submittedAt ?? null,
      updatedAt: review.submittedAt ?? null,
    })),
  ].sort(
    (left, right) =>
      timestampForSort(left.createdAt) - timestampForSort(right.createdAt),
  );
}

function filterPullRequests(
  pullRequests: PullRequestListItem[],
  search: string,
): PullRequestListItem[] {
  const query = search.trim().toLowerCase();
  if (!query) {
    return pullRequests;
  }
  return pullRequests.filter((pullRequest) =>
    [
      pullRequest.title,
      pullRequest.bodyPreview,
      pullRequest.author ?? "",
      pullRequest.number.toString(),
      pullRequest.labels.join(" "),
      pullRequest.triageTags
        .map((tag) => `${tag.label} ${tag.githubLabel}`)
        .join(" "),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query),
  );
}

function sortPullRequests(
  pullRequests: PullRequestListItem[],
  sort: PullRequestListSort,
  direction: PullRequestListDirection,
): PullRequestListItem[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...pullRequests].sort((left, right) => {
    if (sort === "number") {
      return (left.number - right.number) * multiplier;
    }
    const leftValue = timestampForSort(
      sort === "created" ? left.createdAt : left.updatedAt,
    );
    const rightValue = timestampForSort(
      sort === "created" ? right.createdAt : right.updatedAt,
    );
    return (leftValue - rightValue) * multiplier;
  });
}

function summarizeChecks(checks: readonly ReviewCheckStatus[]) {
  const summary = {
    total: checks.length,
    passing: 0,
    failing: 0,
    pending: 0,
    skipped: 0,
  };
  for (const check of checks) {
    const conclusion = (check.conclusion ?? check.status).toLowerCase();
    if (["success", "neutral"].includes(conclusion)) {
      summary.passing += 1;
    } else if (
      ["failure", "cancelled", "timed_out", "action_required"].includes(
        conclusion,
      )
    ) {
      summary.failing += 1;
    } else if (conclusion === "skipped") {
      summary.skipped += 1;
    } else {
      summary.pending += 1;
    }
  }
  return summary;
}

function attentionForPullRequest(input: {
  isDraft: boolean | null;
  reviewDecision: string | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  checks: readonly ReviewCheckStatus[];
}): PullRequestListItem["attention"] {
  if (input.isDraft) {
    return "draft";
  }
  if (summarizeChecks(input.checks).failing > 0) {
    return "checks_failed";
  }
  if (input.reviewDecision === "CHANGES_REQUESTED") {
    return "changes_requested";
  }
  if (input.mergeable === "CONFLICTING" || input.mergeStateStatus === "DIRTY") {
    return "conflicts";
  }
  if (input.reviewDecision === "REVIEW_REQUIRED") {
    return "review_required";
  }
  return "none";
}

function labelNames(labels: readonly z.infer<typeof LocalLabelSchema>[]) {
  return labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((label): label is string => Boolean(label));
}

function userNames(users: readonly z.infer<typeof LocalUserSchema>[]) {
  return users
    .map((user) => user.login ?? user.name)
    .filter((login): login is string => Boolean(login));
}

function commentCount(
  comments: number | z.infer<typeof LocalCommentSchema>[] | undefined,
): number {
  return Array.isArray(comments) ? comments.length : (comments ?? 0);
}

function commitCount(
  commits: number | z.infer<typeof LocalCommitSchema>[] | undefined,
): number {
  return Array.isArray(commits) ? commits.length : (commits ?? 0);
}

function urlOrNull(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return /^https?:\/\//.test(value) ? value : null;
}

function timestampForSort(value: string | null): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compactPreview(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength - 3)}...`;
}

function batchPullRequestTriagePrompt(input: {
  repoFullName: string;
  contexts: PullRequestTriageContext[];
}) {
  return {
    system:
      "You classify pull requests for a repository maintainer. Return only labels from the allowed list. Do not invent labels.",
    user: JSON.stringify(
      {
        task: "For each selected pull request, choose applicable GitHub labels from the allowedLabels list.",
        policy: [
          "Always choose exactly one primary lane label for every selected PR: open-maintainer/ready-for-review, open-maintainer/needs-author-input, open-maintainer/needs-maintainer-design, open-maintainer/not-agent-ready, or open-maintainer/possible-spam.",
          "Use open-maintainer/ready-for-review when the PR is ready for normal maintainer review and has no supplied evidence of failed checks, conflicts, draft state, requested changes, or missing author evidence.",
          "Use open-maintainer/needs-author-input when the PR has failed checks, missing validation, conflicts caused by the branch, requested changes, unclear intent, or needs author follow-up.",
          "Use open-maintainer/needs-maintainer-design when the PR requires product, policy, architecture, security, or maintainer decision before review can proceed.",
          "Use open-maintainer/not-agent-ready when the PR is draft, too large, too risky, or lacks enough evidence for an automated maintainer workflow.",
          "Use open-maintainer/possible-spam only for low-signal, promotional, unrelated, or suspicious PRs.",
          "Use open-maintainer/llm-authored when title, body, branch, author, current labels, or file evidence indicates the PR was authored or generated by an LLM, coding agent, or AI tool such as Codex, Claude, Copilot, Cursor, Devin, Sweep, Aider, OpenHands, GPT, or an agent.",
          "Use open-maintainer/context-update when the PR updates generated Open Maintainer context artifacts such as AGENTS.md, CLAUDE.md, .open-maintainer.yml, .open-maintainer/profile.json, .open-maintainer/report.md, .agents/skills/**, .claude/skills/**, .github/copilot-instructions.md, or .cursor/rules/**.",
          "Classify every pull request number in selectedPullRequests.",
        ],
        repo: input.repoFullName,
        allowedLabels: Object.values(pullRequestTriageLabelDefinitions).map(
          (label) => ({
            name: label.name,
            description: label.description,
          }),
        ),
        selectedPullRequests: input.contexts.map((context) => ({
          number: context.number,
          title: context.title,
          body: compactPreview(context.body, 4000),
          author: context.author,
          baseRef: context.baseRef,
          headRef: context.headRef,
          currentLabels: context.labels,
          isDraft: context.isDraft,
          attention: context.attention,
          reviewDecision: context.reviewDecision,
          mergeable: context.mergeable,
          mergeStateStatus: context.mergeStateStatus,
          checksSummary: context.checksSummary,
          changedFiles: context.changedFiles,
          additions: context.additions,
          deletions: context.deletions,
          filePaths: context.filePaths.slice(0, 120),
          deterministicHints: context.inferredLabels,
        })),
      },
      null,
      2,
    ),
  };
}

function parseBatchPullRequestTriageOutput(text: string): Map<
  number,
  {
    labels: Array<(typeof supportedPullRequestTriageLabels)[number]>;
    reason: string;
  }
> {
  const parsed = BatchPullRequestTriageOutputSchema.parse(
    parseJsonCompletion(text),
  );
  return new Map(
    parsed.pullRequests.map((pullRequest) => [
      pullRequest.number,
      {
        labels: [...new Set(pullRequest.labels)],
        reason: pullRequest.reason,
      },
    ]),
  );
}

function parseJsonCompletion(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim());
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON.");
  }
}

function labelDefinitionsForNames(
  labels: readonly string[],
): Array<
  (typeof pullRequestTriageLabelDefinitions)[keyof typeof pullRequestTriageLabelDefinitions]
> {
  return labels.flatMap((label) => {
    const parsed = PullRequestTriageLabelSchema.safeParse(label);
    return parsed.success
      ? [pullRequestTriageLabelDefinitions[parsed.data]]
      : [];
  });
}

function triageLabelsWithFallback(
  context: PullRequestTriageContext,
  modelLabels: readonly string[],
): string[] {
  const supported = modelLabels.filter(
    (label) => PullRequestTriageLabelSchema.safeParse(label).success,
  );
  const laneLabels = supported.filter((label) =>
    primaryTriageLaneLabels.has(label),
  );
  const extraLabels = supported.filter(
    (label) => !primaryTriageLaneLabels.has(label),
  );
  const lane = laneLabels[0] ?? fallbackPrimaryTriageLane(context);
  return [...new Set([lane, ...context.inferredLabels, ...extraLabels])];
}

const primaryTriageLaneLabels = new Set<string>([
  "open-maintainer/ready-for-review",
  "open-maintainer/needs-author-input",
  "open-maintainer/needs-maintainer-design",
  "open-maintainer/not-agent-ready",
  "open-maintainer/possible-spam",
]);

function fallbackPrimaryTriageLane(context: PullRequestTriageContext): string {
  const existingLane = context.labels.find((label) =>
    primaryTriageLaneLabels.has(label),
  );
  if (existingLane) {
    return existingLane;
  }
  const text = [
    context.title,
    context.body,
    context.headRef,
    context.author ?? "",
    context.labels.join(" "),
  ]
    .join(" ")
    .toLowerCase();
  if (/\b(spam|promo|promotion|crypto|airdrop|seo|casino)\b/.test(text)) {
    return "open-maintainer/possible-spam";
  }
  if (context.isDraft || context.attention === "draft") {
    return "open-maintainer/not-agent-ready";
  }
  if (
    context.attention === "checks_failed" ||
    context.attention === "changes_requested" ||
    context.attention === "conflicts" ||
    context.checksSummary.failing > 0
  ) {
    return "open-maintainer/needs-author-input";
  }
  if (
    context.changedFiles > 25 ||
    context.additions + context.deletions > 1200
  ) {
    return "open-maintainer/not-agent-ready";
  }
  return "open-maintainer/ready-for-review";
}

async function applyLocalPullRequestLabels(input: {
  worktreeRoot: string;
  pullNumber: number;
  labels: Array<{
    name: string;
    color: string;
    description: string;
  }>;
  runCommand: DashboardPullRequestCommandRunner;
}): Promise<string[]> {
  for (const label of input.labels) {
    await input.runCommand({
      command: ghCommand(),
      cwd: input.worktreeRoot,
      args: [
        "label",
        "create",
        label.name,
        "--color",
        label.color,
        "--description",
        label.description,
        "--force",
      ],
    });
  }
  const labelNames = input.labels.map((label) => label.name);
  if (labelNames.length === 0) {
    return [];
  }
  const repoFullName = (
    await input.runCommand({
      command: ghCommand(),
      cwd: input.worktreeRoot,
      args: [
        "repo",
        "view",
        "--json",
        "nameWithOwner",
        "--jq",
        ".nameWithOwner",
      ],
    })
  ).trim();
  if (!repoFullName) {
    throw new Error(
      "Unable to resolve the GitHub repository for local labels.",
    );
  }
  await input.runCommand({
    command: ghCommand(),
    cwd: input.worktreeRoot,
    args: [
      "api",
      `repos/${repoFullName}/issues/${input.pullNumber}/labels`,
      "--method",
      "POST",
      ...labelNames.flatMap((label) => ["-f", `labels[]=${label}`]),
    ],
  });
  return labelNames;
}

function uniquePositiveIntegers(values: readonly number[]): number[] {
  return [
    ...new Set(values.filter((value) => Number.isInteger(value) && value > 0)),
  ];
}

function serviceError(
  statusCode: 403 | 404 | 409 | 422 | 502,
  error: string,
): DashboardPullRequestServiceResult<never> {
  return { ok: false, statusCode, error };
}

async function defaultPullRequestCommandRunner(input: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(input.command, input.args, {
      cwd: input.cwd,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    });
    return stdout;
  } catch (error) {
    throw new Error(sanitizeLocalGhCommandError(error));
  }
}

function ghCommand(): string {
  return process.env["OPEN_MAINTAINER_GH_COMMAND"] ?? "gh";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localGhErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (message.includes("api.github.com")) {
    return "GitHub CLI could not reach api.github.com from the API container. Check Docker networking, proxy settings, or GitHub status, then retry.";
  }
  return message;
}

function sanitizeLocalGhCommandError(error: unknown): string {
  const message = errorMessage(error).trim();
  if (!message) {
    return "GitHub CLI command failed.";
  }
  const stderr = message
    .split("\n")
    .filter((line) => !line.startsWith("Command failed: "))
    .join("\n")
    .trim();
  return stderr || "GitHub CLI command failed.";
}
