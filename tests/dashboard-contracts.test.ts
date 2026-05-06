import type {
  AuthReadiness,
  Health,
  Repo,
  RepoProfile,
  RunRecord,
} from "@open-maintainer/shared";
import {
  RepositoryUploadRequestSchema,
  repositoryUploadLimits,
  shouldAlwaysSkipRepositoryUploadPath,
  shouldReadRepositoryUploadPath,
} from "@open-maintainer/shared";
import { describe, expect, it } from "vitest";
import { createDashboardApiClient } from "../apps/web/app/dashboard-api";
import {
  providerPreset,
  repoActionPayload,
  repoActionRequiresProvider,
  repoActionType,
} from "../apps/web/app/dashboard-contracts";
import { loadDashboardViewModel } from "../apps/web/app/dashboard-view-model";

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
