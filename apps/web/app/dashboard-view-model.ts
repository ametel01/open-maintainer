import type {
  AuthReadiness,
  GeneratedArtifact,
  Health,
  ModelProviderConfig,
  Repo,
  RepoProfile,
  ReviewResult,
  RunRecord,
} from "@open-maintainer/shared";
import { type DashboardApiClient, dashboardApi } from "./dashboard-api";

export type SearchParams = Record<string, string | string[] | undefined>;

export type ProviderSummary = Omit<ModelProviderConfig, "encryptedApiKey"> & {
  encryptedApiKey?: string;
};

export type ReadinessProfile = RepoProfile & {
  readiness?: {
    score?: unknown;
    missingItems?: unknown;
    missing?: unknown;
  };
  readinessScore?: unknown;
  missingItems?: unknown;
  readinessMissingItems?: unknown;
};

export type RunWithContext = RunRecord & {
  contextPr?: {
    prUrl?: unknown;
  };
  context?: {
    prUrl?: unknown;
    pullRequestUrl?: unknown;
  };
  prUrl?: unknown;
};

export type DashboardViewModel = {
  health: Health | null;
  authReadiness: AuthReadiness | null;
  repos: Repo[];
  repo: Repo | null;
  profile: ReadinessProfile | null;
  artifacts: GeneratedArtifact[];
  runs: RunWithContext[];
  reviews: ReviewResult[];
  latestReview: ReviewResult | null;
  providers: ProviderSummary[];
  selectedProvider: ProviderSummary | null;
  defaultArtifactSelection: "codex" | "claude";
  readiness: { score: number | undefined; missingItems: string[] } | null;
  prStatus: { label: string; message: string; url: string | null };
  contextActionLabel: string;
  errors: {
    localRepoError?: string;
    actionError?: string;
    providerError?: string;
  };
};

export async function loadDashboardViewModel(input: {
  searchParams: SearchParams;
  api?: DashboardApiClient;
}): Promise<DashboardViewModel> {
  const api = input.api ?? dashboardApi;
  const requestedRepo = singleParam(
    input.searchParams.repo ?? input.searchParams.repoId,
  );
  const repoQuery =
    singleParam(input.searchParams.q)?.trim().toLowerCase() ?? "";
  const requestedProviderId = singleParam(input.searchParams.providerId);
  const localRepoError = singleParam(input.searchParams.localRepoError);
  const actionError = singleParam(input.searchParams.actionError);
  const providerError = singleParam(input.searchParams.providerError);

  const [health, authReadiness, reposResponse, providersResponse] =
    await Promise.all([
      api.fetchJson<Health>("/health"),
      api.fetchJson<AuthReadiness>("/auth/ready"),
      api.fetchJson<{ repos: Repo[] }>("/repos"),
      api.fetchJson<{ providers: ProviderSummary[] }>("/model-providers"),
    ]);
  const repos = reposResponse?.repos ?? [];
  const repo = selectRepo({ repos, requestedRepo, repoQuery });
  const [profileResponse, artifactsResponse, runsResponse, reviewsResponse] =
    await Promise.all([
      repo
        ? api.fetchJson<{ profile: ReadinessProfile }>(
            `/repos/${repo.id}/profile`,
          )
        : null,
      repo
        ? api.fetchJson<{ artifacts: GeneratedArtifact[] }>(
            `/repos/${repo.id}/artifacts`,
          )
        : null,
      repo
        ? api.fetchJson<{ runs: RunWithContext[] }>(`/repos/${repo.id}/runs`)
        : null,
      repo
        ? api.fetchJson<{ reviews: ReviewResult[] }>(
            `/repos/${repo.id}/reviews`,
          )
        : null,
    ]);
  const profile = profileResponse?.profile ?? null;
  const runs = runsResponse?.runs ?? [];
  const providers = providersResponse?.providers ?? [];
  const selectedProvider =
    providers.find((provider) => provider.id === requestedProviderId) ??
    providers.find((provider) => provider.repoContentConsent) ??
    null;
  const prStatus = getPrStatus(runs);
  return {
    health,
    authReadiness,
    repos,
    repo,
    profile,
    artifacts: artifactsResponse?.artifacts ?? [],
    runs,
    reviews: reviewsResponse?.reviews ?? [],
    latestReview: reviewsResponse?.reviews.at(-1) ?? null,
    providers,
    selectedProvider,
    defaultArtifactSelection: artifactSelectionForProvider(selectedProvider),
    readiness: profile ? getReadiness(profile) : null,
    prStatus,
    contextActionLabel:
      repo?.owner === "local" ? "Open PR with gh" : "Open context PR",
    errors: {
      ...(localRepoError ? { localRepoError } : {}),
      ...(actionError ? { actionError } : {}),
      ...(providerError ? { providerError } : {}),
    },
  };
}

export function singleParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function selectRepo({
  repos,
  requestedRepo,
  repoQuery,
}: {
  repos: Repo[];
  requestedRepo: string | undefined;
  repoQuery: string;
}): Repo | null {
  if (requestedRepo) {
    const match = repos.find(
      (repo) =>
        repo.id === requestedRepo ||
        repo.fullName === requestedRepo ||
        repo.name === requestedRepo,
    );
    if (match) {
      return match;
    }
  }
  if (repoQuery) {
    return (
      repos.find((repo) => repo.fullName.toLowerCase().includes(repoQuery)) ??
      null
    );
  }
  return null;
}

export function getReadiness(profile: ReadinessProfile): {
  score: number | undefined;
  missingItems: string[];
} {
  const readiness = profile.readiness;
  const agentReadiness = profile.agentReadiness;
  return {
    score: numberValue(
      profile.readinessScore ?? readiness?.score ?? agentReadiness.score,
    ),
    missingItems: stringArray(
      profile.missingItems ??
        profile.readinessMissingItems ??
        readiness?.missingItems ??
        readiness?.missing ??
        agentReadiness.missingItems,
    ),
  };
}

export function artifactSelectionForProvider(
  provider: ProviderSummary | null,
): "codex" | "claude" {
  return provider?.kind === "claude-cli" ? "claude" : "codex";
}

export function getPrStatus(runs: RunWithContext[]): {
  label: string;
  message: string;
  url: string | null;
} {
  const contextRuns = runs
    .filter((run) => run.type === "context_pr")
    .slice()
    .reverse();
  const runWithUrl = contextRuns.find((run) => findPrUrl(run));
  const url = runWithUrl ? findPrUrl(runWithUrl) : null;
  if (url) {
    return { label: "opened", message: "Context PR opened.", url };
  }
  const latest = contextRuns[0];
  if (!latest) {
    return {
      label: "not opened",
      message:
        "Open a context PR after artifacts have been generated. Local repositories use the authenticated gh CLI in the API environment.",
      url: null,
    };
  }
  return {
    label: latest.status,
    message:
      latest.safeMessage ??
      (latest.status === "succeeded"
        ? "Context PR run succeeded, but no PR URL was returned."
        : latest.inputSummary),
    url: null,
  };
}

export function findPrUrl(run: RunWithContext): string | null {
  const candidates = [
    run.externalId,
    run.prUrl,
    run.contextPr?.prUrl,
    run.context?.prUrl,
    run.context?.pullRequestUrl,
  ];
  const url = candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" &&
      /^https?:\/\/\S+\/pull\/\d+/.test(candidate),
  );
  return url ?? null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
