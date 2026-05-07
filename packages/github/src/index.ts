import { execFile } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type {
  ContextPr,
  GeneratedArtifact,
  Installation,
  IssueTriageEvidence,
  IssueTriageIssueMetadata,
  IssueTriageRelatedIssue,
  IssueTriageSkippedEvidence,
  PullRequestCommit,
  PullRequestDetail,
  PullRequestListItem,
  PullRequestTimelineItem,
  Repo,
  RepoProfile,
  ReviewChangedFile,
  ReviewCheckStatus,
  ReviewInput,
  ReviewIssueContext,
  ReviewResult,
  ReviewSeverity,
  ReviewSkippedFile,
  RunRecord,
  WritableContextArtifact,
} from "@open-maintainer/shared";
import {
  PullRequestDetailSchema,
  PullRequestListItemSchema,
  inferPullRequestTriageTags,
  isOpenMaintainerGeneratedContent,
  newId,
  nowIso,
  selectWritableContextArtifacts,
} from "@open-maintainer/shared";
import {
  type IssueTriageEvidenceCommentInput,
  type IssueTriageGitHubPort,
  buildIssueTriageEvidence,
  extractReferencedIssueNumbers,
} from "@open-maintainer/triage";

const execFileAsync = promisify(execFile);
const gitHubCliMaxBuffer = 8 * 1024 * 1024;

export type GitHubCliExecutor = (args: readonly string[]) => Promise<string>;

export type GitHubCliApi = {
  json<T>(endpoint: string, args?: readonly string[]): Promise<T>;
  jsonWithBody<T = unknown>(
    endpoint: string,
    method: "PATCH" | "POST",
    body: unknown,
  ): Promise<T>;
  noBody(endpoint: string, method: "DELETE"): Promise<void>;
};

export function createGitHubCliApi(input: {
  repoRoot: string;
  execGh?: GitHubCliExecutor;
}): GitHubCliApi {
  const execGh =
    input.execGh ??
    ((args: readonly string[]) => execGitHubCli(input.repoRoot, args));
  return {
    async json<T>(endpoint: string, args: readonly string[] = []): Promise<T> {
      const output = await execGh([
        "api",
        endpoint,
        "--method",
        "GET",
        ...args,
      ]);
      return JSON.parse(output || "null") as T;
    },
    async jsonWithBody<T = unknown>(
      endpoint: string,
      method: "PATCH" | "POST",
      body: unknown,
    ): Promise<T> {
      const directory = await mkdtemp(
        path.join(tmpdir(), "open-maintainer-gh-"),
      );
      const inputPath = path.join(directory, "body.json");
      try {
        await writeFile(inputPath, JSON.stringify(body));
        const output = await execGh([
          "api",
          endpoint,
          "--method",
          method,
          "--input",
          inputPath,
        ]);
        return JSON.parse(output || "null") as T;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async noBody(endpoint: string, method: "DELETE"): Promise<void> {
      await execGh(["api", endpoint, "--method", method]);
    },
  };
}

export async function execGitHubCli(
  repoRoot: string,
  args: readonly string[],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", [...args], {
      cwd: repoRoot,
      env: gitHubCliEnv(),
      maxBuffer: gitHubCliMaxBuffer,
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `GitHub CLI command failed: gh ${args.join(" ")}. ${message}`,
    );
  }
}

export function gitHubCliEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  if (
    nextEnv["CI"] !== "true" &&
    nextEnv["GITHUB_ACTIONS"] !== "true" &&
    nextEnv["OPEN_MAINTAINER_USE_ENV_GH_TOKEN"] !== "1"
  ) {
    nextEnv["GH_TOKEN"] = undefined;
    nextEnv["GITHUB_TOKEN"] = undefined;
  }
  return nextEnv;
}

export type GitHubInstallationEvent = {
  installation: {
    id: number;
    account: { login: string; type: string } | null;
    repository_selection: string;
    permissions?: Record<string, string>;
  };
  repositories?: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch?: string;
    permissions?: Record<string, boolean>;
  }>;
};

export type GitHubAppInstallationAuth = {
  appId: string | number;
  privateKey: string;
  installationId: string | number;
};

type GitHubFileContent = {
  type?: string;
  encoding?: string;
  content?: string;
  size?: number;
  sha?: string;
  path?: string;
};

type GitHubContentData = GitHubFileContent | GitHubFileContent[];

type GitHubPullRequestData = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user?: { login?: string } | null;
  state?: string | null;
  merged_at?: string | null;
  draft?: boolean | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  requested_reviewers?: Array<{ login?: string | null }> | null;
  requested_teams?: Array<{ name?: string | null }> | null;
  assignees?: Array<{ login?: string | null }> | null;
  labels?: Array<string | { name?: string | null }> | null;
  review_comments?: number | null;
  comments?: number | null;
  commits?: number | null;
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
};

type GitHubPullRequestListData = Partial<GitHubPullRequestData> & {
  number: number;
  html_url?: string | null;
};

type GitHubPullRequestFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
};

type GitHubPullRequestCommit = {
  sha: string;
  html_url?: string | null;
  commit?: {
    message?: string | null;
    author?: { name?: string | null; date?: string | null } | null;
  };
  author?: { login?: string | null } | null;
};

type GitHubPullRequestReview = {
  id: number;
  body?: string | null;
  state?: string | null;
  html_url?: string | null;
  user?: { login?: string | null } | null;
  submitted_at?: string | null;
};

type GitHubIssueComment = {
  id: number;
  body?: string | null;
  html_url?: string | null;
  user?: { login?: string } | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type GitHubReviewComment = GitHubIssueComment & {
  path?: string | null;
  line?: number | null;
};

type GitHubIssueData = {
  number: number;
  title: string;
  body: string | null;
  html_url?: string | null;
  user?: { login?: string } | null;
  labels?: Array<string | { name?: string | null }>;
  state?: string;
  created_at?: string | null;
  updated_at?: string | null;
};

type GitHubIssueSearchItem = {
  number: number;
  title: string;
  html_url?: string | null;
  pull_request?: unknown;
};

type GitHubCheckRun = {
  name: string;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
};

type GitHubStatus = {
  context: string;
  state: string;
  target_url?: string | null;
};

export type GitHubRepositoryClient = {
  repos: {
    getContent(input: {
      owner: string;
      repo: string;
      path: string;
      ref?: string;
    }): Promise<{ data: GitHubContentData }>;
    createOrUpdateFileContents(input: {
      owner: string;
      repo: string;
      path: string;
      message: string;
      content: string;
      branch: string;
      sha?: string;
    }): Promise<{ data: { commit?: { sha?: string } } }>;
    getCombinedStatusForRef?(input: {
      owner: string;
      repo: string;
      ref: string;
    }): Promise<{ data: { statuses: GitHubStatus[] } }>;
  };
  git: {
    getRef(input: {
      owner: string;
      repo: string;
      ref: string;
    }): Promise<{ data: { object: { sha: string } } }>;
    createRef(input: {
      owner: string;
      repo: string;
      ref: string;
      sha: string;
    }): Promise<unknown>;
    updateRef(input: {
      owner: string;
      repo: string;
      ref: string;
      sha: string;
      force: boolean;
    }): Promise<unknown>;
    getTree?(input: {
      owner: string;
      repo: string;
      tree_sha: string;
      recursive?: "true";
    }): Promise<{
      data: {
        tree: Array<{
          path?: string;
          type?: string;
          size?: number;
        }>;
      };
    }>;
  };
  pulls: {
    get?(input: {
      owner: string;
      repo: string;
      pull_number: number;
    }): Promise<{ data: GitHubPullRequestData }>;
    list(input: {
      owner: string;
      repo: string;
      state?: "open" | "closed" | "all";
      head?: string;
      base?: string;
      sort?: "created" | "updated" | "popularity" | "long-running";
      direction?: "asc" | "desc";
      per_page?: number;
      page?: number;
    }): Promise<{ data: GitHubPullRequestListData[] }>;
    create(input: {
      owner: string;
      repo: string;
      title: string;
      head: string;
      base: string;
      body: string;
    }): Promise<{ data: { number: number; html_url: string } }>;
    update(input: {
      owner: string;
      repo: string;
      pull_number: number;
      title: string;
      body: string;
    }): Promise<{ data: { number: number; html_url: string } }>;
    listFiles?(input: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{ data: GitHubPullRequestFile[] }>;
    listCommits?(input: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{ data: GitHubPullRequestCommit[] }>;
    listReviewComments?(input: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{ data: GitHubReviewComment[] }>;
    listReviews?(input: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{ data: GitHubPullRequestReview[] }>;
    createReview?(input: {
      owner: string;
      repo: string;
      pull_number: number;
      event: "COMMENT";
      body?: string;
      comments: Array<{
        path: string;
        line: number;
        side: "RIGHT";
        body: string;
      }>;
    }): Promise<{ data: { id: number; html_url?: string | null } }>;
  };
  issues?: {
    get?(input: {
      owner: string;
      repo: string;
      issue_number: number;
    }): Promise<{ data: GitHubIssueData }>;
    listComments?(input: {
      owner: string;
      repo: string;
      issue_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{ data: GitHubIssueComment[] }>;
    createComment?(input: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<{ data: { id: number; html_url?: string | null } }>;
    updateComment?(input: {
      owner: string;
      repo: string;
      comment_id: number;
      body: string;
    }): Promise<{ data: { id: number; html_url?: string | null } }>;
    createLabel?(input: {
      owner: string;
      repo: string;
      name: string;
      color: string;
      description?: string;
    }): Promise<unknown>;
    addLabels?(input: {
      owner: string;
      repo: string;
      issue_number: number;
      labels: string[];
    }): Promise<unknown>;
  };
  search?: {
    issuesAndPullRequests?(input: {
      q: string;
      per_page?: number;
      page?: number;
    }): Promise<{ data: { items: GitHubIssueSearchItem[] } }>;
  };
  checks?: {
    listForRef?(input: {
      owner: string;
      repo: string;
      ref: string;
      per_page?: number;
      page?: number;
    }): Promise<{ data: { check_runs: GitHubCheckRun[] } }>;
  };
};

export type RepositoryContentLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export type FetchedRepositoryFile = {
  path: string;
  content: string;
  size: number;
  sha: string | null;
};

export type SkippedRepositoryFile = {
  path: string;
  reason:
    | "filtered"
    | "max_files"
    | "max_file_bytes"
    | "max_total_bytes"
    | "not_file"
    | "not_found";
};

export const OPEN_MAINTAINER_REVIEW_SUMMARY_MARKER =
  "<!-- open-maintainer-review-summary -->";
export const OPEN_MAINTAINER_REVIEW_INLINE_MARKER =
  "<!-- open-maintainer-review-inline -->";

export type ReviewSummaryCommentPlan =
  | {
      action: "create";
      body: string;
      existingCommentId: null;
    }
  | {
      action: "update";
      body: string;
      existingCommentId: number;
    };

export type ReviewSummaryCommentResult = ReviewSummaryCommentPlan & {
  commentId: number;
  url: string | null;
};

export type ReviewInlineCommentPlan = {
  comments: Array<{
    findingId: string;
    severity: ReviewSeverity;
    path: string;
    line: number;
    body: string;
    fingerprint: string;
  }>;
  skipped: Array<{
    findingId: string;
    reason:
      | "missing_path"
      | "missing_line"
      | "unchanged_path"
      | "missing_patch"
      | "duplicate"
      | "cap_reached";
  }>;
};

export type ReviewInlineCommentResult = ReviewInlineCommentPlan & {
  reviewId: number | null;
  url: string | null;
};

export const DEFAULT_REPOSITORY_CONTENT_LIMITS: RepositoryContentLimits = {
  maxFiles: 80,
  maxFileBytes: 128 * 1024,
  maxTotalBytes: 768 * 1024,
};

const SKIPPED_PATH_SEGMENTS = new Set([
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

const SKIPPED_EXTENSIONS = new Set([
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

export function createGitHubInstallationClient(
  auth: GitHubAppInstallationAuth,
): GitHubRepositoryClient {
  return new Octokit({
    authStrategy: createAppAuth,
    auth,
  }) as GitHubRepositoryClient;
}

function resolveGitHubClient(input: {
  client?: GitHubRepositoryClient;
  auth?: GitHubAppInstallationAuth;
}): GitHubRepositoryClient {
  if (input.client) {
    return input.client;
  }
  if (input.auth) {
    return createGitHubInstallationClient(input.auth);
  }
  throw new Error(
    "Provide either a GitHub client or GitHub App installation auth.",
  );
}

export function verifyWebhookSignature(options: {
  secret: string;
  payload: string;
  signature256: string;
}): boolean {
  const expected = `sha256=${createHmac("sha256", options.secret).update(options.payload).digest("hex")}`;
  const actual = options.signature256;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

export function mapInstallationEvent(event: GitHubInstallationEvent): {
  installation: Installation;
  repos: Repo[];
} {
  const accountLogin = event.installation.account?.login ?? "unknown";
  const installation: Installation = {
    id: String(event.installation.id),
    accountLogin,
    accountType: event.installation.account?.type ?? "Unknown",
    repositorySelection: event.installation.repository_selection,
    permissions: event.installation.permissions ?? {},
    createdAt: nowIso(),
  };

  const repos = (event.repositories ?? []).map((repo) => {
    const [owner = accountLogin, name = repo.name] = repo.full_name.split("/");
    return {
      id: String(repo.id),
      installationId: installation.id,
      owner,
      name,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch ?? "main",
      private: repo.private,
      permissions: repo.permissions ?? {},
    };
  });

  return { installation, repos };
}

export function shouldSkipRepositoryPath(path: string): boolean {
  const normalizedPath = path.replace(/^\/+/, "");
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
    segments.some((segment) => SKIPPED_PATH_SEGMENTS.has(segment)) ||
    SKIPPED_EXTENSIONS.has(extension) ||
    lowerPath.endsWith(".min.js") ||
    lowerPath.endsWith(".min.css")
  );
}

export const DEFAULT_REPOSITORY_ANALYSIS_PATHS = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "biome.json",
  "docker-compose.yml",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Scarb.toml",
  ".github/copilot-instructions.md",
  ".github/workflows/ci.yml",
  ".github/workflows/test.yml",
  ".github/workflows/build.yml",
  ".open-maintainer.yml",
  ".open-maintainer/profile.json",
  ".open-maintainer/report.md",
];

export async function listRepositoryTreePaths(input: {
  owner: string;
  repo: string;
  ref: string;
  client?: GitHubRepositoryClient;
  auth?: GitHubAppInstallationAuth;
}): Promise<string[]> {
  const client = resolveGitHubClient(input);
  if (!client.git.getTree) {
    return DEFAULT_REPOSITORY_ANALYSIS_PATHS;
  }
  const tree = await client.git.getTree({
    owner: input.owner,
    repo: input.repo,
    tree_sha: input.ref,
    recursive: "true",
  });
  const paths = tree.data.tree
    .filter((item) => item.type === "blob" && item.path)
    .map((item) => item.path as string)
    .filter((repoPath) => !shouldSkipRepositoryPath(repoPath));
  return paths.length > 0 ? paths : DEFAULT_REPOSITORY_ANALYSIS_PATHS;
}

export async function fetchRepositoryFilesForAnalysis(input: {
  owner: string;
  repo: string;
  ref: string;
  limits?: Partial<RepositoryContentLimits>;
  client?: GitHubRepositoryClient;
  auth?: GitHubAppInstallationAuth;
}): Promise<{
  files: FetchedRepositoryFile[];
  skipped: SkippedRepositoryFile[];
}> {
  const client = resolveGitHubClient(input);
  const paths = await listRepositoryTreePaths({
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
    client,
  });
  return fetchRepositoryContents({
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
    paths,
    client,
    ...(input.limits ? { limits: input.limits } : {}),
  });
}

export async function fetchPullRequestReviewContext(input: {
  repoId: string;
  owner: string;
  repo: string;
  pullNumber: number;
  linkedIssueNumbers?: number[];
  limits?: Partial<RepositoryContentLimits>;
  client?: GitHubRepositoryClient;
  auth?: GitHubAppInstallationAuth;
}): Promise<ReviewInput> {
  const client = resolveGitHubClient(input);
  if (!client.pulls.get || !client.pulls.listFiles) {
    throw new Error("GitHub pull request read APIs are unavailable.");
  }
  const limits = {
    ...DEFAULT_REPOSITORY_CONTENT_LIMITS,
    ...input.limits,
  };
  const pull = (
    await client.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
    })
  ).data;
  const listFiles = client.pulls.listFiles;
  const files = await listPaginated((page) =>
    listFiles({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
      per_page: 100,
      page,
    }),
  );
  const listCommits = client.pulls.listCommits;
  const commits = listCommits
    ? await listPaginated((page) =>
        listCommits({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pullNumber,
          per_page: 100,
          page,
        }),
      )
    : [];
  const listIssueComments = client.issues?.listComments;
  const issueComments = listIssueComments
    ? await listPaginated((page) =>
        listIssueComments({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.pullNumber,
          per_page: 100,
          page,
        }),
      )
    : [];
  const listReviewComments = client.pulls.listReviewComments;
  const reviewComments = listReviewComments
    ? await listPaginated((page) =>
        listReviewComments({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pullNumber,
          per_page: 100,
          page,
        }),
      )
    : [];
  const issueNumbers = [
    ...new Set([
      ...extractLinkedIssueNumbers(pull.body ?? ""),
      ...(input.linkedIssueNumbers ?? []),
    ]),
  ].filter((issueNumber) => issueNumber !== input.pullNumber);
  const issueContext = await fetchIssueContext({
    owner: input.owner,
    repo: input.repo,
    issueNumbers,
    client,
  });
  const { changedFiles, skippedFiles } = boundedReviewFiles(files, limits);

  return {
    repoId: input.repoId,
    owner: input.owner,
    repo: input.repo,
    prNumber: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    url: pull.html_url,
    author: pull.user?.login ?? null,
    isDraft: pull.draft ?? null,
    mergeable:
      pull.mergeable === null || pull.mergeable === undefined
        ? null
        : pull.mergeable
          ? "MERGEABLE"
          : "CONFLICTING",
    mergeStateStatus: pull.mergeable_state ?? null,
    reviewDecision: null,
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    changedFiles,
    commits: commits.map((commit) => commit.sha),
    checkStatuses: await fetchCheckStatuses({
      owner: input.owner,
      repo: input.repo,
      ref: pull.head.sha,
      client,
    }),
    issueContext,
    existingComments: [
      ...issueComments
        .filter((comment) => isOpenMaintainerReviewComment(comment.body ?? ""))
        .map((comment) => ({
          id: comment.id,
          kind: "summary" as const,
          body: comment.body ?? "",
          path: null,
          line: null,
        })),
      ...reviewComments
        .filter((comment) => isOpenMaintainerReviewComment(comment.body ?? ""))
        .map((comment) => ({
          id: comment.id,
          kind: "inline" as const,
          body: comment.body ?? "",
          path: comment.path ?? null,
          line: comment.line ?? null,
        })),
    ],
    skippedFiles,
    createdAt: nowIso(),
  };
}

export async function listPullRequestsForDashboard(input: {
  owner: string;
  repo: string;
  state?: "open" | "closed" | "all";
  search?: string;
  sort?: "created" | "updated" | "number";
  direction?: "asc" | "desc";
  client?: GitHubRepositoryClient;
  auth?: GitHubAppInstallationAuth;
}): Promise<PullRequestListItem[]> {
  const client = resolveGitHubClient(input);
  const pullRequests = await listPaginated((page) =>
    client.pulls.list({
      owner: input.owner,
      repo: input.repo,
      state: input.state ?? "open",
      sort: input.sort === "number" ? "updated" : (input.sort ?? "updated"),
      direction: input.direction ?? "desc",
      per_page: 100,
      page,
    }),
  );
  return sortPullRequests(
    filterPullRequests(
      pullRequests.map((pullRequest) =>
        mapPullRequestListItem(pullRequest, {
          checks: [],
          changedFiles: null,
        }),
      ),
      input.search ?? "",
    ),
    input.sort ?? "updated",
    input.direction ?? "desc",
  );
}

export async function fetchPullRequestDetailForDashboard(input: {
  repoId: string;
  owner: string;
  repo: string;
  pullNumber: number;
  limits?: Partial<RepositoryContentLimits>;
  client?: GitHubRepositoryClient;
  auth?: GitHubAppInstallationAuth;
}): Promise<PullRequestDetail> {
  const client = resolveGitHubClient(input);
  if (!client.pulls.get || !client.pulls.listFiles) {
    throw new Error("GitHub pull request read APIs are unavailable.");
  }
  const pull = (
    await client.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
    })
  ).data;
  const limits = {
    ...DEFAULT_REPOSITORY_CONTENT_LIMITS,
    ...input.limits,
  };
  const listFiles = client.pulls.listFiles;
  const files = await listPaginated((page) =>
    listFiles({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
      per_page: 100,
      page,
    }),
  );
  const { changedFiles, skippedFiles } = boundedReviewFiles(files, limits);
  const listCommits = client.pulls.listCommits;
  const commits = listCommits
    ? mapPullRequestCommits(
        await listPaginated((page) =>
          listCommits({
            owner: input.owner,
            repo: input.repo,
            pull_number: input.pullNumber,
            per_page: 100,
            page,
          }),
        ),
      )
    : [];
  const listIssueComments = client.issues?.listComments;
  const issueComments = listIssueComments
    ? await listPaginated((page) =>
        listIssueComments({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.pullNumber,
          per_page: 100,
          page,
        }),
      )
    : [];
  const listReviewComments = client.pulls.listReviewComments;
  const reviewComments = listReviewComments
    ? await listPaginated((page) =>
        listReviewComments({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pullNumber,
          per_page: 100,
          page,
        }),
      )
    : [];
  const listReviews = client.pulls.listReviews;
  const reviews = listReviews
    ? await listPaginated((page) =>
        listReviews({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pullNumber,
          per_page: 100,
          page,
        }),
      )
    : [];
  const checks = await fetchCheckStatuses({
    owner: input.owner,
    repo: input.repo,
    ref: pull.head.sha,
    client,
  });
  const detail = {
    summary: mapPullRequestListItem(pull, {
      checks,
      changedFiles,
    }),
    body: pull.body ?? "",
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    mergeable: mapMergeable(pull.mergeable),
    mergeStateStatus: pull.mergeable_state ?? null,
    reviewDecision: null,
    files: changedFiles,
    skippedFiles,
    commits,
    timeline: pullRequestTimeline({
      pull,
      issueComments,
      reviewComments,
      reviews,
    }),
    checks,
  } satisfies PullRequestDetail;
  return PullRequestDetailSchema.parse(detail);
}

export async function applyPullRequestLabelsForDashboard(input: {
  owner: string;
  repo: string;
  pullNumber: number;
  labels: Array<{
    name: string;
    color: string;
    description: string;
  }>;
  client?: GitHubRepositoryClient;
  auth?: GitHubAppInstallationAuth;
}): Promise<string[]> {
  const client = resolveGitHubClient(input);
  const createLabel = client.issues?.createLabel;
  const addLabels = client.issues?.addLabels;
  if (!createLabel || !addLabels) {
    throw new Error("GitHub label write APIs are unavailable.");
  }

  for (const label of input.labels) {
    try {
      await createLabel({
        owner: input.owner,
        repo: input.repo,
        name: label.name,
        color: label.color,
        description: label.description,
      });
    } catch (error) {
      if (!isAlreadyExistsGitHubError(error)) {
        throw error;
      }
    }
  }

  const labelNames = input.labels.map((label) => label.name);
  if (labelNames.length === 0) {
    return [];
  }
  await addLabels({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.pullNumber,
    labels: labelNames,
  });
  return labelNames;
}

async function listPaginated<T>(
  fetchPage: (page: number) => Promise<{ data: T[] } | undefined>,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchPage(page);
    const pageItems = response?.data ?? [];
    items.push(...pageItems);
    if (pageItems.length < 100) {
      return items;
    }
  }
}

function mapPullRequestListItem(
  pull: GitHubPullRequestListData,
  context: {
    checks: ReviewCheckStatus[];
    changedFiles: ReviewChangedFile[] | null;
  },
): PullRequestListItem {
  const labels = labelNames(pull.labels ?? []);
  const title = pull.title ?? `Pull request #${pull.number}`;
  const body = pull.body ?? "";
  const headRef = pull.head?.ref ?? "head";
  const additions =
    pull.additions ??
    context.changedFiles?.reduce((total, file) => total + file.additions, 0) ??
    0;
  const deletions =
    pull.deletions ??
    context.changedFiles?.reduce((total, file) => total + file.deletions, 0) ??
    0;
  const changedFileCount =
    pull.changed_files ?? context.changedFiles?.length ?? 0;
  const item = {
    number: pull.number,
    title,
    bodyPreview: compactPreview(body, 180),
    url: pull.html_url ?? null,
    author: pull.user?.login ?? null,
    state: pullRequestState(pull),
    isDraft: pull.draft ?? null,
    labels,
    reviewers: reviewerNames(pull),
    assignees: userNames(pull.assignees ?? []),
    baseRef: pull.base?.ref ?? "base",
    headRef,
    headSha: pull.head?.sha ?? null,
    createdAt: pull.created_at ?? null,
    updatedAt: pull.updated_at ?? null,
    comments: pull.comments ?? 0,
    reviewComments: pull.review_comments ?? 0,
    commits: pull.commits ?? 0,
    changedFiles: changedFileCount,
    additions,
    deletions,
    reviewDecision: null,
    mergeable: mapMergeable(pull.mergeable),
    mergeStateStatus: pull.mergeable_state ?? null,
    checksSummary: summarizeChecks(context.checks),
    attention: pullRequestAttention({
      isDraft: pull.draft ?? null,
      reviewDecision: null,
      mergeable: mapMergeable(pull.mergeable),
      mergeStateStatus: pull.mergeable_state ?? null,
      checks: context.checks,
    }),
    unread: false,
    triageTags: inferPullRequestTriageTags({
      author: pull.user?.login ?? null,
      body,
      files: context.changedFiles,
      headRef,
      labels,
      title,
    }),
  } satisfies PullRequestListItem;
  return PullRequestListItemSchema.parse(item);
}

function pullRequestState(
  pull: Pick<GitHubPullRequestListData, "state" | "merged_at">,
): PullRequestListItem["state"] {
  if (pull.merged_at) {
    return "merged";
  }
  return pull.state === "closed" ? "closed" : "open";
}

function mapMergeable(value: boolean | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return value ? "MERGEABLE" : "CONFLICTING";
}

function labelNames(
  labels: Array<string | { name?: string | null }>,
): string[] {
  return labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((label): label is string => Boolean(label));
}

function userNames(users: Array<{ login?: string | null }>): string[] {
  return users
    .map((user) => user.login)
    .filter((login): login is string => Boolean(login));
}

function reviewerNames(
  pull: Pick<
    GitHubPullRequestListData,
    "requested_reviewers" | "requested_teams"
  >,
): string[] {
  return [
    ...userNames(pull.requested_reviewers ?? []),
    ...(pull.requested_teams ?? [])
      .map((team) => team.name)
      .filter((name): name is string => Boolean(name)),
  ];
}

function summarizeChecks(
  checks: readonly ReviewCheckStatus[],
): PullRequestListItem["checksSummary"] {
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
    } else if (["skipped"].includes(conclusion)) {
      summary.skipped += 1;
    } else {
      summary.pending += 1;
    }
  }
  return summary;
}

function pullRequestAttention(input: {
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

function mapPullRequestCommits(
  commits: readonly GitHubPullRequestCommit[],
): PullRequestCommit[] {
  return commits.map((commit) => ({
    sha: commit.sha,
    message: commit.commit?.message?.split(/\r?\n/)[0] ?? null,
    author: commit.author?.login ?? commit.commit?.author?.name ?? null,
    authoredAt: commit.commit?.author?.date ?? null,
    url: commit.html_url ?? null,
  }));
}

function pullRequestTimeline(input: {
  pull: GitHubPullRequestData;
  issueComments: readonly GitHubIssueComment[];
  reviewComments: readonly GitHubReviewComment[];
  reviews: readonly GitHubPullRequestReview[];
}): PullRequestTimelineItem[] {
  const items: PullRequestTimelineItem[] = [
    {
      id: `opened-${input.pull.number}`,
      kind: "opened",
      author: input.pull.user?.login ?? null,
      body: input.pull.body ?? "",
      state: null,
      path: null,
      line: null,
      url: input.pull.html_url ?? null,
      createdAt: input.pull.created_at ?? null,
      updatedAt: input.pull.updated_at ?? null,
    },
    ...input.issueComments.map((comment) => ({
      id: `comment-${comment.id}`,
      kind: "comment" as const,
      author: comment.user?.login ?? null,
      body: comment.body ?? "",
      state: null,
      path: null,
      line: null,
      url: comment.html_url ?? null,
      createdAt: comment.created_at ?? null,
      updatedAt: comment.updated_at ?? null,
    })),
    ...input.reviews.map((review) => ({
      id: `review-${review.id}`,
      kind: "review" as const,
      author: review.user?.login ?? null,
      body: review.body ?? "",
      state: review.state ?? null,
      path: null,
      line: null,
      url: review.html_url ?? null,
      createdAt: review.submitted_at ?? null,
      updatedAt: review.submitted_at ?? null,
    })),
    ...input.reviewComments.map((comment) => ({
      id: `review-comment-${comment.id}`,
      kind: "review_comment" as const,
      author: comment.user?.login ?? null,
      body: comment.body ?? "",
      state: null,
      path: comment.path ?? null,
      line: comment.line ?? null,
      url: comment.html_url ?? null,
      createdAt: comment.created_at ?? null,
      updatedAt: comment.updated_at ?? null,
    })),
  ];
  return items.sort(
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
      pullRequest.author ?? "",
      pullRequest.number.toString(),
      pullRequest.labels.join(" "),
      pullRequest.triageTags
        .map((tag) => `${tag.label} ${tag.githubLabel}`)
        .join(" "),
      pullRequest.bodyPreview,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query),
  );
}

function sortPullRequests(
  pullRequests: PullRequestListItem[],
  sort: "created" | "updated" | "number",
  direction: "asc" | "desc",
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

function boundedReviewFiles(
  files: GitHubPullRequestFile[],
  limits: RepositoryContentLimits,
): {
  changedFiles: ReviewChangedFile[];
  skippedFiles: ReviewSkippedFile[];
} {
  const changedFiles: ReviewChangedFile[] = [];
  const skippedFiles: ReviewSkippedFile[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const path = file.filename.replace(/^\/+/, "");
    const patch = file.patch ?? null;
    const patchBytes = patch ? Buffer.byteLength(patch, "utf8") : 0;
    if (shouldSkipRepositoryPath(path)) {
      skippedFiles.push({ path, reason: "filtered" });
      continue;
    }
    if (changedFiles.length >= limits.maxFiles) {
      skippedFiles.push({ path, reason: "max_files" });
      continue;
    }
    if (!patch && file.status !== "removed") {
      skippedFiles.push({ path, reason: "unavailable" });
      continue;
    }
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
      status: mapGitHubFileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions,
      patch,
      previousPath: file.previous_filename ?? null,
    });
  }

  return { changedFiles, skippedFiles };
}

function mapGitHubFileStatus(status: string): ReviewChangedFile["status"] {
  if (status === "added") {
    return "added";
  }
  if (status === "removed") {
    return "removed";
  }
  if (status === "renamed") {
    return "renamed";
  }
  if (status === "copied") {
    return "copied";
  }
  return "modified";
}

async function fetchCheckStatuses(input: {
  owner: string;
  repo: string;
  ref: string;
  client: GitHubRepositoryClient;
}): Promise<ReviewCheckStatus[]> {
  const checks = input.client.checks?.listForRef
    ? await listCheckRuns(input)
    : [];
  const statuses = input.client.repos.getCombinedStatusForRef
    ? (
        await input.client.repos.getCombinedStatusForRef({
          owner: input.owner,
          repo: input.repo,
          ref: input.ref,
        })
      ).data.statuses.map((status) => ({
        name: status.context,
        status: status.state,
        conclusion: status.state,
        url: status.target_url ?? null,
      }))
    : [];
  return [...checks, ...statuses];
}

async function listCheckRuns(input: {
  owner: string;
  repo: string;
  ref: string;
  client: GitHubRepositoryClient;
}): Promise<ReviewCheckStatus[]> {
  const checkRuns = await listPaginated(async (page) => {
    const response = await input.client.checks?.listForRef?.({
      owner: input.owner,
      repo: input.repo,
      ref: input.ref,
      per_page: 100,
      page,
    });
    return response
      ? { data: response.data.check_runs }
      : { data: [] as GitHubCheckRun[] };
  });
  return checkRuns.map((check) => ({
    name: check.name,
    status: check.status ?? "unknown",
    conclusion: check.conclusion ?? null,
    url: check.html_url ?? null,
  }));
}

async function fetchIssueContext(input: {
  owner: string;
  repo: string;
  issueNumbers: number[];
  client: GitHubRepositoryClient;
}): Promise<ReviewIssueContext[]> {
  if (!input.client.issues?.get) {
    return [];
  }
  const issues: ReviewIssueContext[] = [];
  for (const issueNumber of input.issueNumbers) {
    const issue = (
      await input.client.issues.get({
        owner: input.owner,
        repo: input.repo,
        issue_number: issueNumber,
      })
    ).data;
    issues.push({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      acceptanceCriteria: extractAcceptanceCriteria(issue.body ?? ""),
      url: issue.html_url ?? null,
    });
  }
  return issues;
}

export async function fetchIssueTriageEvidence(input: {
  repoId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  sourceProfileVersion?: number | null;
  contextArtifactVersion?: number | null;
  maxComments?: number;
  maxRelatedIssues?: number;
  client?: GitHubRepositoryClient;
  auth?: GitHubAppInstallationAuth;
}): Promise<IssueTriageEvidence> {
  const client = resolveGitHubClient(input);
  if (!client.issues?.get) {
    throw new Error("GitHub issue read API is unavailable.");
  }
  const issue = (
    await client.issues.get({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.issueNumber,
    })
  ).data;
  const maxComments = input.maxComments ?? 20;
  const maxRelatedIssues = input.maxRelatedIssues ?? 8;
  const skippedEvidence: IssueTriageSkippedEvidence[] = [];
  const comments = await fetchIssueCommentsForTriage({
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    maxComments,
    client,
    skippedEvidence,
  });
  const relatedIssues = await fetchRelatedIssuesForTriage({
    owner: input.owner,
    repo: input.repo,
    issue,
    comments,
    maxRelatedIssues,
    client,
    skippedEvidence,
  });

  return buildIssueTriageEvidence({
    repoId: input.repoId,
    owner: input.owner,
    repo: input.repo,
    issue: mapIssueTriageMetadata(issue),
    comments,
    relatedIssues,
    sourceProfileVersion: input.sourceProfileVersion ?? null,
    contextArtifactVersion: input.contextArtifactVersion ?? null,
    skippedEvidence,
  });
}

export function createGitHubIssueTriageEvidencePort(
  input: {
    client?: GitHubRepositoryClient;
    auth?: GitHubAppInstallationAuth;
    maxComments?: number;
    maxRelatedIssues?: number;
  } = {},
): Pick<IssueTriageGitHubPort, "fetchEvidence"> {
  return {
    fetchEvidence(request) {
      const evidenceInput: Parameters<typeof fetchIssueTriageEvidence>[0] = {
        ...request,
      };
      if (input.client) {
        evidenceInput.client = input.client;
      }
      if (input.auth) {
        evidenceInput.auth = input.auth;
      }
      if (input.maxComments !== undefined) {
        evidenceInput.maxComments = input.maxComments;
      }
      if (input.maxRelatedIssues !== undefined) {
        evidenceInput.maxRelatedIssues = input.maxRelatedIssues;
      }
      return fetchIssueTriageEvidence(evidenceInput);
    },
  };
}

async function fetchIssueCommentsForTriage(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  maxComments: number;
  client: GitHubRepositoryClient;
  skippedEvidence: IssueTriageSkippedEvidence[];
}): Promise<IssueTriageEvidenceCommentInput[]> {
  const listComments = input.client.issues?.listComments;
  if (!listComments) {
    input.skippedEvidence.push({
      source: "github_comment",
      reason: "GitHub issue comment API is unavailable.",
    });
    return [];
  }

  const comments: GitHubIssueComment[] = [];
  try {
    for (let page = 1; comments.length < input.maxComments; page += 1) {
      const response = await listComments({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issueNumber,
        per_page: Math.min(100, input.maxComments - comments.length),
        page,
      });
      comments.push(...response.data);
      if (response.data.length < 100) {
        break;
      }
    }
  } catch (error) {
    input.skippedEvidence.push({
      source: "github_comment",
      reason: `GitHub issue comments could not be fetched: ${errorMessage(error)}`,
    });
    return [];
  }

  if (comments.length >= input.maxComments) {
    input.skippedEvidence.push({
      source: "github_comment",
      reason: `Issue comments were capped at ${input.maxComments}.`,
    });
  }

  return comments.map((comment) => ({
    id: comment.id,
    body: comment.body ?? "",
    author: comment.user?.login ?? null,
    url: comment.html_url ?? null,
    createdAt: comment.created_at ?? null,
    updatedAt: comment.updated_at ?? null,
  }));
}

async function fetchRelatedIssuesForTriage(input: {
  owner: string;
  repo: string;
  issue: GitHubIssueData;
  comments: readonly IssueTriageEvidenceCommentInput[];
  maxRelatedIssues: number;
  client: GitHubRepositoryClient;
  skippedEvidence: IssueTriageSkippedEvidence[];
}): Promise<IssueTriageRelatedIssue[]> {
  const related = new Map<number, IssueTriageRelatedIssue>();
  const text = [
    input.issue.title,
    input.issue.body ?? "",
    ...input.comments.map((comment) => comment.body),
  ].join("\n\n");
  const referencedNumbers = extractReferencedIssueNumbers(text)
    .filter((issueNumber: number) => issueNumber !== input.issue.number)
    .slice(0, input.maxRelatedIssues);

  for (const issueNumber of referencedNumbers) {
    try {
      const issue = (
        await input.client.issues?.get?.({
          owner: input.owner,
          repo: input.repo,
          issue_number: issueNumber,
        })
      )?.data;
      if (!issue) {
        input.skippedEvidence.push({
          source: "related_issue",
          reason: `Referenced issue #${issueNumber} could not be fetched because GitHub issue read API is unavailable.`,
        });
        continue;
      }
      related.set(issue.number, {
        number: issue.number,
        title: issue.title,
        url: issue.html_url ?? null,
        reason: "Issue text references this issue or pull request.",
      });
    } catch (error) {
      input.skippedEvidence.push({
        source: "related_issue",
        reason: `Referenced issue #${issueNumber} could not be fetched: ${errorMessage(error)}`,
      });
    }
  }

  const remaining = input.maxRelatedIssues - related.size;
  if (remaining <= 0) {
    return [...related.values()];
  }

  const searchIssues = input.client.search?.issuesAndPullRequests;
  const query = buildRelatedIssueSearchQuery({
    owner: input.owner,
    repo: input.repo,
    title: input.issue.title,
  });
  if (!searchIssues || !query) {
    input.skippedEvidence.push({
      source: "related_issue",
      reason: !searchIssues
        ? "GitHub issue search API is unavailable."
        : "Issue title did not contain enough search terms for related issue lookup.",
    });
    return [...related.values()];
  }

  try {
    const response = await searchIssues({
      q: query,
      per_page: Math.min(remaining + 1, 10),
      page: 1,
    });
    for (const item of response.data.items) {
      if (related.size >= input.maxRelatedIssues) {
        break;
      }
      if (item.number === input.issue.number || item.pull_request) {
        continue;
      }
      related.set(item.number, {
        number: item.number,
        title: item.title,
        url: item.html_url ?? null,
        reason: "GitHub issue search found a related title candidate.",
      });
    }
  } catch (error) {
    input.skippedEvidence.push({
      source: "related_issue",
      reason: `GitHub related issue search failed: ${errorMessage(error)}`,
    });
  }

  return [...related.values()];
}

function mapIssueTriageMetadata(
  issue: GitHubIssueData,
): IssueTriageIssueMetadata {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    author: issue.user?.login ?? null,
    labels: (issue.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((label): label is string => Boolean(label)),
    state: issue.state === "closed" ? "closed" : "open",
    url: issue.html_url ?? null,
    createdAt: issue.created_at ?? nowIso(),
    updatedAt: issue.updated_at ?? nowIso(),
  };
}

function buildRelatedIssueSearchQuery(input: {
  owner: string;
  repo: string;
  title: string;
}): string | null {
  const terms = input.title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 4 && !RELATED_SEARCH_STOP_WORDS.has(term))
    .slice(0, 5);
  if (terms.length < 2) {
    return null;
  }
  return `repo:${input.owner}/${input.repo} is:issue in:title ${terms.join(" ")}`;
}

const RELATED_SEARCH_STOP_WORDS = new Set([
  "with",
  "from",
  "that",
  "this",
  "issue",
  "issues",
  "open",
  "close",
  "closed",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function extractLinkedIssueNumbers(text: string): number[] {
  const issueNumbers = new Set<number>();
  const pattern =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/gi;
  for (const match of text.matchAll(pattern)) {
    const issueNumber = Number(match[1]);
    if (Number.isInteger(issueNumber) && issueNumber > 0) {
      issueNumbers.add(issueNumber);
    }
  }
  return [...issueNumbers];
}

export function extractAcceptanceCriteria(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const criteria: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,6}\s+acceptance criteria\b/i.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,6}\s+/.test(line.trim())) {
      break;
    }
    if (inSection) {
      const item = line
        .trim()
        .replace(/^- \[[ xX]\]\s+/, "")
        .replace(/^[-*]\s+/, "");
      if (item) {
        criteria.push(item);
      }
    }
  }
  return criteria;
}

export function isOpenMaintainerReviewComment(body: string): boolean {
  return (
    body.includes(OPEN_MAINTAINER_REVIEW_SUMMARY_MARKER) ||
    body.includes(OPEN_MAINTAINER_REVIEW_INLINE_MARKER) ||
    body.includes("## Open Maintainer PR Review")
  );
}

export function isOpenMaintainerReviewSummaryComment(body: string): boolean {
  return body.includes(OPEN_MAINTAINER_REVIEW_SUMMARY_MARKER);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  );
}

function isAlreadyExistsGitHubError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 422
  );
}

function getContentFile(data: GitHubContentData): GitHubFileContent | null {
  if (Array.isArray(data)) {
    return null;
  }
  if (data.type && data.type !== "file") {
    return null;
  }
  return data;
}

function decodeGitHubContent(file: GitHubFileContent): string | null {
  if (!file.content || file.encoding !== "base64") {
    return null;
  }
  return Buffer.from(file.content.replace(/\s/g, ""), "base64").toString(
    "utf8",
  );
}

export async function fetchRepositoryContents(input: {
  owner: string;
  repo: string;
  ref?: string;
  paths: string[];
  limits?: Partial<RepositoryContentLimits>;
  client?: GitHubRepositoryClient;
  auth?: GitHubAppInstallationAuth;
}): Promise<{
  files: FetchedRepositoryFile[];
  skipped: SkippedRepositoryFile[];
}> {
  const client = resolveGitHubClient(input);
  const limits = {
    ...DEFAULT_REPOSITORY_CONTENT_LIMITS,
    ...input.limits,
  };
  const files: FetchedRepositoryFile[] = [];
  const skipped: SkippedRepositoryFile[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;

  for (const path of input.paths) {
    const normalizedPath = path.replace(/^\/+/, "");
    if (!normalizedPath || seenPaths.has(normalizedPath)) {
      continue;
    }
    seenPaths.add(normalizedPath);

    if (shouldSkipRepositoryPath(normalizedPath)) {
      skipped.push({ path: normalizedPath, reason: "filtered" });
      continue;
    }
    if (files.length >= limits.maxFiles) {
      skipped.push({ path: normalizedPath, reason: "max_files" });
      continue;
    }

    try {
      const response = await client.repos.getContent({
        owner: input.owner,
        repo: input.repo,
        path: normalizedPath,
        ...(input.ref ? { ref: input.ref } : {}),
      });
      const file = getContentFile(response.data);
      const content = file ? decodeGitHubContent(file) : null;
      if (!file || content === null) {
        skipped.push({ path: normalizedPath, reason: "not_file" });
        continue;
      }

      const size = file.size ?? Buffer.byteLength(content, "utf8");
      if (size > limits.maxFileBytes) {
        skipped.push({ path: normalizedPath, reason: "max_file_bytes" });
        continue;
      }
      if (totalBytes + size > limits.maxTotalBytes) {
        skipped.push({ path: normalizedPath, reason: "max_total_bytes" });
        continue;
      }

      totalBytes += size;
      files.push({
        path: normalizedPath,
        content,
        size,
        sha: file.sha ?? null,
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        skipped.push({ path: normalizedPath, reason: "not_found" });
        continue;
      }
      throw error;
    }
  }

  return { files, skipped };
}

export function createContextBranchName(
  profileVersion: number,
  attempt = 0,
): string {
  const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
  return `open-maintainer/context-${profileVersion}${suffix}`;
}

export function renderContextPrBody(input: {
  repoProfileVersion: number;
  artifacts: GeneratedArtifact[];
  modelProvider: string | null;
  model: string | null;
  runReference: string;
  generatedAt: string;
}): string {
  const artifactRows = input.artifacts
    .map(
      (artifact) =>
        `| ${artifact.type} | profile v${artifact.sourceProfileVersion} |`,
    )
    .join("\n");
  const modelLine =
    input.modelProvider && input.model
      ? `${input.modelProvider} / ${input.model}`
      : "No external model metadata recorded";

  return [
    "## Open Maintainer Context Update",
    "",
    `Repo profile version: v${input.repoProfileVersion}`,
    `Generated at: ${input.generatedAt}`,
    `Dashboard run: ${input.runReference}`,
    `Model: ${modelLine}`,
    "",
    "| Artifact | Source |",
    "| --- | --- |",
    artifactRows,
    "",
    "This PR writes generated Open Maintainer context artifacts for review.",
    "`.open-maintainer.yml` is maintainer-editable before merge and becomes the repo-local source of truth after approval.",
  ].join("\n");
}

export function createMockContextPr(input: {
  repoId: string;
  profileVersion: number;
  artifacts: GeneratedArtifact[];
}): ContextPr {
  const branchName = createContextBranchName(input.profileVersion);
  return {
    id: newId("context_pr"),
    repoId: input.repoId,
    branchName,
    commitSha: `mock-${input.profileVersion}`,
    prNumber: input.profileVersion,
    prUrl: `https://github.com/mock/repo/pull/${input.profileVersion}`,
    artifactVersions: input.artifacts.map((artifact) => artifact.version),
    status: "succeeded",
    createdAt: nowIso(),
  };
}

export function renderMarkedReviewSummaryComment(markdown: string): string {
  const trimmed = markdown.trim();
  return trimmed.startsWith(OPEN_MAINTAINER_REVIEW_SUMMARY_MARKER)
    ? trimmed
    : `${OPEN_MAINTAINER_REVIEW_SUMMARY_MARKER}\n${trimmed}`;
}

export function planReviewSummaryComment(input: {
  markdown: string;
  existingComments: Array<{ id: number; body?: string | null }>;
}): ReviewSummaryCommentPlan {
  const body = renderMarkedReviewSummaryComment(input.markdown);
  const existing = input.existingComments.find((comment) =>
    isOpenMaintainerReviewSummaryComment(comment.body ?? ""),
  );
  return existing
    ? { action: "update", body, existingCommentId: existing.id }
    : { action: "create", body, existingCommentId: null };
}

export async function upsertReviewSummaryComment(input: {
  owner: string;
  repo: string;
  pullNumber: number;
  markdown: string;
  client: GitHubRepositoryClient;
}): Promise<ReviewSummaryCommentResult> {
  const listComments = input.client.issues?.listComments;
  const createComment = input.client.issues?.createComment;
  const updateComment = input.client.issues?.updateComment;
  if (!listComments || !createComment || !updateComment) {
    throw new Error(
      "Review summary posting requires GitHub issue comment read and write permissions.",
    );
  }
  const existingComments = await listPaginated((page) =>
    listComments({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.pullNumber,
      per_page: 100,
      page,
    }),
  );
  const plan = planReviewSummaryComment({
    markdown: input.markdown,
    existingComments,
  });
  const response =
    plan.action === "update"
      ? await updateComment({
          owner: input.owner,
          repo: input.repo,
          comment_id: plan.existingCommentId,
          body: plan.body,
        })
      : await createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.pullNumber,
          body: plan.body,
        });
  return {
    ...plan,
    commentId: response.data.id,
    url: response.data.html_url ?? null,
  };
}

export function planInlineReviewComments(input: {
  review: ReviewResult;
  existingComments: Array<{
    body?: string | null;
    path?: string | null;
    line?: number | null;
  }>;
  cap: number;
}): ReviewInlineCommentPlan {
  const cap = Math.max(0, input.cap);
  const changedFiles = new Map(
    input.review.changedFiles.map((file) => [file.path, file]),
  );
  const existingFingerprints = new Set(
    input.existingComments.flatMap((comment) => {
      const explicit = extractInlineFingerprint(comment.body ?? "");
      if (explicit) {
        return [explicit];
      }
      return comment.path && comment.line
        ? [`legacy:${comment.path}:${comment.line}`]
        : [];
    }),
  );
  const plan: ReviewInlineCommentPlan = { comments: [], skipped: [] };
  const orderedFindings = [...input.review.findings].sort((a, b) => {
    const severityDelta =
      reviewSeverityRank(a.severity) - reviewSeverityRank(b.severity);
    return severityDelta === 0 ? a.id.localeCompare(b.id) : severityDelta;
  });

  for (const finding of orderedFindings) {
    if (!finding.path) {
      plan.skipped.push({ findingId: finding.id, reason: "missing_path" });
      continue;
    }
    if (!finding.line) {
      plan.skipped.push({ findingId: finding.id, reason: "missing_line" });
      continue;
    }
    const changedFile = changedFiles.get(finding.path);
    if (!changedFile) {
      plan.skipped.push({ findingId: finding.id, reason: "unchanged_path" });
      continue;
    }
    if (!changedFile.patch) {
      plan.skipped.push({ findingId: finding.id, reason: "missing_patch" });
      continue;
    }
    const fingerprint = inlineCommentFingerprint({
      findingId: finding.id,
      path: finding.path,
      line: finding.line,
    });
    if (
      existingFingerprints.has(fingerprint) ||
      existingFingerprints.has(`legacy:${finding.path}:${finding.line}`)
    ) {
      plan.skipped.push({ findingId: finding.id, reason: "duplicate" });
      continue;
    }
    if (plan.comments.length >= cap) {
      plan.skipped.push({ findingId: finding.id, reason: "cap_reached" });
      continue;
    }
    plan.comments.push({
      findingId: finding.id,
      severity: finding.severity,
      path: finding.path,
      line: finding.line,
      fingerprint,
      body: renderInlineCommentBody({
        title: finding.title,
        severity: finding.severity,
        body: finding.body,
        fingerprint,
      }),
    });
  }

  return plan;
}

export async function publishInlineReviewComments(input: {
  owner: string;
  repo: string;
  pullNumber: number;
  review: ReviewResult;
  cap: number;
  client: GitHubRepositoryClient;
}): Promise<ReviewInlineCommentResult> {
  const listReviewComments = input.client.pulls.listReviewComments;
  const createReview = input.client.pulls.createReview;
  if (!listReviewComments || !createReview) {
    throw new Error(
      "Inline review posting requires GitHub pull request review comment permissions.",
    );
  }
  const existingComments = await listPaginated((page) =>
    listReviewComments({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
      per_page: 100,
      page,
    }),
  );
  const plan = planInlineReviewComments({
    review: input.review,
    existingComments,
    cap: input.cap,
  });
  if (plan.comments.length === 0) {
    return { ...plan, reviewId: null, url: null };
  }
  const response = await createReview({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullNumber,
    event: "COMMENT",
    body: "Open Maintainer inline review comments.",
    comments: plan.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: "RIGHT",
      body: comment.body,
    })),
  });
  return {
    ...plan,
    reviewId: response.data.id,
    url: response.data.html_url ?? null,
  };
}

function inlineCommentFingerprint(input: {
  findingId: string;
  path: string;
  line: number;
}): string {
  return `${input.findingId}:${input.path}:${input.line}`;
}

function extractInlineFingerprint(body: string): string | null {
  return (
    body.match(/open-maintainer-review-inline fingerprint="([^"]+)"/)?.[1] ??
    null
  );
}

function renderInlineCommentBody(input: {
  title: string;
  severity: ReviewSeverity;
  body: string;
  fingerprint: string;
}): string {
  return [
    `${OPEN_MAINTAINER_REVIEW_INLINE_MARKER.replace("-->", ` fingerprint="${input.fingerprint}" -->`)}`,
    `**${formatReviewSeverity(input.severity)}: ${input.title}**`,
    "",
    input.body,
  ].join("\n");
}

function formatReviewSeverity(severity: ReviewSeverity): string {
  return severity
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function reviewSeverityRank(severity: ReviewSeverity): number {
  return {
    blocker: 0,
    major: 1,
    minor: 2,
    note: 3,
  }[severity];
}

export type { WritableContextArtifact };

export type ContextPrWritePolicy = "preserve-maintainer-owned" | "force";

export type OpenContextPrInput = {
  target:
    | { kind: "registered-repo"; repoId: string }
    | {
        kind: "workspace";
        root: string;
        repository: { owner: string; name: string; defaultBranch: string };
      };
  origin:
    | { kind: "dashboard"; runReference?: string }
    | {
        kind: "github-action";
        branchName?: string;
        title?: string;
        summaryMarkdown?: string;
      };
  writePolicy?: ContextPrWritePolicy;
};

export type PreparedContextPrRepo = {
  repoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  profileVersion: number;
  profile?: RepoProfile;
  worktreeRoot: string | null;
  installationId?: string | null;
};

export type ContextPrBodyInput = {
  repo: PreparedContextPrRepo;
  artifacts: GeneratedArtifact[];
  origin: OpenContextPrInput["origin"];
  runReference: string;
  generatedAt: string;
};

export type ContextPrPlan = {
  repo: PreparedContextPrRepo;
  branchName: string;
  title: string;
  body: string;
  writePolicy: ContextPrWritePolicy;
  shouldOverwriteExistingFile(content: string): boolean;
  writableArtifacts: WritableContextArtifact[];
  generatedAt: string;
};

export type ContextPrPublishInput = ContextPrPlan & {
  run: RunRecord | null;
};

export type ContextPrPublisher = {
  publish(input: ContextPrPublishInput): Promise<ContextPr>;
};

export type GitHubCredentialResolver = (
  repo: PreparedContextPrRepo,
) => GitHubAppInstallationAuth | null;

export type ContextPrWorkflowDeps = {
  state: {
    runs: {
      start(input: {
        repo: PreparedContextPrRepo;
        artifacts: GeneratedArtifact[];
        origin: OpenContextPrInput["origin"];
      }): Promise<RunRecord | null> | RunRecord | null;
      succeed(input: {
        run: RunRecord | null;
        contextPr: ContextPr;
      }): Promise<RunRecord | null> | RunRecord | null;
      fail(input: {
        run: RunRecord | null;
        code: OpenContextPrFailure["code"];
        message: string;
      }): Promise<RunRecord | null> | RunRecord | null;
    };
    contextPrs: {
      save(contextPr: ContextPr): Promise<void> | void;
    };
  };
  repositorySources: {
    prepareRegisteredRepo(repoId: string): Promise<PreparedContextPrRepo>;
    prepareWorkspace(input: {
      root: string;
      repository: { owner: string; name: string; defaultBranch: string };
    }): Promise<PreparedContextPrRepo>;
  };
  artifactCatalog: {
    collect(input: PreparedContextPrRepo): Promise<GeneratedArtifact[]>;
  };
  publishers: {
    localGh: ContextPrPublisher;
    githubApp: ContextPrPublisher;
    actionGh: ContextPrPublisher;
  };
  policy?: Partial<ContextPrWorkflowPolicy>;
  platform?: {
    clock?: () => string;
    ids?: { contextPr(): string };
    credentials?: GitHubCredentialResolver;
    logger?: { error(message: string, error: unknown): void };
  };
};

export type ContextPrWorkflowPolicy = {
  selectWritableArtifacts(
    artifacts: GeneratedArtifact[],
  ): WritableContextArtifact[];
  branchName(input: {
    profileVersion: number;
    origin: OpenContextPrInput["origin"];
  }): string;
  title(input: {
    profileVersion: number;
    origin: OpenContextPrInput["origin"];
  }): string;
  renderBody(input: ContextPrBodyInput): string;
  shouldOverwriteExistingFile(input: {
    content: string;
    writePolicy: ContextPrWritePolicy;
  }): boolean;
};

export type OpenContextPrFailure = {
  ok: false;
  statusCode: 404 | 409 | 422 | 502;
  code:
    | "UNKNOWN_REPO"
    | "NO_PROFILE"
    | "NO_WRITABLE_ARTIFACTS"
    | "WORKTREE_UNAVAILABLE"
    | "GITHUB_AUTH_UNAVAILABLE"
    | "PUBLISH_FAILED";
  message: string;
  run: RunRecord | null;
};

export type OpenContextPrResult =
  | {
      ok: true;
      contextPr: ContextPr;
      run: RunRecord | null;
      writtenArtifacts: GeneratedArtifact[];
    }
  | OpenContextPrFailure;

export interface ContextPrWorkflow {
  open(input: OpenContextPrInput): Promise<OpenContextPrResult>;
}

export class ContextPrWorkflowError extends Error {
  statusCode: OpenContextPrFailure["statusCode"];
  code: OpenContextPrFailure["code"];

  constructor(
    statusCode: OpenContextPrFailure["statusCode"],
    code: OpenContextPrFailure["code"],
    message: string,
  ) {
    super(message);
    this.name = "ContextPrWorkflowError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function createContextPrWorkflow(
  deps: ContextPrWorkflowDeps,
): ContextPrWorkflow {
  const policy = createContextPrWorkflowPolicy(deps.policy);
  const clock = deps.platform?.clock ?? nowIso;

  return {
    async open(input) {
      let repo: PreparedContextPrRepo;
      try {
        repo =
          input.target.kind === "registered-repo"
            ? await deps.repositorySources.prepareRegisteredRepo(
                input.target.repoId,
              )
            : await deps.repositorySources.prepareWorkspace(input.target);
      } catch (error) {
        return sourceFailure(error);
      }

      const artifacts = await deps.artifactCatalog.collect(repo);
      const writableArtifacts = policy.selectWritableArtifacts(artifacts);
      let run = await deps.state.runs.start({
        repo,
        artifacts: writableArtifacts.map(({ artifact }) => artifact),
        origin: input.origin,
      });
      if (writableArtifacts.length === 0) {
        return fail({
          deps,
          run,
          statusCode: 409,
          code: "NO_WRITABLE_ARTIFACTS",
          message:
            "Generate writable context artifacts before opening a context PR.",
        });
      }

      const generatedAt = clock();
      const branchName = policy.branchName({
        profileVersion: repo.profileVersion,
        origin: input.origin,
      });
      const plan: ContextPrPlan = {
        repo,
        branchName,
        title: policy.title({
          profileVersion: repo.profileVersion,
          origin: input.origin,
        }),
        body: policy.renderBody({
          repo,
          artifacts: writableArtifacts.map(({ artifact }) => artifact),
          origin: input.origin,
          runReference:
            run?.id ??
            (input.origin.kind === "dashboard"
              ? input.origin.runReference
              : undefined) ??
            "context-pr",
          generatedAt,
        }),
        writePolicy: input.writePolicy ?? "preserve-maintainer-owned",
        shouldOverwriteExistingFile: (content) =>
          policy.shouldOverwriteExistingFile({
            content,
            writePolicy: input.writePolicy ?? "preserve-maintainer-owned",
          }),
        writableArtifacts,
        generatedAt,
      };

      const publisher = selectPublisher(input, repo, deps);
      try {
        const contextPr = await publisher.publish({ ...plan, run });
        await deps.state.contextPrs.save(contextPr);
        run = await deps.state.runs.succeed({ run, contextPr });
        const writtenVersions = new Set(contextPr.artifactVersions);
        return {
          ok: true,
          contextPr,
          run,
          writtenArtifacts: plan.writableArtifacts
            .map(({ artifact }) => artifact)
            .filter((artifact) => writtenVersions.has(artifact.version)),
        };
      } catch (error) {
        deps.platform?.logger?.error("Context PR publication failed.", error);
        if (error instanceof ContextPrWorkflowError) {
          return fail({
            deps,
            run,
            statusCode: error.statusCode,
            code: error.code,
            message: error.message,
          });
        }
        return fail({
          deps,
          run,
          statusCode: 502,
          code: "PUBLISH_FAILED",
          message:
            error instanceof Error
              ? `Context PR publication failed: ${error.message}`
              : "Context PR publication failed.",
        });
      }
    },
  };
}

export function createContextPrWorkflowPolicy(
  overrides: Partial<ContextPrWorkflowPolicy> = {},
): ContextPrWorkflowPolicy {
  return {
    selectWritableArtifacts: defaultSelectWritableArtifacts,
    branchName({ profileVersion, origin }) {
      if (origin.kind === "github-action" && origin.branchName) {
        return origin.branchName;
      }
      return createContextBranchName(profileVersion);
    },
    title({ profileVersion, origin }) {
      if (origin.kind === "github-action" && origin.title) {
        return origin.title;
      }
      return `Update Open Maintainer context v${profileVersion}`;
    },
    renderBody(input) {
      if (input.origin.kind === "github-action") {
        return renderContextRefreshPrBody({
          artifacts: input.artifacts,
          generatedAt: input.generatedAt,
          ...(input.origin.summaryMarkdown
            ? { summaryMarkdown: input.origin.summaryMarkdown }
            : {}),
        });
      }
      return renderContextPrBody({
        repoProfileVersion: input.repo.profileVersion,
        artifacts: input.artifacts,
        modelProvider: input.artifacts[0]?.modelProvider ?? null,
        model: input.artifacts[0]?.model ?? null,
        runReference: input.runReference,
        generatedAt: input.generatedAt,
      });
    },
    shouldOverwriteExistingFile({ content, writePolicy }) {
      return writePolicy === "force" || isOpenMaintainerGeneratedFile(content);
    },
    ...overrides,
  };
}

export function defaultSelectWritableArtifacts(
  artifacts: GeneratedArtifact[],
): WritableContextArtifact[] {
  return selectWritableContextArtifacts(artifacts);
}

export function renderContextRefreshPrBody(input: {
  artifacts: GeneratedArtifact[];
  generatedAt: string;
  summaryMarkdown?: string;
}): string {
  const artifactRows = input.artifacts
    .map((artifact) => `| ${artifact.type} | v${artifact.version} |`)
    .join("\n");
  return [
    "## Open Maintainer Context Refresh",
    "",
    "This pull request refreshes generated Open Maintainer context artifacts.",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "| Artifact | Version |",
    "| --- | --- |",
    artifactRows,
    "",
    "### Audit Summary",
    input.summaryMarkdown?.trim() || "No audit summary was provided.",
  ].join("\n");
}

async function fail(input: {
  deps: ContextPrWorkflowDeps;
  run: RunRecord | null;
  statusCode: OpenContextPrFailure["statusCode"];
  code: OpenContextPrFailure["code"];
  message: string;
}): Promise<OpenContextPrFailure> {
  const run = await input.deps.state.runs.fail({
    run: input.run,
    code: input.code,
    message: input.message,
  });
  return {
    ok: false,
    statusCode: input.statusCode,
    code: input.code,
    message: input.message,
    run,
  };
}

function sourceFailure(error: unknown): OpenContextPrFailure {
  if (isContextPrSourceError(error)) {
    return {
      ok: false,
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      run: error.run ?? null,
    };
  }
  return {
    ok: false,
    statusCode: 422,
    code: "UNKNOWN_REPO",
    message:
      error instanceof Error ? error.message : "Unable to prepare repository.",
    run: null,
  };
}

function isContextPrSourceError(error: unknown): error is OpenContextPrFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    "code" in error &&
    "message" in error
  );
}

function selectPublisher(
  input: OpenContextPrInput,
  repo: PreparedContextPrRepo,
  deps: ContextPrWorkflowDeps,
): ContextPrPublisher {
  if (input.target.kind === "workspace") {
    return deps.publishers.actionGh;
  }
  if (repo.worktreeRoot) {
    return deps.publishers.localGh;
  }
  return deps.publishers.githubApp;
}

async function getExistingFileSha(input: {
  client: GitHubRepositoryClient;
  owner: string;
  repo: string;
  branchName: string;
  path: string;
}): Promise<{ sha: string; content: string } | undefined> {
  try {
    const response = await input.client.repos.getContent({
      owner: input.owner,
      repo: input.repo,
      path: input.path,
      ref: input.branchName,
    });
    const file = getContentFile(response.data);
    if (!file?.sha) {
      return undefined;
    }
    return {
      sha: file.sha,
      content: decodeGitHubContent(file) ?? file.content ?? "",
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function createContextPr(input: {
  repoId: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  profileVersion: number;
  artifacts: GeneratedArtifact[];
  writableArtifacts?: WritableContextArtifact[];
  branchName?: string;
  title?: string;
  body?: string;
  writePolicy?: ContextPrWritePolicy;
  shouldOverwriteExistingFile?: (content: string) => boolean;
  repoProfileVersion?: number;
  modelProvider?: string | null;
  model?: string | null;
  runReference?: string;
  generatedAt?: string;
  mock?: boolean;
  client?: GitHubRepositoryClient;
  auth?: GitHubAppInstallationAuth;
}): Promise<ContextPr> {
  if (input.mock) {
    return createMockContextPr({
      repoId: input.repoId,
      profileVersion: input.profileVersion,
      artifacts: input.artifacts,
    });
  }

  const client = resolveGitHubClient(input);
  const branchName =
    input.branchName ?? createContextBranchName(input.profileVersion);
  const writableArtifacts =
    input.writableArtifacts ?? defaultSelectWritableArtifacts(input.artifacts);

  if (writableArtifacts.length === 0) {
    throw new Error("No context artifact files were provided.");
  }

  const baseRef = await client.git.getRef({
    owner: input.owner,
    repo: input.repo,
    ref: `heads/${input.defaultBranch}`,
  });
  const baseSha = baseRef.data.object.sha;

  try {
    await client.git.getRef({
      owner: input.owner,
      repo: input.repo,
      ref: `heads/${branchName}`,
    });
    await client.git.updateRef({
      owner: input.owner,
      repo: input.repo,
      ref: `heads/${branchName}`,
      sha: baseSha,
      force: true,
    });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    await client.git.createRef({
      owner: input.owner,
      repo: input.repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });
  }

  let commitSha: string | null = null;
  const writtenArtifacts: typeof writableArtifacts = [];
  for (const { artifact, path } of writableArtifacts) {
    const existingFile = await getExistingFileSha({
      client,
      owner: input.owner,
      repo: input.repo,
      branchName,
      path,
    });
    if (
      existingFile &&
      !(input.shouldOverwriteExistingFile ?? isOpenMaintainerGeneratedFile)(
        existingFile.content,
      )
    ) {
      continue;
    }
    const writeInput = {
      owner: input.owner,
      repo: input.repo,
      path,
      message: `Update Open Maintainer context ${path}`,
      content: Buffer.from(artifact.content, "utf8").toString("base64"),
      branch: branchName,
      ...(existingFile ? { sha: existingFile.sha } : {}),
    };
    const writeResponse =
      await client.repos.createOrUpdateFileContents(writeInput);
    commitSha = writeResponse.data.commit?.sha ?? commitSha;
    writtenArtifacts.push({ artifact, path });
  }
  if (writtenArtifacts.length === 0) {
    throw new Error(
      "No context artifact files were written because existing files are preserved by default.",
    );
  }

  const modelProvider =
    input.modelProvider ?? writtenArtifacts[0]?.artifact.modelProvider ?? null;
  const model = input.model ?? writtenArtifacts[0]?.artifact.model ?? null;
  const body =
    input.body ??
    renderContextPrBody({
      repoProfileVersion: input.repoProfileVersion ?? input.profileVersion,
      artifacts: writtenArtifacts.map(({ artifact }) => artifact),
      modelProvider,
      model,
      runReference: input.runReference ?? `context-pr:${input.repoId}`,
      generatedAt: input.generatedAt ?? nowIso(),
    });
  const title =
    input.title ?? `Update Open Maintainer context v${input.profileVersion}`;
  const existingPulls = await client.pulls.list({
    owner: input.owner,
    repo: input.repo,
    state: "open",
    head: `${input.owner}:${branchName}`,
    base: input.defaultBranch,
  });
  const existingPull = existingPulls.data[0];
  const pull = existingPull
    ? await client.pulls.update({
        owner: input.owner,
        repo: input.repo,
        pull_number: existingPull.number,
        title,
        body,
      })
    : await client.pulls.create({
        owner: input.owner,
        repo: input.repo,
        title,
        head: branchName,
        base: input.defaultBranch,
        body,
      });

  return {
    id: newId("context_pr"),
    repoId: input.repoId,
    branchName,
    commitSha,
    prNumber: pull.data.number,
    prUrl: pull.data.html_url,
    artifactVersions: writtenArtifacts.map(({ artifact }) => artifact.version),
    status: "succeeded",
    createdAt: nowIso(),
  };
}

export function createGitHubAppContextPrPublisher(input: {
  credentials: GitHubCredentialResolver;
  client?: GitHubRepositoryClient;
}): ContextPrPublisher {
  return {
    async publish(plan) {
      const auth = input.credentials(plan.repo);
      if (!auth && !input.client) {
        throw new ContextPrWorkflowError(
          422,
          "GITHUB_AUTH_UNAVAILABLE",
          "GitHub App credentials are required to open a real context PR for this repository.",
        );
      }
      return createContextPr({
        repoId: plan.repo.repoId,
        owner: plan.repo.owner,
        repo: plan.repo.name,
        defaultBranch: plan.repo.defaultBranch,
        profileVersion: plan.repo.profileVersion,
        artifacts: plan.writableArtifacts.map(({ artifact }) => artifact),
        writableArtifacts: plan.writableArtifacts,
        branchName: plan.branchName,
        title: plan.title,
        body: plan.body,
        writePolicy: plan.writePolicy,
        shouldOverwriteExistingFile: plan.shouldOverwriteExistingFile,
        generatedAt: plan.generatedAt,
        mock: false,
        ...(input.client ? { client: input.client } : {}),
        ...(auth ? { auth } : {}),
      });
    },
  };
}

export function isOpenMaintainerGeneratedFile(content: string): boolean {
  return isOpenMaintainerGeneratedContent(content);
}
