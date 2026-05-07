import type { NextRequest } from "next/server";
import { dashboardApi } from "../dashboard-api";
import {
  repoActionPathByType,
  repoActionPayload,
  repoActionRequiresProvider,
  repoActionType,
} from "../dashboard-contracts";
import { redirectToDashboard } from "../redirect";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const repoId = String(form.get("repoId") ?? "").trim();
  const providerId = String(form.get("providerId") ?? "").trim();
  const context = String(form.get("context") ?? "").trim();
  const skills = String(form.get("skills") ?? "").trim();
  const baseRef = String(form.get("baseRef") ?? "").trim();
  const headRef = String(form.get("headRef") ?? "").trim();
  const prNumber = String(form.get("prNumber") ?? "").trim();
  const actionType = repoActionType(String(form.get("actionType") ?? ""));
  let actionError: string | undefined;

  if (!repoId || !actionType) {
    actionError = "invalid-action";
  } else if (repoActionRequiresProvider(actionType) && !providerId) {
    actionError = "missing-provider";
  } else {
    const actionPath = repoActionPathByType[actionType];
    const result = await dashboardApi.postJson(
      `/repos/${encodeURIComponent(repoId)}/${actionPath}`,
      repoActionPayload({
        actionType,
        ...(providerId ? { providerId } : {}),
        ...(context ? { context } : {}),
        ...(skills ? { skills } : {}),
        ...(baseRef ? { baseRef } : {}),
        ...(headRef ? { headRef } : {}),
        ...(prNumber ? { prNumber } : {}),
      }),
    );
    if (!result.ok) {
      actionError = result.actionError;
    }
  }

  const params: Record<string, string> = {};
  if (repoId) {
    params["repo"] = repoId;
  }
  if (providerId) {
    params["providerId"] = providerId;
  }
  if (actionError) {
    params["actionError"] = actionError;
  }
  return redirectToDashboard(request, params);
}
