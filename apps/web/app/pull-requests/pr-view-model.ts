import type {
  AuthReadiness,
  Health,
  PullRequestDetail,
  PullRequestListItem,
  Repo,
  ReviewResult,
} from "@open-maintainer/shared";
import { type DashboardApiClient, dashboardApi } from "../dashboard-api";
import {
  type ProviderSummary,
  type SearchParams,
  selectRepo,
  singleParam,
} from "../dashboard-view-model";

export type PullRequestTab = "conversation" | "files" | "commits";
export type PullRequestDraftKind = "review" | "triage";

export type PullRequestsViewModel = {
  health: Health | null;
  authReadiness: AuthReadiness | null;
  repos: Repo[];
  repo: Repo | null;
  providers: ProviderSummary[];
  selectedProvider: ProviderSummary | null;
  pullRequests: PullRequestListItem[];
  selectedPullNumber: number | null;
  selectedPullRequest: PullRequestDetail | null;
  reviews: ReviewResult[];
  selectedReview: ReviewResult | null;
  filters: {
    q: string;
    state: "open" | "closed" | "all";
    sort: "updated" | "created" | "number";
    direction: "asc" | "desc";
    tab: PullRequestTab;
    draft: PullRequestDraftKind;
    batchTriage: boolean;
    selectedPrs: number[];
  };
  source: "github-app" | "local-gh" | null;
  errors: {
    list?: string;
    detail?: string;
    action?: string;
    triage?: string;
  };
  messages: {
    triage?: string;
  };
};

export async function loadPullRequestsViewModel(input: {
  searchParams: SearchParams;
  api?: DashboardApiClient;
}): Promise<PullRequestsViewModel> {
  const api = input.api ?? dashboardApi;
  const requestedRepo = singleParam(
    input.searchParams["repo"] ?? input.searchParams["repoId"],
  );
  const q = singleParam(input.searchParams["q"])?.trim() ?? "";
  const requestedProviderId = singleParam(input.searchParams["providerId"]);
  const requestedReviewId = singleParam(input.searchParams["reviewId"]);
  const actionError = singleParam(input.searchParams["prActionError"]);
  const triageError = singleParam(input.searchParams["prTriageError"]);
  const triageResult = singleParam(input.searchParams["prTriageResult"]);
  const selectedPullNumber = numberParam(input.searchParams["pr"]);
  const selectedPrs = numberParams(input.searchParams["selectedPr"]);
  const filters = {
    q,
    state: pullRequestStateParam(singleParam(input.searchParams["state"])),
    sort: pullRequestSortParam(singleParam(input.searchParams["sort"])),
    direction: directionParam(singleParam(input.searchParams["direction"])),
    tab: tabParam(singleParam(input.searchParams["tab"])),
    draft: draftParam(singleParam(input.searchParams["draft"])),
    batchTriage: singleParam(input.searchParams["batchTriage"]) === "1",
    selectedPrs,
  };

  const [health, authReadiness, reposResponse, providersResponse] =
    await Promise.all([
      api.fetchJson<Health>("/health"),
      api.fetchJson<AuthReadiness>("/auth/ready"),
      api.fetchJson<{ repos: Repo[] }>("/repos"),
      api.fetchJson<{ providers: ProviderSummary[] }>("/model-providers"),
    ]);
  const repos = reposResponse?.repos ?? [];
  const repo =
    selectRepo({ repos, requestedRepo, repoQuery: "" }) ?? repos[0] ?? null;
  const providers = providersResponse?.providers ?? [];
  const selectedProvider =
    providers.find((provider) => provider.id === requestedProviderId) ??
    providers.find((provider) => provider.repoContentConsent) ??
    null;

  if (!repo) {
    return {
      health,
      authReadiness,
      repos,
      repo: null,
      providers,
      selectedProvider,
      pullRequests: [],
      selectedPullNumber: null,
      selectedPullRequest: null,
      reviews: [],
      selectedReview: null,
      filters,
      source: null,
      errors: {
        ...(actionError ? { action: actionError } : {}),
        ...(triageError ? { triage: triageError } : {}),
      },
      messages: triageResult ? { triage: triageResult } : {},
    };
  }

  const listPath = pullRequestListPath({ repoId: repo.id, filters });
  const [listResult, reviewsResponse] = await Promise.all([
    api.getJson<{
      pullRequests: PullRequestListItem[];
      source: "github-app" | "local-gh";
    }>(listPath),
    api.fetchJson<{ reviews: ReviewResult[] }>(`/repos/${repo.id}/reviews`),
  ]);
  const pullRequests = listResult.ok ? listResult.payload.pullRequests : [];
  const pullNumber =
    selectedPullNumber ??
    pullRequests.find((pullRequest) => pullRequest.attention !== "none")
      ?.number ??
    pullRequests[0]?.number ??
    null;
  const detailResult =
    pullNumber === null
      ? null
      : await api.getJson<{
          pullRequest: PullRequestDetail;
          source: "github-app" | "local-gh";
        }>(`/repos/${encodeURIComponent(repo.id)}/pulls/${pullNumber}`);
  const reviews = reviewsResponse?.reviews ?? [];
  const selectedReview =
    reviews.find((review) => review.id === requestedReviewId) ??
    reviews
      .filter((review) => review.prNumber === pullNumber)
      .slice()
      .reverse()[0] ??
    null;

  return {
    health,
    authReadiness,
    repos,
    repo,
    providers,
    selectedProvider,
    pullRequests,
    selectedPullNumber: pullNumber,
    selectedPullRequest:
      detailResult?.ok === true ? detailResult.payload.pullRequest : null,
    reviews,
    selectedReview,
    filters,
    source:
      detailResult?.ok === true
        ? detailResult.payload.source
        : listResult.ok
          ? listResult.payload.source
          : null,
    errors: {
      ...(listResult.ok ? {} : { list: listResult.actionError }),
      ...(detailResult && !detailResult.ok
        ? { detail: detailResult.actionError }
        : {}),
      ...(actionError ? { action: actionError } : {}),
      ...(triageError ? { triage: triageError } : {}),
    },
    messages: triageResult ? { triage: triageResult } : {},
  };
}

export function pullRequestHref(input: {
  repoId: string;
  pullNumber?: number | null;
  filters: PullRequestsViewModel["filters"];
  tab?: PullRequestTab;
  providerId?: string | null;
  reviewId?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set("repo", input.repoId);
  if (input.pullNumber) {
    params.set("pr", String(input.pullNumber));
  }
  if (input.filters.q) {
    params.set("q", input.filters.q);
  }
  params.set("state", input.filters.state);
  params.set("sort", input.filters.sort);
  params.set("direction", input.filters.direction);
  params.set("tab", input.tab ?? input.filters.tab);
  params.set("draft", input.filters.draft);
  if (input.providerId) {
    params.set("providerId", input.providerId);
  }
  if (input.reviewId) {
    params.set("reviewId", input.reviewId);
  }
  if (input.filters.batchTriage) {
    params.set("batchTriage", "1");
  }
  for (const selectedPr of input.filters.selectedPrs) {
    params.append("selectedPr", String(selectedPr));
  }
  return `/pull-requests?${params.toString()}`;
}

function pullRequestListPath(input: {
  repoId: string;
  filters: PullRequestsViewModel["filters"];
}): string {
  const params = new URLSearchParams();
  params.set("state", input.filters.state);
  params.set("sort", input.filters.sort);
  params.set("direction", input.filters.direction);
  if (input.filters.q) {
    params.set("search", input.filters.q);
  }
  return `/repos/${encodeURIComponent(input.repoId)}/pulls?${params.toString()}`;
}

function numberParam(value: string | string[] | undefined): number | null {
  const raw = singleParam(value);
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function numberParams(value: string | string[] | undefined): number[] {
  const rawValues = Array.isArray(value) ? value : value ? [value] : [];
  return [
    ...new Set(
      rawValues
        .map((rawValue) => Number(rawValue))
        .filter((parsed) => Number.isInteger(parsed) && parsed > 0),
    ),
  ];
}

function pullRequestStateParam(
  value: string | undefined,
): PullRequestsViewModel["filters"]["state"] {
  return value === "closed" || value === "all" ? value : "open";
}

function pullRequestSortParam(
  value: string | undefined,
): PullRequestsViewModel["filters"]["sort"] {
  return value === "created" || value === "number" ? value : "updated";
}

function directionParam(
  value: string | undefined,
): PullRequestsViewModel["filters"]["direction"] {
  return value === "asc" ? "asc" : "desc";
}

function tabParam(value: string | undefined): PullRequestTab {
  if (value === "files" || value === "commits") {
    return value;
  }
  return "conversation";
}

function draftParam(value: string | undefined): PullRequestDraftKind {
  return value === "triage" ? "triage" : "review";
}
