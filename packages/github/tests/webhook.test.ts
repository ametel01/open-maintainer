import { createHmac } from "node:crypto";
import type { GeneratedArtifact, ReviewResult } from "@open-maintainer/shared";
import { describe, expect, it } from "vitest";
import {
  type GitHubRepositoryClient,
  applyPullRequestLabelsForDashboard,
  createContextBranchName,
  createContextPr,
  createContextPrWorkflow,
  extractAcceptanceCriteria,
  extractLinkedIssueNumbers,
  fetchIssueTriageEvidence,
  fetchPullRequestDetailForDashboard,
  fetchPullRequestReviewContext,
  fetchRepositoryContents,
  isOpenMaintainerReviewComment,
  listPullRequestsForDashboard,
  mapInstallationEvent,
  planInlineReviewComments,
  planReviewSummaryComment,
  publishInlineReviewComments,
  renderContextPrBody,
  renderContextRefreshPrBody,
  renderMarkedReviewSummaryComment,
  shouldSkipRepositoryPath,
  upsertReviewSummaryComment,
  verifyWebhookSignature,
} from "../src";

function notFound(): Error & { status: number } {
  return Object.assign(new Error("not found"), { status: 404 });
}

function artifact(
  type: GeneratedArtifact["type"],
  version: number,
  content: string,
): GeneratedArtifact {
  return {
    id: `artifact_${version}`,
    repoId: "repo_1",
    type,
    version,
    content,
    sourceProfileVersion: 7,
    modelProvider: "local",
    model: "llama",
    createdAt: "2026-04-30T00:00:00.000Z",
  };
}

function reviewResult(): ReviewResult {
  return {
    id: "review_1",
    repoId: "repo_1",
    prNumber: 7,
    baseRef: "main",
    headRef: "feature",
    baseSha: "base-sha",
    headSha: "head-sha",
    summary: "Review summary.",
    walkthrough: ["modified src/a.ts (+2/-1)"],
    changedSurface: ["package:review"],
    riskAnalysis: ["No risk path was detected."],
    expectedValidation: [],
    validationEvidence: [],
    docsImpact: [],
    findings: [
      {
        id: "minor-finding",
        title: "Minor issue",
        severity: "minor",
        body: "Minor body.",
        path: "src/a.ts",
        line: 12,
        citations: [
          {
            source: "changed_file",
            path: "src/a.ts",
            excerpt: "@@",
            reason: "Changed file.",
          },
        ],
      },
      {
        id: "blocker-finding",
        title: "Blocker issue",
        severity: "blocker",
        body: "Blocker body.",
        path: "src/a.ts",
        line: 10,
        citations: [
          {
            source: "changed_file",
            path: "src/a.ts",
            excerpt: "@@",
            reason: "Changed file.",
          },
        ],
      },
      {
        id: "missing-line",
        title: "Missing line",
        severity: "major",
        body: "No line.",
        path: "src/a.ts",
        line: null,
        citations: [
          {
            source: "changed_file",
            path: "src/a.ts",
            excerpt: "@@",
            reason: "Changed file.",
          },
        ],
      },
    ],
    mergeReadiness: {
      status: "needs_attention",
      reason: "Findings need attention.",
      evidence: [],
    },
    residualRisk: [],
    changedFiles: [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1",
        previousPath: null,
      },
    ],
    feedback: [],
    modelProvider: null,
    model: null,
    createdAt: "2026-05-02T00:00:00.000Z",
  };
}

describe("github helpers", () => {
  it("verifies GitHub webhook signatures", () => {
    const payload = JSON.stringify({ action: "created" });
    const secret = "webhook-secret";
    const signature256 = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

    expect(verifyWebhookSignature({ secret, payload, signature256 })).toBe(
      true,
    );
    expect(
      verifyWebhookSignature({
        secret,
        payload,
        signature256: signature256.replace(/.$/, "0"),
      }),
    ).toBe(false);
  });

  it("maps installation events to persisted records", () => {
    const mapped = mapInstallationEvent({
      installation: {
        id: 42,
        account: { login: "acme", type: "Organization" },
        repository_selection: "selected",
        permissions: { contents: "write" },
      },
      repositories: [
        {
          id: 10,
          name: "tool",
          full_name: "acme/tool",
          private: false,
          default_branch: "trunk",
        },
      ],
    });

    expect(mapped.installation.accountLogin).toBe("acme");
    expect(mapped.repos[0]?.defaultBranch).toBe("trunk");
  });

  it("renders predictable branch names and PR body metadata", () => {
    expect(createContextBranchName(3, 1)).toBe("open-maintainer/context-3-2");
    const body = renderContextPrBody({
      repoProfileVersion: 3,
      artifacts: [
        {
          id: "artifact_1",
          repoId: "repo_1",
          type: "AGENTS.md",
          version: 4,
          content: "test",
          sourceProfileVersion: 3,
          modelProvider: "local",
          model: "llama",
          createdAt: "2026-04-30T00:00:00.000Z",
        },
      ],
      modelProvider: "local",
      model: "llama",
      runReference: "run_1",
      generatedAt: "2026-04-30T00:00:00.000Z",
    });

    expect(body).toContain("Repo profile version: v3");
    expect(body).toContain("AGENTS.md");
    expect(body).toContain("| Artifact | Source |");
    expect(body).not.toContain("| Artifact | Version | Source |");
    expect(body).not.toContain("| AGENTS.md | v4 |");
  });

  it("opens registered repo context PRs through the workflow boundary", async () => {
    const saved: Array<{ prUrl: string | null }> = [];
    const runs: Array<{ status: string; message: string | null }> = [];
    const workflow = createContextPrWorkflow({
      state: {
        runs: {
          start({ artifacts }) {
            runs.push({ status: "running", message: null });
            return {
              id: "run_1",
              repoId: "repo_1",
              type: "context_pr",
              status: "running",
              inputSummary: "test",
              safeMessage: null,
              artifactVersions: artifacts.map((item) => item.version),
              repoProfileVersion: 7,
              provider: null,
              model: null,
              externalId: null,
              createdAt: "2026-04-30T00:00:00.000Z",
              updatedAt: "2026-04-30T00:00:00.000Z",
            };
          },
          succeed({ run, contextPr }) {
            runs.push({ status: "succeeded", message: contextPr.prUrl });
            return run ? { ...run, status: "succeeded" } : null;
          },
          fail({ run, message }) {
            runs.push({ status: "failed", message });
            return run
              ? { ...run, status: "failed", safeMessage: message }
              : null;
          },
        },
        contextPrs: {
          save(contextPr) {
            saved.push({ prUrl: contextPr.prUrl });
          },
        },
      },
      repositorySources: {
        async prepareRegisteredRepo() {
          return {
            repoId: "repo_1",
            owner: "acme",
            name: "tool",
            defaultBranch: "main",
            profileVersion: 7,
            worktreeRoot: "/repo",
          };
        },
        async prepareWorkspace() {
          throw new Error("unexpected workspace");
        },
      },
      artifactCatalog: {
        async collect() {
          return [
            artifact("repo_profile", 1, "{}"),
            artifact("AGENTS.md", 2, "# generated by open-maintainer\n"),
            artifact("CLAUDE.md", 3, "# generated by open-maintainer\n"),
          ];
        },
      },
      publishers: {
        localGh: {
          async publish(input) {
            expect(input.branchName).toBe("open-maintainer/context-7");
            expect(input.writableArtifacts.map((item) => item.path)).toEqual([
              "AGENTS.md",
              "CLAUDE.md",
            ]);
            expect(input.body).toContain("Dashboard run: run_1");
            return {
              id: "context_pr_1",
              repoId: input.repo.repoId,
              branchName: input.branchName,
              commitSha: "commit-sha",
              prNumber: 12,
              prUrl: "https://github.com/acme/tool/pull/12",
              artifactVersions: input.writableArtifacts.map(
                ({ artifact }) => artifact.version,
              ),
              status: "succeeded",
              createdAt: "2026-04-30T00:00:00.000Z",
            };
          },
        },
        githubApp: {
          async publish() {
            throw new Error("unexpected github app publisher");
          },
        },
        actionGh: {
          async publish() {
            throw new Error("unexpected action publisher");
          },
        },
      },
      platform: { clock: () => "2026-04-30T00:00:00.000Z" },
    });

    const result = await workflow.open({
      target: { kind: "registered-repo", repoId: "repo_1" },
      origin: { kind: "dashboard" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(saved).toEqual([{ prUrl: "https://github.com/acme/tool/pull/12" }]);
    expect(runs.map((run) => run.status)).toEqual(["running", "succeeded"]);
    expect(result.writtenArtifacts.map((item) => item.type)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
    ]);
  });

  it("returns a durable workflow failure before publishing when no artifacts are writable", async () => {
    let publishCalled = false;
    const workflow = createContextPrWorkflow({
      state: {
        runs: {
          start: () => null,
          succeed: () => null,
          fail: () => null,
        },
        contextPrs: { save: () => undefined },
      },
      repositorySources: {
        async prepareRegisteredRepo() {
          return {
            repoId: "repo_1",
            owner: "acme",
            name: "tool",
            defaultBranch: "main",
            profileVersion: 7,
            worktreeRoot: null,
          };
        },
        async prepareWorkspace() {
          throw new Error("unexpected workspace");
        },
      },
      artifactCatalog: {
        async collect() {
          return [artifact("repo_profile", 1, "{}")];
        },
      },
      publishers: {
        localGh: {
          async publish() {
            publishCalled = true;
            throw new Error("unexpected");
          },
        },
        githubApp: {
          async publish() {
            publishCalled = true;
            throw new Error("unexpected");
          },
        },
        actionGh: {
          async publish() {
            publishCalled = true;
            throw new Error("unexpected");
          },
        },
      },
    });

    const result = await workflow.open({
      target: { kind: "registered-repo", repoId: "repo_1" },
      origin: { kind: "dashboard" },
    });

    expect(result).toMatchObject({
      ok: false,
      statusCode: 409,
      code: "NO_WRITABLE_ARTIFACTS",
    });
    expect(publishCalled).toBe(false);
  });

  it("uses the GitHub App publisher for registered repos without a writable worktree", async () => {
    const publisherCalls: string[] = [];
    const workflow = createContextPrWorkflow({
      state: {
        runs: {
          start: () => null,
          succeed: () => null,
          fail: () => null,
        },
        contextPrs: { save: () => undefined },
      },
      repositorySources: {
        async prepareRegisteredRepo() {
          return {
            repoId: "repo_1",
            owner: "acme",
            name: "tool",
            defaultBranch: "main",
            profileVersion: 7,
            worktreeRoot: null,
            installationId: "installation_1",
          };
        },
        async prepareWorkspace() {
          throw new Error("unexpected workspace");
        },
      },
      artifactCatalog: {
        async collect() {
          return [artifact("AGENTS.md", 2, "# generated by open-maintainer\n")];
        },
      },
      publishers: {
        localGh: {
          async publish() {
            throw new Error("unexpected local publisher");
          },
        },
        githubApp: {
          async publish(input) {
            publisherCalls.push("githubApp");
            return {
              id: "context_pr_1",
              repoId: input.repo.repoId,
              branchName: input.branchName,
              commitSha: "commit-sha",
              prNumber: 12,
              prUrl: "https://github.com/acme/tool/pull/12",
              artifactVersions: input.writableArtifacts.map(
                ({ artifact }) => artifact.version,
              ),
              status: "succeeded",
              createdAt: "2026-04-30T00:00:00.000Z",
            };
          },
        },
        actionGh: {
          async publish() {
            throw new Error("unexpected action publisher");
          },
        },
      },
    });

    const result = await workflow.open({
      target: { kind: "registered-repo", repoId: "repo_1" },
      origin: { kind: "dashboard" },
    });

    expect(result.ok).toBe(true);
    expect(publisherCalls).toEqual(["githubApp"]);
  });

  it("plans workspace refresh PRs with action metadata and shared writable artifacts", async () => {
    const published: Array<{
      branchName: string;
      title: string;
      body: string;
      paths: string[];
    }> = [];
    const workflow = createContextPrWorkflow({
      state: {
        runs: {
          start: () => null,
          succeed: () => null,
          fail: () => null,
        },
        contextPrs: { save: () => undefined },
      },
      repositorySources: {
        async prepareRegisteredRepo() {
          throw new Error("unexpected registered repo");
        },
        async prepareWorkspace(input) {
          return {
            repoId: "local",
            owner: input.repository.owner,
            name: input.repository.name,
            defaultBranch: input.repository.defaultBranch,
            profileVersion: 9,
            worktreeRoot: input.root,
          };
        },
      },
      artifactCatalog: {
        async collect() {
          return [
            artifact("repo_profile", 1, "{}"),
            artifact("AGENTS.md", 2, "# generated by open-maintainer\n"),
            artifact(
              ".agents/skills/tool-start-task/SKILL.md",
              3,
              "# generated by open-maintainer\n",
            ),
          ];
        },
      },
      publishers: {
        localGh: {
          async publish() {
            throw new Error("unexpected local publisher");
          },
        },
        githubApp: {
          async publish() {
            throw new Error("unexpected github app publisher");
          },
        },
        actionGh: {
          async publish(input) {
            published.push({
              branchName: input.branchName,
              title: input.title,
              body: input.body,
              paths: input.writableArtifacts.map((item) => item.path),
            });
            return {
              id: "context_pr_1",
              repoId: input.repo.repoId,
              branchName: input.branchName,
              commitSha: "commit-sha",
              prNumber: 12,
              prUrl: "https://github.com/acme/tool/pull/12",
              artifactVersions: input.writableArtifacts.map(
                ({ artifact }) => artifact.version,
              ),
              status: "succeeded",
              createdAt: "2026-04-30T00:00:00.000Z",
            };
          },
        },
      },
      platform: { clock: () => "2026-04-30T00:00:00.000Z" },
    });

    const result = await workflow.open({
      target: {
        kind: "workspace",
        root: "/repo",
        repository: { owner: "acme", name: "tool", defaultBranch: "main" },
      },
      origin: {
        kind: "github-action",
        branchName: "open-maintainer/context-refresh",
        title: "Refresh generated context",
        summaryMarkdown: "Audit score: 82",
      },
    });

    expect(result.ok).toBe(true);
    expect(published).toEqual([
      {
        branchName: "open-maintainer/context-refresh",
        title: "Refresh generated context",
        body: expect.stringContaining("Audit score: 82"),
        paths: ["AGENTS.md", ".agents/skills/tool-start-task/SKILL.md"],
      },
    ]);
  });

  it("passes preserve and force overwrite policy decisions to publishers", async () => {
    const decisions: boolean[] = [];
    const workflow = createContextPrWorkflow({
      state: {
        runs: {
          start: () => null,
          succeed: () => null,
          fail: () => null,
        },
        contextPrs: { save: () => undefined },
      },
      repositorySources: {
        async prepareRegisteredRepo() {
          return {
            repoId: "repo_1",
            owner: "acme",
            name: "tool",
            defaultBranch: "main",
            profileVersion: 7,
            worktreeRoot: "/repo",
          };
        },
        async prepareWorkspace() {
          throw new Error("unexpected workspace");
        },
      },
      artifactCatalog: {
        async collect() {
          return [artifact("AGENTS.md", 2, "# generated by open-maintainer\n")];
        },
      },
      publishers: {
        localGh: {
          async publish(input) {
            decisions.push(input.shouldOverwriteExistingFile("# manual\n"));
            return {
              id: "context_pr_1",
              repoId: input.repo.repoId,
              branchName: input.branchName,
              commitSha: "commit-sha",
              prNumber: 12,
              prUrl: "https://github.com/acme/tool/pull/12",
              artifactVersions: input.writableArtifacts.map(
                ({ artifact }) => artifact.version,
              ),
              status: "succeeded",
              createdAt: "2026-04-30T00:00:00.000Z",
            };
          },
        },
        githubApp: {
          async publish() {
            throw new Error("unexpected github app publisher");
          },
        },
        actionGh: {
          async publish() {
            throw new Error("unexpected action publisher");
          },
        },
      },
    });

    await workflow.open({
      target: { kind: "registered-repo", repoId: "repo_1" },
      origin: { kind: "dashboard" },
      writePolicy: "preserve-maintainer-owned",
    });
    await workflow.open({
      target: { kind: "registered-repo", repoId: "repo_1" },
      origin: { kind: "dashboard" },
      writePolicy: "force",
    });

    expect(decisions).toEqual([false, true]);
  });

  it("updates run state and returns a stable error when publishing fails", async () => {
    const runs: Array<{ status: string; message: string | null }> = [];
    const workflow = createContextPrWorkflow({
      state: {
        runs: {
          start() {
            runs.push({ status: "running", message: null });
            return {
              id: "run_1",
              repoId: "repo_1",
              type: "context_pr",
              status: "running",
              inputSummary: "test",
              safeMessage: null,
              artifactVersions: [2],
              repoProfileVersion: 7,
              provider: null,
              model: null,
              externalId: null,
              createdAt: "2026-04-30T00:00:00.000Z",
              updatedAt: "2026-04-30T00:00:00.000Z",
            };
          },
          succeed: () => null,
          fail({ run, message }) {
            runs.push({ status: "failed", message });
            return run
              ? { ...run, status: "failed", safeMessage: message }
              : null;
          },
        },
        contextPrs: { save: () => undefined },
      },
      repositorySources: {
        async prepareRegisteredRepo() {
          return {
            repoId: "repo_1",
            owner: "acme",
            name: "tool",
            defaultBranch: "main",
            profileVersion: 7,
            worktreeRoot: "/repo",
          };
        },
        async prepareWorkspace() {
          throw new Error("unexpected workspace");
        },
      },
      artifactCatalog: {
        async collect() {
          return [artifact("AGENTS.md", 2, "# generated by open-maintainer\n")];
        },
      },
      publishers: {
        localGh: {
          async publish() {
            throw new Error("gh failed");
          },
        },
        githubApp: {
          async publish() {
            throw new Error("unexpected github app publisher");
          },
        },
        actionGh: {
          async publish() {
            throw new Error("unexpected action publisher");
          },
        },
      },
    });

    const result = await workflow.open({
      target: { kind: "registered-repo", repoId: "repo_1" },
      origin: { kind: "dashboard" },
    });

    expect(result).toMatchObject({
      ok: false,
      statusCode: 502,
      code: "PUBLISH_FAILED",
      message: "Context PR publication failed: gh failed",
    });
    expect(runs).toEqual([
      { status: "running", message: null },
      { status: "failed", message: "Context PR publication failed: gh failed" },
    ]);
  });

  it("renders action refresh PR bodies with audit summary content", () => {
    const body = renderContextRefreshPrBody({
      artifacts: [artifact("AGENTS.md", 2, "# generated")],
      generatedAt: "2026-04-30T00:00:00.000Z",
      summaryMarkdown: "Audit score: 82",
    });

    expect(body).toContain("## Open Maintainer Context Refresh");
    expect(body).toContain("| AGENTS.md | v2 |");
    expect(body).toContain("Audit score: 82");
  });

  it("filters generated and heavy paths before bounded content fetches", async () => {
    const requestedPaths: string[] = [];
    const contents = new Map([
      [
        "README.md",
        {
          type: "file",
          encoding: "base64",
          content: Buffer.from("hello").toString("base64"),
          size: 5,
          sha: "readme-sha",
        },
      ],
      [
        "src/big.ts",
        {
          type: "file",
          encoding: "base64",
          content: Buffer.from("01234567890123456789").toString("base64"),
          size: 20,
          sha: "big-sha",
        },
      ],
      [
        "src/second.ts",
        {
          type: "file",
          encoding: "base64",
          content: Buffer.from("second!").toString("base64"),
          size: 7,
          sha: "second-sha",
        },
      ],
    ]);
    const client: GitHubRepositoryClient = {
      repos: {
        async getContent(input) {
          requestedPaths.push(input.path);
          const content = contents.get(input.path);
          if (!content) {
            throw notFound();
          }
          return { data: content };
        },
        async createOrUpdateFileContents() {
          return { data: { commit: { sha: "unused" } } };
        },
      },
      git: {
        async getRef() {
          return { data: { object: { sha: "unused" } } };
        },
        async createRef() {
          return {};
        },
        async updateRef() {
          return {};
        },
      },
      pulls: {
        async list() {
          return { data: [] };
        },
        async create() {
          return {
            data: {
              number: 1,
              html_url: "https://github.com/acme/tool/pull/1",
            },
          };
        },
        async update() {
          return {
            data: {
              number: 1,
              html_url: "https://github.com/acme/tool/pull/1",
            },
          };
        },
      },
    };

    const fetched = await fetchRepositoryContents({
      owner: "acme",
      repo: "tool",
      ref: "main",
      paths: [
        "/README.md",
        "dist/app.js",
        "src/big.ts",
        "missing.md",
        "src/second.ts",
        "src/third.ts",
      ],
      limits: { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 12 },
      client,
    });

    expect(shouldSkipRepositoryPath("node_modules/pkg/index.js")).toBe(true);
    expect(shouldSkipRepositoryPath("bun.lock")).toBe(false);
    expect(shouldSkipRepositoryPath("Cargo.lock")).toBe(false);
    expect(fetched.files.map((file) => file.path)).toEqual([
      "README.md",
      "src/second.ts",
    ]);
    expect(fetched.skipped).toEqual([
      { path: "dist/app.js", reason: "filtered" },
      { path: "src/big.ts", reason: "max_file_bytes" },
      { path: "missing.md", reason: "not_found" },
      { path: "src/third.ts", reason: "max_files" },
    ]);
    expect(requestedPaths).toEqual([
      "README.md",
      "src/big.ts",
      "missing.md",
      "src/second.ts",
    ]);
  });

  it("fetches issue triage evidence with comments and related candidates", async () => {
    const fetchedIssues: number[] = [];
    const searchQueries: string[] = [];
    const client: GitHubRepositoryClient = {
      repos: {
        async getContent() {
          throw notFound();
        },
        async createOrUpdateFileContents() {
          return { data: { commit: { sha: "unused" } } };
        },
      },
      git: {
        async getRef() {
          return { data: { object: { sha: "unused" } } };
        },
        async createRef() {
          return {};
        },
        async updateRef() {
          return {};
        },
      },
      pulls: {
        async list() {
          return { data: [] };
        },
        async create() {
          return {
            data: {
              number: 1,
              html_url: "https://github.com/acme/tool/pull/1",
            },
          };
        },
        async update() {
          return {
            data: {
              number: 1,
              html_url: "https://github.com/acme/tool/pull/1",
            },
          };
        },
      },
      issues: {
        async get(input) {
          fetchedIssues.push(input.issue_number);
          if (input.issue_number === 42) {
            return {
              data: {
                number: 42,
                title: "Add issue triage evidence",
                body: [
                  "## Feature request",
                  "Inspect `packages/triage/src/index.ts` and related #7.",
                  "",
                  "## Acceptance criteria",
                  "- Evidence includes comments",
                ].join("\n"),
                html_url: "https://github.com/acme/tool/issues/42",
                user: { login: "author" },
                labels: [{ name: "enhancement" }],
                state: "open",
                created_at: "2026-05-03T00:00:00.000Z",
                updated_at: "2026-05-03T00:01:00.000Z",
              },
            };
          }
          if (input.issue_number === 7) {
            return {
              data: {
                number: 7,
                title: "Define triage contract",
                body: "Contract issue.",
                html_url: "https://github.com/acme/tool/issues/7",
                state: "closed",
                created_at: "2026-05-02T00:00:00.000Z",
                updated_at: "2026-05-02T00:01:00.000Z",
              },
            };
          }
          throw notFound();
        },
        async listComments() {
          return {
            data: [
              {
                id: 100,
                body: "The implementation should also read docs/DEMO_RUNBOOK.md.",
                html_url:
                  "https://github.com/acme/tool/issues/42#issuecomment-100",
                user: { login: "maintainer" },
                created_at: "2026-05-03T00:02:00.000Z",
                updated_at: "2026-05-03T00:02:00.000Z",
              },
            ],
          };
        },
      },
      search: {
        async issuesAndPullRequests(input) {
          searchQueries.push(input.q);
          return {
            data: {
              items: [
                {
                  number: 9,
                  title: "Improve issue evidence fixtures",
                  html_url: "https://github.com/acme/tool/issues/9",
                },
              ],
            },
          };
        },
      },
    };

    const evidence = await fetchIssueTriageEvidence({
      repoId: "repo_1",
      owner: "acme",
      repo: "tool",
      issueNumber: 42,
      sourceProfileVersion: 3,
      contextArtifactVersion: 4,
      client,
    });

    expect(evidence.issue.author).toBe("author");
    expect(evidence.issue.labels).toEqual(["enhancement"]);
    expect(evidence.acceptanceCriteriaCandidates).toEqual([
      "Evidence includes comments",
    ]);
    expect(evidence.referencedSurfaces).toEqual([
      "packages/triage/src/index.ts",
      "docs/DEMO_RUNBOOK.md",
    ]);
    expect(evidence.relatedIssues.map((issue) => issue.number)).toEqual([7, 9]);
    expect(evidence.citations.map((citation) => citation.source)).toContain(
      "github_comment",
    );
    expect(fetchedIssues).toEqual([42, 7]);
    expect(searchQueries[0]).toContain("repo:acme/tool is:issue");
  });

  it("updates a context branch, preserves existing context files, and updates an existing PR", async () => {
    const updatedRefs: Array<{ ref: string; sha: string; force: boolean }> = [];
    const writes: Array<{
      path: string;
      branch: string;
      sha?: string;
      content: string;
    }> = [];
    const updatedPulls: Array<{
      pull_number: number;
      title: string;
      body: string;
    }> = [];
    const branchName = createContextBranchName(7);
    const client: GitHubRepositoryClient = {
      repos: {
        async getContent(input) {
          if (input.path === "AGENTS.md" && input.ref === branchName) {
            return {
              data: {
                type: "file",
                encoding: "base64",
                content: Buffer.from("old").toString("base64"),
                size: 3,
                sha: "agents-existing-sha",
              },
            };
          }
          if (
            input.path === ".open-maintainer.yml" &&
            input.ref === branchName
          ) {
            return {
              data: {
                type: "file",
                encoding: "base64",
                content: Buffer.from(
                  "generated:\n  by: open-maintainer\n  artifactVersion: 1\n",
                ).toString("base64"),
                size: 50,
                sha: "config-existing-sha",
              },
            };
          }
          throw notFound();
        },
        async createOrUpdateFileContents(input) {
          writes.push({
            path: input.path,
            branch: input.branch,
            content: input.content,
            ...(input.sha ? { sha: input.sha } : {}),
          });
          return { data: { commit: { sha: `commit-${writes.length}` } } };
        },
      },
      git: {
        async getRef(input) {
          if (input.ref === "heads/main") {
            return { data: { object: { sha: "base-sha" } } };
          }
          if (input.ref === `heads/${branchName}`) {
            return { data: { object: { sha: "old-branch-sha" } } };
          }
          throw notFound();
        },
        async createRef() {
          throw new Error("branch should already exist");
        },
        async updateRef(input) {
          updatedRefs.push({
            ref: input.ref,
            sha: input.sha,
            force: input.force,
          });
          return {};
        },
      },
      pulls: {
        async list() {
          return {
            data: [
              {
                number: 12,
                html_url: "https://github.com/acme/tool/pull/12",
              },
            ],
          };
        },
        async create() {
          throw new Error("existing PR should be updated");
        },
        async update(input) {
          updatedPulls.push({
            pull_number: input.pull_number,
            title: input.title,
            body: input.body,
          });
          return {
            data: {
              number: input.pull_number,
              html_url: "https://github.com/acme/tool/pull/12",
            },
          };
        },
      },
    };

    const contextPr = await createContextPr({
      repoId: "repo_1",
      owner: "acme",
      repo: "tool",
      defaultBranch: "main",
      profileVersion: 7,
      artifacts: [
        artifact("repo_profile", 1, "{}"),
        artifact("AGENTS.md", 2, "# Agent instructions"),
        artifact(
          ".open-maintainer.yml",
          3,
          "generated:\n  artifactVersion: 3\n",
        ),
      ],
      runReference: "run_1",
      generatedAt: "2026-04-30T00:00:00.000Z",
      client,
    });

    expect(updatedRefs).toEqual([
      { ref: `heads/${branchName}`, sha: "base-sha", force: true },
    ]);
    expect(writes).toEqual([
      {
        path: ".open-maintainer.yml",
        branch: branchName,
        sha: "config-existing-sha",
        content: Buffer.from("generated:\n  artifactVersion: 3\n").toString(
          "base64",
        ),
      },
    ]);
    expect(updatedPulls[0]?.pull_number).toBe(12);
    expect(updatedPulls[0]?.body).toContain("Dashboard run: run_1");
    expect(updatedPulls[0]?.body).not.toContain("AGENTS.md");
    expect(contextPr.branchName).toBe(branchName);
    expect(contextPr.commitSha).toBe("commit-1");
    expect(contextPr.prNumber).toBe(12);
    expect(contextPr.artifactVersions).toEqual([3]);
  });

  it("assembles bounded pull request review context", async () => {
    const filePages = [
      Array.from({ length: 100 }, (_, index) => ({
        filename: `src/file-${index}.ts`,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: `@@ -1 +1 @@\n-export const value = ${index};\n+export const value = ${index + 1};`,
      })),
      [
        {
          filename: "dist/generated.js",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ generated",
        },
        {
          filename: "src/too-big.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "x".repeat(500),
        },
      ],
    ];
    const client: GitHubRepositoryClient = {
      repos: {
        async getContent() {
          throw notFound();
        },
        async createOrUpdateFileContents() {
          return { data: { commit: { sha: "unused" } } };
        },
        async getCombinedStatusForRef() {
          return {
            data: {
              statuses: [
                {
                  context: "ci/test",
                  state: "success",
                  target_url: "https://github.com/acme/tool/actions/runs/1",
                },
              ],
            },
          };
        },
      },
      git: {
        async getRef() {
          return { data: { object: { sha: "unused" } } };
        },
        async createRef() {
          return {};
        },
        async updateRef() {
          return {};
        },
      },
      pulls: {
        async get() {
          return {
            data: {
              number: 7,
              title: "Add review context",
              body: "Fixes #12",
              html_url: "https://github.com/acme/tool/pull/7",
              user: { login: "maintainer" },
              base: { ref: "main", sha: "base-sha" },
              head: { ref: "feature", sha: "head-sha" },
            },
          };
        },
        async list() {
          return { data: [] };
        },
        async listFiles(input) {
          return { data: filePages[(input.page ?? 1) - 1] ?? [] };
        },
        async listCommits() {
          return { data: [{ sha: "commit-1" }] };
        },
        async listReviewComments() {
          return {
            data: [
              {
                id: 33,
                body: "<!-- open-maintainer-review-inline -->\ninline",
                path: "src/file-1.ts",
                line: 4,
              },
            ],
          };
        },
        async create() {
          throw new Error("unused");
        },
        async update() {
          throw new Error("unused");
        },
      },
      issues: {
        async get() {
          return {
            data: {
              number: 12,
              title: "Review context",
              body: [
                "## Acceptance Criteria",
                "- PR files are collected",
                "- Checks are included",
                "",
                "## Notes",
                "Done",
              ].join("\n"),
              html_url: "https://github.com/acme/tool/issues/12",
            },
          };
        },
        async listComments() {
          return {
            data: [
              {
                id: 22,
                body: "<!-- open-maintainer-review-summary -->\nsummary",
              },
              { id: 23, body: "ordinary comment" },
            ],
          };
        },
      },
      checks: {
        async listForRef() {
          return {
            data: {
              check_runs: [
                {
                  name: "build",
                  status: "completed",
                  conclusion: "success",
                  html_url: "https://github.com/acme/tool/actions/runs/2",
                },
              ],
            },
          };
        },
      },
    };

    const context = await fetchPullRequestReviewContext({
      repoId: "repo_1",
      owner: "acme",
      repo: "tool",
      pullNumber: 7,
      limits: { maxFiles: 101, maxFileBytes: 200 },
      client,
    });

    expect(context.prNumber).toBe(7);
    expect(context.baseSha).toBe("base-sha");
    expect(context.headSha).toBe("head-sha");
    expect(context.changedFiles).toHaveLength(100);
    expect(context.changedFiles[0]).toEqual(
      expect.objectContaining({
        path: "src/file-0.ts",
        status: "modified",
      }),
    );
    expect(context.skippedFiles).toEqual([
      { path: "dist/generated.js", reason: "filtered" },
      { path: "src/too-big.ts", reason: "max_file_bytes" },
    ]);
    expect(context.commits).toEqual(["commit-1"]);
    expect(context.checkStatuses.map((check) => check.name).sort()).toEqual([
      "build",
      "ci/test",
    ]);
    expect(context.issueContext[0]?.acceptanceCriteria).toEqual([
      "PR files are collected",
      "Checks are included",
    ]);
    expect(context.existingComments).toEqual([
      {
        id: 22,
        kind: "summary",
        body: "<!-- open-maintainer-review-summary -->\nsummary",
        path: null,
        line: null,
      },
      {
        id: 33,
        kind: "inline",
        body: "<!-- open-maintainer-review-inline -->\ninline",
        path: "src/file-1.ts",
        line: 4,
      },
    ]);

    const detail = await fetchPullRequestDetailForDashboard({
      repoId: "repo_1",
      owner: "acme",
      repo: "tool",
      pullNumber: 7,
      limits: { maxFiles: 101, maxFileBytes: 200 },
      client,
    });

    expect(detail.summary.number).toBe(7);
    expect(detail.summary.changedFiles).toBe(100);
    expect(detail.checks.map((check) => check.name).sort()).toEqual([
      "build",
      "ci/test",
    ]);
    expect(detail.timeline.map((item) => item.kind)).toContain("comment");
    expect(detail.timeline.map((item) => item.kind)).toContain(
      "review_comment",
    );
  });

  it("lists pull requests for the dashboard with filtering and attention signals", async () => {
    const client: GitHubRepositoryClient = {
      repos: {
        async getContent() {
          throw notFound();
        },
        async createOrUpdateFileContents() {
          return { data: { commit: { sha: "unused" } } };
        },
      },
      git: {
        async getRef() {
          return { data: { object: { sha: "unused" } } };
        },
        async createRef() {
          return {};
        },
        async updateRef() {
          return {};
        },
      },
      pulls: {
        async list() {
          return {
            data: [
              {
                number: 9,
                title: "Improve dashboard PR list",
                body: "Adds a faster pull request queue. Generated by Claude.",
                html_url: "https://github.com/acme/tool/pull/9",
                user: { login: "maintainer" },
                draft: false,
                mergeable: false,
                mergeable_state: "DIRTY",
                labels: [{ name: "dashboard" }],
                requested_reviewers: [{ login: "reviewer" }],
                comments: 2,
                review_comments: 1,
                commits: 3,
                additions: 12,
                deletions: 4,
                changed_files: 2,
                created_at: "2026-05-01T00:00:00.000Z",
                updated_at: "2026-05-02T00:00:00.000Z",
                base: { ref: "main", sha: "base" },
                head: { ref: "claude/dashboard-pr-list", sha: "head" },
              },
            ],
          };
        },
        async create() {
          throw new Error("unused");
        },
        async update() {
          throw new Error("unused");
        },
      },
    };

    const pullRequests = await listPullRequestsForDashboard({
      owner: "acme",
      repo: "tool",
      search: "dashboard",
      client,
    });

    expect(pullRequests).toHaveLength(1);
    expect(pullRequests[0]).toEqual(
      expect.objectContaining({
        number: 9,
        labels: ["dashboard"],
        reviewers: ["reviewer"],
        attention: "conflicts",
        triageTags: [
          expect.objectContaining({
            githubLabel: "open-maintainer/llm-authored",
          }),
        ],
      }),
    );
  });

  it("applies dashboard PR labels through GitHub issue APIs", async () => {
    const calls: string[] = [];
    const client: GitHubRepositoryClient = {
      repos: {
        async getContent() {
          throw notFound();
        },
        async createOrUpdateFileContents() {
          return { data: { commit: { sha: "unused" } } };
        },
      },
      git: {
        async getRef() {
          return { data: { object: { sha: "unused" } } };
        },
        async createRef() {
          return {};
        },
        async updateRef() {
          return {};
        },
      },
      pulls: {
        async list() {
          return { data: [] };
        },
        async create() {
          throw new Error("unused");
        },
        async update() {
          throw new Error("unused");
        },
      },
      issues: {
        async createLabel(input) {
          calls.push(`create:${input.name}:${input.color}`);
          return {};
        },
        async addLabels(input) {
          calls.push(`add:${input.issue_number}:${input.labels.join(",")}`);
          return {};
        },
      },
    };

    const applied = await applyPullRequestLabelsForDashboard({
      owner: "acme",
      repo: "tool",
      pullNumber: 9,
      labels: [
        {
          name: "open-maintainer/llm-authored",
          color: "6f42c1",
          description: "PR appears authored by an LLM or coding agent.",
        },
      ],
      client,
    });

    expect(applied).toEqual(["open-maintainer/llm-authored"]);
    expect(calls).toEqual([
      "create:open-maintainer/llm-authored:6f42c1",
      "add:9:open-maintainer/llm-authored",
    ]);
  });

  it("extracts linked issues and acceptance criteria for review context", () => {
    expect(
      extractLinkedIssueNumbers("Fixes #12 and resolves acme/tool#15."),
    ).toEqual([12, 15]);
    expect(
      extractAcceptanceCriteria(
        "Intro\n## Acceptance Criteria\n- First item\n- [x] Done item\n## Other\nNope",
      ),
    ).toEqual(["First item", "Done item"]);
    expect(isOpenMaintainerReviewComment("ordinary comment")).toBe(false);
    expect(
      isOpenMaintainerReviewComment(
        "<!-- open-maintainer-review-summary -->\nbody",
      ),
    ).toBe(true);
  });

  it("plans marked review summary comments without duplicates", () => {
    const markdown = [
      "## Open Maintainer PR Review",
      "",
      "### Summary",
      "",
      "Ready with notes.",
      "",
      "### Findings",
      "",
      "- No blocker findings.",
      "",
      "### Expected Validation",
      "",
      "- `bun test`",
      "",
      "### Docs Impact",
      "",
      "- README.md",
      "",
      "### Merge Readiness",
      "",
      "**Needs Attention:** validation evidence missing.",
      "",
      "### Residual Risk",
      "",
      "- CI status unavailable.",
    ].join("\n");

    const createPlan = planReviewSummaryComment({
      markdown,
      existingComments: [{ id: 1, body: "ordinary comment" }],
    });
    expect(createPlan.action).toBe("create");
    expect(createPlan.existingCommentId).toBeNull();
    expect(createPlan.body).toContain(
      "<!-- open-maintainer-review-summary -->",
    );
    expect(createPlan.body).toContain("### Expected Validation");
    expect(createPlan.body).toContain("### Docs Impact");
    expect(createPlan.body).toContain("### Merge Readiness");
    expect(createPlan.body).toContain("### Residual Risk");

    const updatePlan = planReviewSummaryComment({
      markdown,
      existingComments: [
        { id: 1, body: "ordinary comment" },
        {
          id: 2,
          body: renderMarkedReviewSummaryComment("previous review"),
        },
      ],
    });
    expect(updatePlan.action).toBe("update");
    expect(updatePlan.existingCommentId).toBe(2);
  });

  it("creates or updates one marked review summary comment", async () => {
    const calls: string[] = [];
    const comments = [{ id: 10, body: "ordinary comment" }];
    const client = {
      issues: {
        async listComments() {
          return { data: comments };
        },
        async createComment(input: { body: string }) {
          calls.push(`create:${input.body}`);
          comments.push({ id: 11, body: input.body });
          return {
            data: {
              id: 11,
              html_url: "https://github.com/acme/tool/issues/7#issuecomment-11",
            },
          };
        },
        async updateComment(input: { comment_id: number; body: string }) {
          calls.push(`update:${input.comment_id}:${input.body}`);
          return {
            data: {
              id: input.comment_id,
              html_url: "https://github.com/acme/tool/issues/7#issuecomment-11",
            },
          };
        },
      },
    };

    const first = await upsertReviewSummaryComment({
      owner: "acme",
      repo: "tool",
      pullNumber: 7,
      markdown: "## Open Maintainer PR Review\n\nfirst",
      client,
    });
    const second = await upsertReviewSummaryComment({
      owner: "acme",
      repo: "tool",
      pullNumber: 7,
      markdown: "## Open Maintainer PR Review\n\nsecond",
      client,
    });

    expect(first.action).toBe("create");
    expect(first.commentId).toBe(11);
    expect(second.action).toBe("update");
    expect(second.existingCommentId).toBe(11);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("create:");
    expect(calls[1]).toContain("update:11:");
  });

  it("plans capped inline review comments by severity and skip reason", () => {
    const plan = planInlineReviewComments({
      review: reviewResult(),
      existingComments: [],
      cap: 1,
    });

    expect(plan.comments).toEqual([
      expect.objectContaining({
        findingId: "blocker-finding",
        severity: "blocker",
        path: "src/a.ts",
        line: 10,
      }),
    ]);
    expect(plan.comments[0]?.body).toContain(
      "<!-- open-maintainer-review-inline",
    );
    expect(plan.comments[0]?.body).toContain("Blocker issue");
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { findingId: "missing-line", reason: "missing_line" },
        { findingId: "minor-finding", reason: "cap_reached" },
      ]),
    );
  });

  it("skips duplicate and invalid inline review comments", () => {
    const review = reviewResult();
    const plan = planInlineReviewComments({
      review: {
        ...review,
        findings: [
          ...review.findings,
          {
            id: "unknown-path",
            title: "Unknown path",
            severity: "major",
            body: "Unknown path body.",
            path: "src/other.ts",
            line: 1,
            citations: [
              {
                source: "changed_file",
                path: "src/other.ts",
                excerpt: null,
                reason: "Changed file.",
              },
            ],
          },
        ],
      },
      existingComments: [
        {
          body: '<!-- open-maintainer-review-inline fingerprint="blocker-finding:src/a.ts:10" -->',
          path: "src/a.ts",
          line: 10,
        },
      ],
      cap: 5,
    });

    expect(plan.comments.map((comment) => comment.findingId)).toEqual([
      "minor-finding",
    ]);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { findingId: "blocker-finding", reason: "duplicate" },
        { findingId: "missing-line", reason: "missing_line" },
        { findingId: "unknown-path", reason: "unchanged_path" },
      ]),
    );
  });

  it("publishes inline review comments through one review call", async () => {
    const calls: unknown[] = [];
    const client = {
      pulls: {
        async listReviewComments() {
          return { data: [] };
        },
        async createReview(input: unknown) {
          calls.push(input);
          return {
            data: {
              id: 77,
              html_url:
                "https://github.com/acme/tool/pull/7#pullrequestreview-77",
            },
          };
        },
      },
    };

    const result = await publishInlineReviewComments({
      owner: "acme",
      repo: "tool",
      pullNumber: 7,
      review: reviewResult(),
      cap: 2,
      client,
    });

    expect(result.reviewId).toBe(77);
    expect(result.comments.map((comment) => comment.findingId)).toEqual([
      "blocker-finding",
      "minor-finding",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({
        pull_number: 7,
        event: "COMMENT",
        comments: expect.arrayContaining([
          expect.objectContaining({
            path: "src/a.ts",
            line: 10,
            side: "RIGHT",
          }),
        ]),
      }),
    );
  });
});
