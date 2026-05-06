import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_CODEX_CLI_MODEL,
  buildClaudeCliProvider,
  buildCodexCliProvider,
} from "@open-maintainer/ai";
import type { ModelProvider } from "@open-maintainer/ai";
import {
  type GitHubRepositoryClient,
  createGitHubCliApi,
  execGitHubCli,
  planInlineReviewComments,
  planReviewSummaryComment,
  publishInlineReviewComments,
  upsertReviewSummaryComment,
} from "@open-maintainer/github";
import {
  assembleLocalReviewInput,
  createCliReviewOperationModelRequest,
  createReviewOperationDeps,
  createReviewPipeline,
  loadReviewPromptContext,
  reviewOperationOutputFromShortcut,
  reviewOperationPublicationFromShortcut,
  reviewTriageLabelDefinitions,
  reviewTriageLabelNames,
} from "@open-maintainer/review";
import type {
  PullRequestReviewRun,
  ReviewInlineCommentPlan,
  ReviewOperationDeps,
  ReviewPromptContext,
  ReviewPublicationInput,
  ReviewPublicationPlan,
  ReviewPublicationResult,
  ReviewPullRequestMetadata,
  ReviewTriageLabelPlan,
  ReviewTriageLabelResult,
} from "@open-maintainer/review";
import type {
  ModelProviderConfig,
  RepoProfile,
  ReviewCheckStatus,
  ReviewExistingComment,
  ReviewInput,
  ReviewResult,
  ReviewSkippedFile,
} from "@open-maintainer/shared";
import { createCliRepositoryWorkspace } from "./repository-workspace";

const execFileAsync = promisify(execFile);

export type ReviewOperationModelProvider = "codex" | "claude";

export type ReviewOperationRequest = {
  repoRoot: string;
  target:
    | {
        kind: "diff";
        baseRef?: string;
        headRef?: string;
        prNumber?: number | null;
      }
    | { kind: "pullRequest"; number: number };
  model: {
    provider: ReviewOperationModelProvider;
    model?: string | null;
    consent: { repositoryContentTransfer: true };
  };
  intent: "preview" | "apply";
  output?: {
    markdownPath?: string;
    json?: boolean;
  };
  publication?:
    | false
    | {
        mode: "plan" | "publish";
        summary?: boolean;
        inline?: false | { cap?: number };
        triageLabel?:
          | false
          | {
              apply: true;
              createMissingLabels?: boolean;
            };
      };
};

export type ReviewOperationRun = {
  review: ReviewResult;
  markdown: string;
  output: PullRequestReviewRun["output"];
  publication: PullRequestReviewRun["publication"];
  diagnostics: {
    promptContextPaths: string[];
    skippedFiles: ReviewSkippedFile[];
    changedFileCount: number;
  };
};

export type ReviewOperationRuntime = {
  review(input: ReviewOperationRequest): Promise<ReviewOperationRun>;
};

export type RepositoryWorkspacePort = {
  prepareProfile(input: { repoRoot: string }): Promise<RepoProfile>;
  detectDefaultBranch(input: { repoRoot: string }): Promise<string | null>;
};

export type ReviewSourcePort = {
  assembleDiff(input: {
    repoRoot: string;
    profile: RepoProfile;
    baseRef: string;
    headRef: string;
    limits?: Partial<{
      maxFiles: number;
      maxFileBytes: number;
      maxTotalBytes: number;
    }>;
  }): Promise<ReviewInput>;
  fetchPullRequestMetadata(input: {
    repoRoot: string;
    profile: RepoProfile;
    prNumber: number;
    baseRef?: string;
    headRef?: string;
  }): Promise<ReviewPullRequestMetadata>;
};

export type ReviewPromptContextPort = {
  load(input: {
    repoRoot: string;
    profile: RepoProfile;
    reviewInput: ReviewInput;
  }): Promise<{ context: ReviewPromptContext; paths: string[] }>;
};

export type ReviewModelProviderPort = {
  resolve(input: {
    repoRoot: string;
    profile: RepoProfile;
    reviewInput: ReviewInput;
    model: ReviewOperationRequest["model"];
  }):
    | Promise<{ providerConfig: ModelProviderConfig; provider: ModelProvider }>
    | { providerConfig: ModelProviderConfig; provider: ModelProvider };
};

export type ReviewPublisherPort = NonNullable<ReviewOperationDeps["publisher"]>;

export type ReviewOutputPort = NonNullable<ReviewOperationDeps["output"]>;

export type ReviewOperationPorts = {
  workspace: RepositoryWorkspacePort;
  source: ReviewSourcePort;
  promptContext: ReviewPromptContextPort;
  modelProvider: ReviewModelProviderPort;
  publisher: ReviewPublisherPort;
  output: ReviewOutputPort;
};

export function createReviewOperationRuntime(
  ports?: ReviewOperationPorts,
): ReviewOperationRuntime {
  return {
    async review(input) {
      const resolvedPorts =
        ports ?? createProductionReviewOperationPorts(input.repoRoot);
      const pipeline = createReviewPipeline(
        createCliReviewOperationDeps(resolvedPorts),
      );
      const output = reviewOperationOutputFromShortcut(
        input.output?.markdownPath
          ? { markdownPath: input.output.markdownPath }
          : undefined,
      );
      const publication = reviewOperationPublicationFromShortcut(
        input.publication,
      );
      const target =
        input.target.kind === "pullRequest"
          ? { kind: "pullRequest" as const, number: input.target.number }
          : {
              kind: "diff" as const,
              ...(input.target.baseRef
                ? { baseRef: input.target.baseRef }
                : {}),
              ...(input.target.headRef
                ? { headRef: input.target.headRef }
                : {}),
              ...(input.target.prNumber !== undefined
                ? { prNumber: input.target.prNumber }
                : {}),
            };
      const result = await pipeline.review({
        source: { kind: "local", repoRoot: input.repoRoot },
        target,
        model: createCliReviewOperationModelRequest({
          provider: input.model.provider,
          consent: input.model.consent,
          ...(input.model.model !== undefined
            ? { model: input.model.model }
            : {}),
        }),
        mode: input.intent,
        ...(publication !== undefined || output
          ? {
              effects: {
                ...(publication !== undefined ? { publication } : {}),
                ...(output ? { output } : {}),
              },
            }
          : {}),
      });
      if (!result.ok) {
        throw result.error;
      }
      const run = result.run;
      return {
        review: run.review,
        markdown: run.markdown,
        output: run.output,
        publication: run.publication,
        diagnostics: run.diagnostics,
      };
    },
  };
}

export function createProductionReviewOperationPorts(
  repoRoot: string,
): ReviewOperationPorts {
  const repositoryWorkspace = createCliRepositoryWorkspace();
  return {
    workspace: {
      async prepareProfile(input) {
        return repositoryWorkspace.profile(input.repoRoot);
      },
      async detectDefaultBranch(input) {
        return repositoryWorkspace.defaultBranch(input.repoRoot);
      },
    },
    source: {
      async assembleDiff(input) {
        return assembleLocalReviewInput({
          repoRoot: input.repoRoot,
          repoId: input.profile.repoId,
          baseRef: input.baseRef,
          headRef: input.headRef,
          ...(input.limits ? input.limits : {}),
        });
      },
      async fetchPullRequestMetadata(input) {
        return preparePullRequestReview(input.repoRoot, input.prNumber);
      },
    },
    promptContext: {
      async load(input) {
        return loadReviewPromptContext({
          repoRoot: input.repoRoot,
          profile: input.profile,
        });
      },
    },
    modelProvider: {
      resolve(input) {
        return buildReviewProvider({
          repoRoot: input.repoRoot,
          provider: input.model.provider,
          model: input.model.model ?? null,
        });
      },
    },
    publisher: createGhReviewPublisher(repoRoot),
    output: {
      async writeMarkdown(input) {
        const outputPath = path.resolve(input.repoRoot, input.path);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, input.markdown);
      },
    },
  };
}

function createCliReviewOperationDeps(
  ports: ReviewOperationPorts,
): ReviewOperationDeps {
  return createReviewOperationDeps({
    local: {
      prepareProfile(input) {
        return ports.workspace.prepareProfile(input);
      },
      detectDefaultBranch(input) {
        return ports.workspace.detectDefaultBranch(input);
      },
      assembleDiff(input) {
        return ports.source.assembleDiff(input);
      },
      fetchPullRequestMetadata(input) {
        return ports.source.fetchPullRequestMetadata(input);
      },
    },
    promptContext: {
      async resolve(input) {
        if (!input.source.repoRoot) {
          return { context: {}, paths: [] };
        }
        return ports.promptContext.load({
          repoRoot: input.source.repoRoot,
          profile: input.source.profile,
          reviewInput: input.source.input,
        });
      },
    },
    modelProviders: {
      resolve(input) {
        if (!("provider" in input.model) || "providerConfig" in input.model) {
          throw new Error(
            "CLI review operation requires a CLI model selection.",
          );
        }
        if (!input.source.repoRoot) {
          throw new Error(
            "CLI review operation requires a local repository root.",
          );
        }
        return ports.modelProvider.resolve({
          repoRoot: input.source.repoRoot,
          profile: input.source.profile,
          reviewInput: input.source.input,
          model: input.model,
        });
      },
    },
    publisher: ports.publisher,
    output: ports.output,
  });
}

type PreparedPullRequestReview = {
  number: number;
  owner: string;
  repo: string;
  title: string | null;
  body: string;
  url: string | null;
  author: string | null;
  isDraft: boolean | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  checkStatuses: ReviewCheckStatus[];
  existingComments: ReviewExistingComment[];
};

type GhPullRequestView = {
  number?: number;
  title?: string | null;
  body?: string | null;
  url?: string | null;
  author?: { login?: string | null } | null;
  isDraft?: boolean | null;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  reviewDecision?: string | null;
  baseRefName?: string | null;
  headRefName?: string | null;
  baseRefOid?: string | null;
  headRefOid?: string | null;
  comments?: Array<{
    id?: number | string | null;
    body?: string | null;
  }> | null;
  statusCheckRollup?: Array<{
    name?: string | null;
    status?: string | null;
    conclusion?: string | null;
    detailsUrl?: string | null;
    url?: string | null;
  }> | null;
};

type GhRepositoryView = {
  name?: string | null;
  owner?: { login?: string | null } | null;
};

async function preparePullRequestReview(
  repoRoot: string,
  prNumber: number,
): Promise<PreparedPullRequestReview> {
  const [repo, pr] = await Promise.all([
    ghJson<GhRepositoryView>(repoRoot, [
      "repo",
      "view",
      "--json",
      "owner,name",
    ]),
    ghJson<GhPullRequestView>(repoRoot, [
      "pr",
      "view",
      String(prNumber),
      "--json",
      [
        "number",
        "title",
        "body",
        "url",
        "author",
        "isDraft",
        "mergeable",
        "mergeStateStatus",
        "reviewDecision",
        "baseRefName",
        "headRefName",
        "baseRefOid",
        "headRefOid",
        "comments",
        "statusCheckRollup",
      ].join(","),
    ]),
  ]);
  const owner = repo.owner?.login;
  const repoName = repo.name;
  const baseSha = pr.baseRefOid;
  const headSha = pr.headRefOid;
  if (!owner || !repoName || !baseSha || !headSha) {
    throw new Error(
      `Unable to read pull request #${prNumber} metadata from gh.`,
    );
  }
  const headRef = `refs/remotes/open-maintainer/pr-${prNumber}`;
  await ensureGitObject(repoRoot, baseSha);
  await gitRequiredOutput(repoRoot, [
    "fetch",
    "--force",
    "--no-tags",
    "origin",
    `refs/pull/${prNumber}/head:${headRef}`,
  ]);

  return {
    number: pr.number ?? prNumber,
    owner,
    repo: repoName,
    title: pr.title ?? null,
    body: pr.body ?? "",
    url: pr.url ?? null,
    author: pr.author?.login ?? null,
    isDraft: pr.isDraft ?? null,
    mergeable: pr.mergeable ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    reviewDecision: pr.reviewDecision ?? null,
    baseRef: baseSha,
    headRef,
    baseSha,
    headSha,
    checkStatuses: parseGhCheckStatuses(pr.statusCheckRollup ?? []),
    existingComments: parseGhExistingComments(pr.comments ?? []),
  };
}

function createGhReviewPublisher(repoRoot: string): ReviewPublisherPort {
  return {
    async plan(input) {
      return planGhReviewPublication(repoRoot, input);
    },
    async publish(input) {
      return publishGhReviewPublication(repoRoot, input);
    },
  };
}

async function planGhReviewPublication(
  repoRoot: string,
  input: ReviewPublicationInput,
): Promise<ReviewPublicationPlan> {
  const client = createGhReviewClient(repoRoot);
  return {
    summary: input.options.summary
      ? planReviewSummaryComment({
          markdown: input.markdown,
          existingComments: input.reviewInput.existingComments.filter(
            (comment) => comment.kind === "summary",
          ),
        })
      : null,
    inline:
      input.options.inline === false
        ? null
        : await planGhInlineReviewComments(client, input),
    triageLabel: input.options.triageLabel
      ? await planReviewTriageLabel(repoRoot, input, {
          createMissingLabels: input.options.triageLabel.createMissingLabels,
        })
      : null,
  };
}

async function publishGhReviewPublication(
  repoRoot: string,
  input: ReviewPublicationInput,
): Promise<ReviewPublicationResult> {
  const client = createGhReviewClient(repoRoot);
  return {
    summary: input.options.summary
      ? await upsertReviewSummaryComment({
          owner: input.target.owner,
          repo: input.target.repo,
          pullNumber: input.target.pullNumber,
          markdown: input.markdown,
          client,
        })
      : null,
    inline:
      input.options.inline === false
        ? null
        : await publishInlineReviewComments({
            owner: input.target.owner,
            repo: input.target.repo,
            pullNumber: input.target.pullNumber,
            review: input.review,
            cap: input.options.inline.cap,
            client,
          }),
    triageLabel: input.options.triageLabel
      ? await applyReviewTriageLabel(repoRoot, input, {
          createMissingLabels: input.options.triageLabel.createMissingLabels,
        })
      : null,
  };
}

async function planGhInlineReviewComments(
  client: GitHubRepositoryClient,
  input: ReviewPublicationInput,
): Promise<ReviewInlineCommentPlan> {
  if (input.options.inline === false) {
    return { comments: [], skipped: [] };
  }
  const comments = await client.pulls.listReviewComments?.({
    owner: input.target.owner,
    repo: input.target.repo,
    pull_number: input.target.pullNumber,
    per_page: 100,
  });
  return planInlineReviewComments({
    review: input.review,
    existingComments: comments?.data ?? [],
    cap: input.options.inline.cap,
  });
}

async function planReviewTriageLabel(
  repoRoot: string,
  input: ReviewPublicationInput,
  options: { createMissingLabels: boolean },
): Promise<ReviewTriageLabelPlan> {
  const category = input.review.contributionTriage.category;
  if (input.review.contributionTriage.status !== "evaluated" || !category) {
    throw new Error(
      "--review-apply-triage-label requires an evaluated contribution-triage category.",
    );
  }
  const label = reviewTriageLabelDefinitions[category].name;
  const existingIssueLabels = await ghApiJson<Array<{ name?: string | null }>>(
    repoRoot,
    `repos/${input.target.owner}/${input.target.repo}/issues/${input.target.pullNumber}/labels?per_page=100`,
  );
  const existingIssueNames = new Set(
    existingIssueLabels.flatMap((item) => (item.name ? [item.name] : [])),
  );
  const repoLabels = options.createMissingLabels
    ? await ghApiJson<Array<{ name?: string | null }>>(
        repoRoot,
        `repos/${input.target.owner}/${input.target.repo}/labels?per_page=100`,
      )
    : [];
  const existingRepoNames = new Set(
    repoLabels.flatMap((item) => (item.name ? [item.name] : [])),
  );
  return {
    label,
    apply: !existingIssueNames.has(label),
    createMissingLabels: options.createMissingLabels,
    labelsToCreate: options.createMissingLabels
      ? Object.values(reviewTriageLabelDefinitions)
          .filter((definition) => !existingRepoNames.has(definition.name))
          .map((definition) => definition.name)
      : [],
    labelsToRemove: [...existingIssueNames].filter(
      (name) => reviewTriageLabelNames.has(name) && name !== label,
    ),
  };
}

async function applyReviewTriageLabel(
  repoRoot: string,
  input: ReviewPublicationInput,
  options: { createMissingLabels: boolean },
): Promise<ReviewTriageLabelResult> {
  const plan = await planReviewTriageLabel(repoRoot, input, options);
  const owner = input.target.owner;
  const repo = input.target.repo;
  const pullNumber = input.target.pullNumber;
  const created = options.createMissingLabels
    ? await createMissingReviewTriageLabels(repoRoot, owner, repo)
    : 0;
  const removed: string[] = [];
  for (const label of plan.labelsToRemove) {
    await editGitHubIssueLabels(repoRoot, owner, repo, pullNumber, {
      removeLabel: label,
    });
    removed.push(label);
  }
  if (plan.apply) {
    await editGitHubIssueLabels(repoRoot, owner, repo, pullNumber, {
      addLabel: plan.label,
    });
  }
  return {
    ...plan,
    applied: plan.apply,
    created,
    removed,
  };
}

async function createMissingReviewTriageLabels(
  repoRoot: string,
  owner: string,
  repo: string,
): Promise<number> {
  const repoLabels = await ghApiJson<Array<{ name?: string | null }>>(
    repoRoot,
    `repos/${owner}/${repo}/labels?per_page=100`,
  );
  const existingNames = new Set(
    repoLabels.flatMap((label) => (label.name ? [label.name] : [])),
  );
  let created = 0;
  for (const label of Object.values(reviewTriageLabelDefinitions)) {
    if (existingNames.has(label.name)) {
      continue;
    }
    await createGitHubLabel(repoRoot, owner, repo, label.name, label.color, {
      description: label.description,
    });
    created += 1;
  }
  return created;
}

function createGhReviewClient(repoRoot: string): GitHubRepositoryClient {
  return {
    repos: {
      async getContent() {
        throw new Error("Repository content reads are not used by CLI review.");
      },
      async createOrUpdateFileContents() {
        throw new Error("Repository writes are not used by CLI review.");
      },
    },
    git: {
      async getRef() {
        throw new Error("Git ref reads are not used by CLI review publisher.");
      },
      async createRef() {
        throw new Error("Git ref writes are not used by CLI review.");
      },
      async updateRef() {
        throw new Error("Git ref writes are not used by CLI review.");
      },
    },
    pulls: {
      async list() {
        throw new Error("Pull request listing is not used by CLI review.");
      },
      async create() {
        throw new Error("Pull request creation is not used by CLI review.");
      },
      async update() {
        throw new Error("Pull request updates are not used by CLI review.");
      },
      async listReviewComments(input) {
        return {
          data: await ghApiJson(
            repoRoot,
            `repos/${input.owner}/${input.repo}/pulls/${input.pull_number}/comments?per_page=${input.per_page ?? 100}`,
          ),
        };
      },
      async createReview(input) {
        const response = await ghApiWithJsonBody<{
          id?: number;
          html_url?: string | null;
        }>(
          repoRoot,
          `repos/${input.owner}/${input.repo}/pulls/${input.pull_number}/reviews`,
          "POST",
          {
            event: input.event,
            body: input.body,
            comments: input.comments,
          },
        );
        return {
          data: {
            id: response.id ?? 0,
            html_url: response.html_url ?? null,
          },
        };
      },
    },
    issues: {
      async listComments(input) {
        return {
          data: await ghApiJson(
            repoRoot,
            `repos/${input.owner}/${input.repo}/issues/${input.issue_number}/comments?per_page=${input.per_page ?? 100}`,
          ),
        };
      },
      async createComment(input) {
        const response = await ghApiWithJsonBody<{
          id?: number;
          html_url?: string | null;
        }>(
          repoRoot,
          `repos/${input.owner}/${input.repo}/issues/${input.issue_number}/comments`,
          "POST",
          { body: input.body },
        );
        return {
          data: {
            id: response.id ?? 0,
            html_url: response.html_url ?? null,
          },
        };
      },
      async updateComment(input) {
        const response = await ghApiWithJsonBody<{
          id?: number;
          html_url?: string | null;
        }>(
          repoRoot,
          `repos/${input.owner}/${input.repo}/issues/comments/${input.comment_id}`,
          "PATCH",
          { body: input.body },
        );
        return {
          data: {
            id: response.id ?? input.comment_id,
            html_url: response.html_url ?? null,
          },
        };
      },
    },
  };
}

function buildReviewProvider(input: {
  repoRoot: string;
  provider: ReviewOperationModelProvider;
  model: string | null;
}) {
  const createdAt = new Date(0).toISOString();
  const codexModel =
    input.model ??
    process.env["OPEN_MAINTAINER_CODEX_MODEL"] ??
    DEFAULT_CODEX_CLI_MODEL;
  const providerConfig: ModelProviderConfig =
    input.provider === "codex"
      ? {
          id: "model_provider_cli_review_codex",
          kind: "codex-cli",
          displayName: "Codex CLI",
          baseUrl: "http://localhost",
          model: codexModel,
          encryptedApiKey: "local-cli",
          repoContentConsent: true,
          createdAt,
          updatedAt: createdAt,
        }
      : {
          id: "model_provider_cli_review_claude",
          kind: "claude-cli",
          displayName: "Claude CLI",
          baseUrl: "http://localhost",
          model: input.model ?? "claude-cli",
          encryptedApiKey: "local-cli",
          repoContentConsent: true,
          createdAt,
          updatedAt: createdAt,
        };
  const provider =
    input.provider === "codex"
      ? buildCodexCliProvider({
          cwd: input.repoRoot,
          model: codexModel,
        })
      : buildClaudeCliProvider({
          cwd: input.repoRoot,
          ...(input.model ? { model: input.model } : {}),
        });
  return { providerConfig, provider };
}

async function ghJson<T>(repoRoot: string, args: string[]): Promise<T> {
  const output = await execGh(repoRoot, args);
  return JSON.parse(output) as T;
}

async function createGitHubLabel(
  repoRoot: string,
  owner: string,
  repo: string,
  label: string,
  color: string,
  options: { description: string },
): Promise<void> {
  await ghApiWithJsonBody(repoRoot, `repos/${owner}/${repo}/labels`, "POST", {
    name: label,
    color,
    description: options.description,
  });
}

async function editGitHubIssueLabels(
  repoRoot: string,
  owner: string,
  repo: string,
  issueNumber: number,
  options: { addLabel?: string; removeLabel?: string },
): Promise<void> {
  if (options.addLabel) {
    await ghApiWithJsonBody(
      repoRoot,
      `repos/${owner}/${repo}/issues/${issueNumber}/labels`,
      "POST",
      { labels: [options.addLabel] },
    );
  }
  if (options.removeLabel) {
    await ghApiNoBody(
      repoRoot,
      `repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(options.removeLabel)}`,
      "DELETE",
    );
  }
}

async function ghApiJson<T>(
  repoRoot: string,
  endpoint: string,
  args: string[] = [],
): Promise<T> {
  return createGitHubCliApi({ repoRoot }).json<T>(endpoint, args);
}

async function ghApiWithJsonBody<T = unknown>(
  repoRoot: string,
  endpoint: string,
  method: "PATCH" | "POST",
  body: unknown,
): Promise<T> {
  return createGitHubCliApi({ repoRoot }).jsonWithBody<T>(
    endpoint,
    method,
    body,
  );
}

async function ghApiNoBody(
  repoRoot: string,
  endpoint: string,
  method: "DELETE",
): Promise<void> {
  await createGitHubCliApi({ repoRoot }).noBody(endpoint, method);
}

async function execGh(repoRoot: string, args: string[]): Promise<string> {
  return execGitHubCli(repoRoot, args);
}

async function ensureGitObject(repoRoot: string, sha: string): Promise<void> {
  const exists = await gitRequiredOutput(repoRoot, [
    "cat-file",
    "-e",
    `${sha}^{commit}`,
  ])
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await gitRequiredOutput(repoRoot, ["fetch", "--no-tags", "origin", sha]);
  }
}

async function gitRequiredOutput(
  repoRoot: string,
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

function parseGhCheckStatuses(
  statuses: NonNullable<GhPullRequestView["statusCheckRollup"]>,
): ReviewCheckStatus[] {
  return statuses.flatMap((status) => {
    const name = status.name?.trim();
    const state = status.status?.trim();
    if (!name || !state) {
      return [];
    }
    return [
      {
        name,
        status: state,
        conclusion: status.conclusion ?? null,
        url: status.detailsUrl ?? status.url ?? null,
      },
    ];
  });
}

function parseGhExistingComments(
  comments: NonNullable<GhPullRequestView["comments"]>,
): ReviewExistingComment[] {
  return comments.flatMap((comment) => {
    const id =
      typeof comment.id === "number"
        ? comment.id
        : Number.parseInt(String(comment.id ?? ""), 10);
    if (!Number.isInteger(id) || id <= 0 || !comment.body) {
      return [];
    }
    return [
      {
        id,
        kind: comment.body.includes("open-maintainer-review-summary")
          ? ("summary" as const)
          : ("inline" as const),
        body: comment.body,
        path: null,
        line: null,
      },
    ];
  });
}
