import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { dashboardApi } from "../dashboard-api";

type BatchPullRequestTriageResponse = {
  results: Array<{
    number: number;
    appliedLabels: string[];
    status: "labeled" | "no_labels" | "failed";
    error?: string;
  }>;
};

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const repoId = stringFormValue(form, "repoId");
  const providerId = stringFormValue(form, "providerId");
  const selectedPullNumbers = uniquePositiveIntegerStrings(
    form.getAll("selectedPr"),
  );
  let triageError: string | undefined;
  let triageResult: string | undefined;

  if (!repoId || !providerId || selectedPullNumbers.length === 0) {
    triageError =
      "Select at least one PR and a model provider before running triage.";
  } else {
    const response =
      await dashboardApi.postJson<BatchPullRequestTriageResponse>(
        `/repos/${encodeURIComponent(repoId)}/pulls/triage`,
        {
          providerId,
          pullNumbers: selectedPullNumbers.map((value) => Number(value)),
        },
      );
    if (!response.ok) {
      triageError = response.actionError;
    } else {
      triageResult = summarizeBatchTriage(response.payload);
    }
  }

  const url = new URL("/pull-requests", request.url);
  const passthroughFields = [
    ["repo", repoId],
    ["providerId", providerId],
    ["pr", stringFormValue(form, "pr")],
    ["q", stringFormValue(form, "q")],
    ["state", stateParam(stringFormValue(form, "state"))],
    ["sort", sortParam(stringFormValue(form, "sort"))],
    ["direction", directionParam(stringFormValue(form, "direction"))],
    ["tab", tabParam(stringFormValue(form, "tab"))],
    ["draft", draftParam(stringFormValue(form, "draft"))],
    ["batchTriage", "1"],
  ] as const;
  for (const [key, value] of passthroughFields) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  for (const pullNumber of selectedPullNumbers) {
    url.searchParams.append("selectedPr", pullNumber);
  }
  if (triageResult) {
    url.searchParams.set("prTriageResult", triageResult);
  }
  if (triageError) {
    url.searchParams.set("prTriageError", triageError);
  }
  return NextResponse.redirect(url, { status: 303 });
}

function stringFormValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function uniquePositiveIntegerStrings(values: FormDataEntryValue[]): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => {
          const parsed = Number(value);
          return Number.isInteger(parsed) && parsed > 0;
        }),
    ),
  ];
}

function summarizeBatchTriage(
  response: BatchPullRequestTriageResponse,
): string {
  const appliedLabelCount = response.results.reduce(
    (count, result) => count + result.appliedLabels.length,
    0,
  );
  const labeledPullRequestCount = response.results.filter(
    (result) => result.appliedLabels.length > 0,
  ).length;
  const failedCount = response.results.filter(
    (result) => result.status === "failed",
  ).length;
  if (failedCount > 0) {
    const failureDetails = response.results
      .filter((result) => result.status === "failed")
      .slice(0, 3)
      .map((result) =>
        result.error
          ? `#${result.number}: ${compactResultDetail(result.error)}`
          : `#${result.number}: label write failed`,
      )
      .join(" ");
    return `${appliedLabelCount} label(s) applied; ${failedCount} PR(s) failed. ${failureDetails}`;
  }
  if (appliedLabelCount > 0) {
    return `Applied ${appliedLabelCount} label(s) to ${labeledPullRequestCount} PR(s).`;
  }
  return "No labels applied. The model did not classify the selected PRs as LLM-authored or context updates.";
}

function compactResultDetail(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}...`;
}

function stateParam(value: string): string {
  return value === "closed" || value === "all" ? value : "open";
}

function sortParam(value: string): string {
  return value === "created" || value === "number" ? value : "updated";
}

function directionParam(value: string): string {
  return value === "asc" ? "asc" : "desc";
}

function tabParam(value: string): string {
  return value === "files" || value === "commits" ? value : "conversation";
}

function draftParam(value: string): string {
  return value === "triage" ? "triage" : "review";
}
