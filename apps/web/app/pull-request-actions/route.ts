import type { NextRequest } from "next/server";
import { dashboardApi } from "../dashboard-api";
import { redirectToDashboardRoute } from "../redirect";

type ReviewDraftResponse = {
  review?: { id?: unknown };
};

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const repoId = String(form.get("repoId") ?? "").trim();
  const providerId = String(form.get("providerId") ?? "").trim();
  const pullNumber = String(form.get("pullNumber") ?? "").trim();
  const actionType = String(form.get("actionType") ?? "").trim();
  const tab = String(form.get("tab") ?? "conversation").trim();
  const draft = actionType === "triageDraft" ? "triage" : "review";
  let actionError: string | undefined;
  let reviewId: string | undefined;

  if (!repoId || !providerId || !positiveIntegerString(pullNumber)) {
    actionError = "invalid-pr-action";
  } else if (actionType !== "reviewDraft" && actionType !== "triageDraft") {
    actionError = "invalid-pr-action";
  } else {
    const response = await dashboardApi.postJson<ReviewDraftResponse>(
      `/repos/${encodeURIComponent(repoId)}/reviews`,
      {
        prNumber: Number(pullNumber),
        providerId,
      },
    );
    if (!response.ok) {
      actionError = response.actionError;
    } else if (typeof response.payload.review?.id === "string") {
      reviewId = response.payload.review.id;
    }
  }

  const params: Record<string, string> = {};
  if (repoId) {
    params["repo"] = repoId;
  }
  if (pullNumber) {
    params["pr"] = pullNumber;
  }
  if (providerId) {
    params["providerId"] = providerId;
  }
  params["tab"] = tab === "files" || tab === "commits" ? tab : "conversation";
  params["draft"] = draft;
  if (reviewId) {
    params["reviewId"] = reviewId;
  }
  if (actionError) {
    params["prActionError"] = actionError;
  }
  return redirectToDashboardRoute(request, "/pull-requests", params);
}

function positiveIntegerString(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}
