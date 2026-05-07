import type {
  AuthReadiness,
  Health,
  Repo,
  RepoProfile,
  ReviewResult,
  RunRecord,
} from "@open-maintainer/shared";
import {
  RepositoryUploadRequestSchema,
  repositoryUploadLimits,
  shouldAlwaysSkipRepositoryUploadPath,
  shouldReadRepositoryUploadPath,
} from "@open-maintainer/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDashboardApiClient } from "../apps/web/app/dashboard-api";
import {
  providerPreset,
  repoActionPayload,
  repoActionRequiresProvider,
  repoActionType,
} from "../apps/web/app/dashboard-contracts";
import {
  contextDashboardHref,
  pullRequestsDashboardHref,
} from "../apps/web/app/dashboard-navigation";
import { loadDashboardViewModel } from "../apps/web/app/dashboard-view-model";
import {
  LabelChips,
  MarkdownBody,
} from "../apps/web/app/pull-requests/display";
import { triageDraftMarkdown } from "../apps/web/app/pull-requests/draft-markdown";
import { loadPullRequestsViewModel } from "../apps/web/app/pull-requests/pr-view-model";

describe("dashboard repository upload contracts", () => {
  it("shares upload limits and path filters across browser and API payloads", () => {
    expect(repositoryUploadLimits.maxFiles).toBe(800);
    expect(RepositoryUploadRequestSchema.safeParse({ files: [] }).success).toBe(
      false,
    );
    expect(
      RepositoryUploadRequestSchema.safeParse({
        name: "tool",
        files: [{ path: "src/index.ts", content: "export {};\n" }],
      }).success,
    ).toBe(true);
    expect(
      RepositoryUploadRequestSchema.safeParse({
        name: "large-tool",
        files: Array.from(
          {
            length:
              Math.ceil(
                repositoryUploadLimits.maxTotalBytes /
                  repositoryUploadLimits.maxFileBytes,
              ) + 1,
          },
          (_, index) => ({
            path: `src/file-${index}.ts`,
            content: "x".repeat(repositoryUploadLimits.maxFileBytes),
          }),
        ),
      }).success,
    ).toBe(false);
    expect(
      shouldAlwaysSkipRepositoryUploadPath("node_modules/pkg/index.js"),
    ).toBe(true);
    expect(shouldAlwaysSkipRepositoryUploadPath("src/index.ts")).toBe(false);
    expect(shouldReadRepositoryUploadPath("src/index.ts")).toBe(true);
    expect(shouldReadRepositoryUploadPath("assets/logo.png")).toBe(false);
  });
});

describe("dashboard action contracts", () => {
  it("maps route action commands to API payloads in one place", () => {
    expect(repoActionType("generateContext")).toBe("generateContext");
    expect(repoActionType("missing")).toBeNull();
    expect(repoActionRequiresProvider("generateContext")).toBe(true);
    expect(repoActionRequiresProvider("openContextPr")).toBe(false);
    expect(
      repoActionPayload({
        actionType: "generateContext",
        providerId: "provider_1",
        context: "codex",
        skills: "both",
      }),
    ).toEqual({
      providerId: "provider_1",
      async: true,
      context: "codex",
      skills: "both",
    });
    expect(
      repoActionPayload({
        actionType: "createReview",
        providerId: "provider_1",
        prNumber: "12",
      }),
    ).toEqual({ providerId: "provider_1", prNumber: 12 });
    expect(providerPreset("codex")).toEqual(
      expect.objectContaining({ kind: "codex-cli" }),
    );
    expect(providerPreset("nope")).toBeNull();
  });
});

describe("dashboard navigation contracts", () => {
  it("preserves selected repo and provider across Context and Pull Requests", () => {
    expect(
      contextDashboardHref({
        providerId: "model_provider_1",
        repoId: "local/local tool",
      }),
    ).toBe("/?repo=local%2Flocal+tool&providerId=model_provider_1");
    expect(
      pullRequestsDashboardHref({
        providerId: "model_provider_1",
        repoId: "local/local tool",
      }),
    ).toBe(
      "/pull-requests?repo=local%2Flocal+tool&providerId=model_provider_1",
    );
    expect(contextDashboardHref({ providerId: null, repoId: null })).toBe("/");
    expect(pullRequestsDashboardHref({ providerId: null, repoId: null })).toBe(
      "/pull-requests",
    );
  });
});

describe("pull request draft markdown", () => {
  it("renders PR triage as a maintainer-facing recommendation", () => {
    const markdown = triageDraftMarkdown(
      reviewResultFixture({
        contributionTriage: {
          status: "evaluated",
          category: "ready_for_review",
          recommendation: "Proceed with normal human review.",
          evidence: [
            {
              source: "pull_request_metadata",
              path: null,
              excerpt: "PR is open and mergeable.",
              reason: "PR state supports review.",
            },
          ],
          missingInformation: ["No executed validation output was supplied."],
          requiredActions: [
            "Confirm CI or run a lightweight validation check before merge.",
          ],
        },
      }),
    );

    expect(markdown).toContain("Lane: Ready for human review");
    expect(markdown).toContain("Review now: Yes");
    expect(markdown).toContain("Ask author: No");
    expect(markdown).toContain("Label: `open-maintainer/ready-for-review`");
    expect(markdown).toContain(
      "- Replace any existing `open-maintainer/*` triage label with `open-maintainer/ready-for-review`.",
    );
    expect(markdown).toContain("- Review the PR normally.");
    expect(markdown).toContain(
      "- Validation evidence: No executed validation output was supplied.",
    );
    expect(markdown).toContain(
      "- Before merge: Confirm CI or run a lightweight validation check before merge.",
    );
    expect(markdown).not.toContain("Queue:");
    expect(markdown).not.toContain("GitHub Label Actions");
    expect(markdown).not.toContain("### Missing Information");
    expect(markdown).not.toContain("Maintainer action:");
  });
});

describe("pull request dashboard display", () => {
  it("renders existing PR labels as visible chips", () => {
    const html = renderToStaticMarkup(
      createElement(LabelChips, {
        ariaLabel: "Labels for PR #52",
        labels: ["dashboard", "open-maintainer/llm-authored"],
      }),
    );

    expect(html).toContain('aria-label="Labels for PR #52"');
    expect(html).toContain("dashboard");
    expect(html).toContain("open-maintainer/llm-authored");
    expect(html).toContain("pr-label");
  });

  it("renders PR body markdown without trusting raw HTML", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, {
        value:
          "## Summary\n\n- Adds dashboard labels\n- Formats PR body\n\n`safe code`\n\n[Docs](https://example.com/docs)\n\n<script>alert(1)</script>",
      }),
    );

    expect(html).toContain("<h2>Summary</h2>");
    expect(html).toContain("<li><span>Adds dashboard labels</span></li>");
    expect(html).toContain("<code>safe code</code>");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("dashboard view model", () => {
  it("loads dashboard read models and derives selected provider and PR status", async () => {
    const repo = repoFixture();
    const profile = profileFixture(repo);
    const run = runFixture(repo.id);
    const requests: string[] = [];
    const api = createDashboardApiClient({
      baseUrl: "http://api.test",
      async fetch(input) {
        const url = String(input);
        requests.push(url.replace("http://api.test", ""));
        if (url.endsWith("/health")) {
          return Response.json({
            status: "ok",
            api: "ok",
          } satisfies Partial<Health>);
        }
        if (url.endsWith("/auth/ready")) {
          return Response.json({
            ghAuth: {
              status: "ok",
              error: null,
              checkedAt: "2026-05-04T00:00:00.000Z",
            },
            codexAuth: {
              status: "ok",
              error: null,
              checkedAt: "2026-05-04T00:00:00.000Z",
            },
            claudeAuth: {
              status: "ok",
              error: null,
              checkedAt: "2026-05-04T00:00:00.000Z",
            },
            authReady: true,
            checkedAt: "2026-05-04T00:00:00.000Z",
          } satisfies AuthReadiness);
        }
        if (url.endsWith("/repos")) {
          return Response.json({ repos: [repo] });
        }
        if (url.endsWith("/model-providers")) {
          return Response.json({
            providers: [
              {
                id: "provider_1",
                kind: "claude-cli",
                displayName: "Claude CLI",
                baseUrl: "http://localhost",
                model: "claude-cli",
                repoContentConsent: true,
                createdAt: "2026-05-04T00:00:00.000Z",
                updatedAt: "2026-05-04T00:00:00.000Z",
              },
            ],
          });
        }
        if (url.endsWith(`/repos/${repo.id}/profile`)) {
          return Response.json({ profile });
        }
        if (url.endsWith(`/repos/${repo.id}/artifacts`)) {
          return Response.json({ artifacts: [] });
        }
        if (url.endsWith(`/repos/${repo.id}/runs`)) {
          return Response.json({ runs: [run] });
        }
        if (url.endsWith(`/repos/${repo.id}/reviews`)) {
          return Response.json({ reviews: [] });
        }
        return Response.json({}, { status: 404 });
      },
    });

    const view = await loadDashboardViewModel({
      api,
      searchParams: { repo: repo.id },
    });

    expect(requests).toEqual([
      "/health",
      "/auth/ready",
      "/repos",
      "/model-providers",
      `/repos/${repo.id}/profile`,
      `/repos/${repo.id}/artifacts`,
      `/repos/${repo.id}/runs`,
      `/repos/${repo.id}/reviews`,
    ]);
    expect(view.repo?.id).toBe(repo.id);
    expect(view.authReadiness?.authReady).toBe(true);
    expect(view.selectedProvider?.kind).toBe("claude-cli");
    expect(view.defaultArtifactSelection).toBe("claude");
    expect(view.readiness?.score).toBe(92);
    expect(view.prStatus.url).toBe("https://github.com/acme/tool/pull/42");
  });
});

describe("pull request dashboard view model", () => {
  it("loads PR list, selected detail, reviews, and consented provider state", async () => {
    const repo = repoFixture();
    const requests: string[] = [];
    const api = createDashboardApiClient({
      baseUrl: "http://api.test",
      async fetch(input) {
        const url = String(input);
        requests.push(url.replace("http://api.test", ""));
        if (url.endsWith("/health")) {
          return Response.json({ status: "ok", api: "ok" });
        }
        if (url.endsWith("/auth/ready")) {
          return Response.json({
            ghAuth: {
              status: "ok",
              error: null,
              checkedAt: "2026-05-04T00:00:00.000Z",
            },
            codexAuth: {
              status: "ok",
              error: null,
              checkedAt: "2026-05-04T00:00:00.000Z",
            },
            claudeAuth: {
              status: "ok",
              error: null,
              checkedAt: "2026-05-04T00:00:00.000Z",
            },
            authReady: true,
            checkedAt: "2026-05-04T00:00:00.000Z",
          } satisfies AuthReadiness);
        }
        if (url.endsWith("/repos")) {
          return Response.json({ repos: [repo] });
        }
        if (url.endsWith("/model-providers")) {
          return Response.json({
            providers: [
              {
                id: "provider_1",
                kind: "codex-cli",
                displayName: "Codex CLI",
                baseUrl: "http://localhost",
                model: "gpt-5.5",
                repoContentConsent: true,
                createdAt: "2026-05-04T00:00:00.000Z",
                updatedAt: "2026-05-04T00:00:00.000Z",
              },
            ],
          });
        }
        if (url.includes(`/repos/${repo.id}/pulls?`)) {
          return Response.json({
            source: "local-gh",
            pullRequests: [pullRequestListItemFixture()],
          });
        }
        if (url.endsWith(`/repos/${repo.id}/pulls/52`)) {
          return Response.json({
            source: "local-gh",
            pullRequest: pullRequestDetailFixture(),
          });
        }
        if (url.endsWith(`/repos/${repo.id}/reviews`)) {
          return Response.json({
            reviews: [
              {
                id: "review_1",
                repoId: repo.id,
                prNumber: 52,
                baseRef: "main",
                headRef: "feature",
                baseSha: null,
                headSha: null,
                summary: "Review summary.",
                walkthrough: ["web"],
                changedSurface: ["web"],
                riskAnalysis: [],
                expectedValidation: [],
                validationEvidence: [],
                docsImpact: [],
                contributionTriage: {
                  status: "not_evaluated",
                  category: null,
                  recommendation: "Contribution triage was not evaluated.",
                  evidence: [],
                  missingInformation: [],
                  requiredActions: [],
                },
                findings: [],
                mergeReadiness: {
                  status: "ready",
                  reason: "No blockers.",
                  evidence: [],
                },
                residualRisk: [],
                changedFiles: [],
                feedback: [],
                modelProvider: "Codex CLI",
                model: "gpt-5.5",
                createdAt: "2026-05-04T00:00:00.000Z",
              },
            ],
          });
        }
        return Response.json({}, { status: 404 });
      },
    });

    const view = await loadPullRequestsViewModel({
      api,
      searchParams: {
        repo: repo.id,
        pr: "52",
        tab: "files",
        providerId: "provider_1",
        batchTriage: "1",
        selectedPr: "52",
      },
    });

    expect(requests).toContain(
      `/repos/${repo.id}/pulls?state=open&sort=updated&direction=desc`,
    );
    expect(requests).toContain(`/repos/${repo.id}/pulls/52`);
    expect(view.repo?.id).toBe(repo.id);
    expect(view.selectedPullNumber).toBe(52);
    expect(view.selectedPullRequest?.summary.title).toBe("Add PR dashboard");
    expect(view.filters.tab).toBe("files");
    expect(view.filters.batchTriage).toBe(true);
    expect(view.filters.selectedPrs).toEqual([52]);
    expect(view.selectedProvider?.id).toBe("provider_1");
    expect(view.selectedReview?.id).toBe("review_1");
  });
});

function repoFixture(): Repo {
  return {
    id: "repo_1",
    installationId: "installation_1",
    owner: "acme",
    name: "tool",
    fullName: "acme/tool",
    defaultBranch: "main",
    private: false,
    permissions: { contents: true },
  };
}

function profileFixture(repo: Repo): RepoProfile {
  return {
    id: "profile_1",
    repoId: repo.id,
    version: 1,
    owner: repo.owner,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
    primaryLanguages: ["TypeScript"],
    frameworks: [],
    packageManager: "bun",
    commands: [],
    ciWorkflows: [],
    importantDocs: [],
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
    reviewRuleCandidates: [],
    evidence: [],
    workspaceManifests: [],
    lockfiles: [],
    configFiles: [],
    trackedFileHashes: [],
    contextArtifactHashes: [],
    agentReadiness: {
      score: 92,
      categories: [],
      missingItems: [],
      generatedAt: "2026-05-04T00:00:00.000Z",
    },
    createdAt: "2026-05-04T00:00:00.000Z",
  };
}

function runFixture(repoId: string): RunRecord {
  return {
    id: "run_1",
    repoId,
    type: "context_pr",
    status: "succeeded",
    inputSummary: "Opened context PR.",
    safeMessage: null,
    artifactVersions: [1],
    repoProfileVersion: 1,
    provider: "Codex CLI",
    model: "gpt-test",
    externalId: "https://github.com/acme/tool/pull/42",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
  };
}

function reviewResultFixture(input: {
  contributionTriage: ReviewResult["contributionTriage"];
}): ReviewResult {
  return {
    id: "review_1",
    repoId: "repo_1",
    prNumber: 52,
    baseRef: "main",
    headRef: "feature",
    baseSha: null,
    headSha: null,
    summary: "Review summary.",
    walkthrough: ["web"],
    changedSurface: ["web"],
    riskAnalysis: [],
    expectedValidation: [],
    validationEvidence: [],
    docsImpact: [],
    contributionTriage: input.contributionTriage,
    findings: [],
    mergeReadiness: {
      status: "ready",
      reason: "No blockers.",
      evidence: [],
    },
    residualRisk: [],
    changedFiles: [],
    feedback: [],
    modelProvider: "Codex CLI",
    model: "gpt-5.5",
    createdAt: "2026-05-04T00:00:00.000Z",
  };
}

function pullRequestListItemFixture() {
  return {
    number: 52,
    title: "Add PR dashboard",
    bodyPreview: "Fast queue.",
    url: "https://github.com/acme/tool/pull/52",
    author: "maintainer",
    state: "open",
    isDraft: false,
    labels: ["dashboard"],
    reviewers: ["reviewer"],
    assignees: [],
    baseRef: "main",
    headRef: "feature",
    headSha: "head",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:01:00.000Z",
    comments: 1,
    reviewComments: 0,
    commits: 1,
    changedFiles: 1,
    additions: 4,
    deletions: 2,
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checksSummary: {
      total: 1,
      passing: 1,
      failing: 0,
      pending: 0,
      skipped: 0,
    },
    attention: "review_required",
    unread: false,
    triageTags: [
      {
        id: "llm_authored",
        githubLabel: "open-maintainer/llm-authored",
        label: "LLM-authored",
        description:
          "Open Maintainer detected an AI or agent authorship signal on this PR.",
      },
    ],
  };
}

function pullRequestDetailFixture() {
  return {
    summary: pullRequestListItemFixture(),
    body: "Fast queue.",
    baseSha: "base",
    headSha: "head",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "REVIEW_REQUIRED",
    files: [
      {
        path: "apps/web/app/page.tsx",
        status: "modified",
        additions: 4,
        deletions: 2,
        patch: "@@ -1 +1 @@\n-old\n+new",
        previousPath: null,
      },
    ],
    skippedFiles: [],
    commits: [
      {
        sha: "commit-sha",
        message: "Add PR dashboard",
        author: "maintainer",
        authoredAt: "2026-05-04T00:00:30.000Z",
        url: null,
      },
    ],
    timeline: [
      {
        id: "opened-52",
        kind: "opened",
        author: "maintainer",
        body: "Fast queue.",
        state: null,
        path: null,
        line: null,
        url: "https://github.com/acme/tool/pull/52",
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:01:00.000Z",
      },
    ],
    checks: [
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        url: null,
      },
    ],
  };
}
