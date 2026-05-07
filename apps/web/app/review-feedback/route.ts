import type { NextRequest } from "next/server";
import { dashboardApi } from "../dashboard-api";
import { redirectToDashboard } from "../redirect";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const repoId = String(form.get("repoId") ?? "").trim();
  const reviewId = String(form.get("reviewId") ?? "").trim();
  const findingId = String(form.get("findingId") ?? "").trim();
  const verdict = String(form.get("verdict") ?? "").trim();
  const reason = String(form.get("reason") ?? "").trim();
  let actionError: string | undefined;

  if (!reviewId || !findingId || !verdict) {
    actionError = "invalid-feedback";
  } else {
    const response = await dashboardApi.postJson(
      `/reviews/${encodeURIComponent(reviewId)}/feedback`,
      {
        findingId,
        verdict,
        ...(reason ? { reason } : {}),
        actor: "dashboard",
      },
    );
    if (!response.ok) {
      actionError = response.actionError;
    }
  }

  const params: Record<string, string> = {};
  if (repoId) {
    params["repo"] = repoId;
  }
  if (actionError) {
    params["actionError"] = actionError;
  }
  return redirectToDashboard(request, params);
}
