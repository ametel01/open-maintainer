import {
  type ReviewContributionTriageCategory,
  type ReviewResult,
  reviewTriageLabelDefinitions,
} from "@open-maintainer/shared";

type TriageActionPlan = {
  askAuthor: "No" | "Yes";
  beforeMergeFallback: string;
  lane: string;
  primaryAction: string;
  reviewNow: "Manual" | "No" | "Yes";
};

const triageActionPlans: Record<
  ReviewContributionTriageCategory,
  TriageActionPlan
> = {
  ready_for_review: {
    askAuthor: "No",
    beforeMergeFallback: "Verify CI or local validation before merge.",
    lane: "Ready for human review",
    primaryAction: "Review the PR normally.",
    reviewNow: "Yes",
  },
  needs_author_input: {
    askAuthor: "Yes",
    beforeMergeFallback:
      "Do not merge until the author provides the requested information.",
    lane: "Waiting on author",
    primaryAction: "Ask the author for the missing information.",
    reviewNow: "No",
  },
  needs_maintainer_design: {
    askAuthor: "No",
    beforeMergeFallback: "Resolve the maintainer design decision first.",
    lane: "Maintainer decision needed",
    primaryAction: "Make the product/API/design decision before code review.",
    reviewNow: "No",
  },
  not_agent_ready: {
    askAuthor: "No",
    beforeMergeFallback: "Use manual maintainer judgment before merge.",
    lane: "Manual review",
    primaryAction: "Route this PR to manual maintainer review.",
    reviewNow: "Manual",
  },
  possible_spam: {
    askAuthor: "No",
    beforeMergeFallback: "Do not merge unless the spam check is cleared.",
    lane: "Spam check",
    primaryAction: "Check for spam or abuse before reviewing code.",
    reviewNow: "No",
  },
};

export function reviewDraftMarkdown(review: ReviewResult): string {
  const findings = review.findings.length
    ? review.findings
        .map(
          (finding) =>
            `- [${finding.severity}] ${finding.title}${finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})` : ""}\n  ${finding.body}`,
        )
        .join("\n")
    : "- No concrete findings.";
  return [
    "## Open Maintainer PR Review",
    "",
    review.summary,
    "",
    "### Findings",
    findings,
    "",
    "### Required Validation",
    ...review.expectedValidation.map(
      (item) => `- ${item.command}: ${item.reason}`,
    ),
    "",
    "### Merge Readiness",
    `${review.mergeReadiness.status}: ${review.mergeReadiness.reason}`,
  ].join("\n");
}

export function triageDraftMarkdown(review: ReviewResult): string {
  const triage = review.contributionTriage;
  if (triage.status === "not_evaluated" || !triage.category) {
    return [
      "## Triage Recommendation",
      "",
      "Lane: Not evaluated",
      "Review now: No",
      "Ask author: No",
      "Label: none",
      "",
      "### Maintainer Actions",
      "- Run or regenerate PR triage before assigning review.",
    ].join("\n");
  }

  const plan = triageActionPlans[triage.category];
  const label = reviewTriageLabelDefinitions[triage.category].name;

  return [
    "## Triage Recommendation",
    "",
    `Lane: ${plan.lane}`,
    `Review now: ${plan.reviewNow}`,
    `Ask author: ${plan.askAuthor}`,
    `Label: \`${label}\``,
    "",
    "### Maintainer Actions",
    `- Replace any existing \`open-maintainer/*\` triage label with \`${label}\`.`,
    `- ${plan.primaryAction}`,
    ...beforeMergeActions(triage.requiredActions, plan),
    "",
    "### Evidence To Verify",
    ...(triage.missingInformation.length
      ? triage.missingInformation.map(
          (item) => `- ${evidenceGapLabel(item)}: ${item}`,
        )
      : ["- None flagged by triage."]),
    "",
    "### Model Rationale",
    `- ${triage.recommendation}`,
  ].join("\n");
}

function beforeMergeActions(
  requiredActions: string[],
  plan: TriageActionPlan,
): string[] {
  if (requiredActions.length > 0) {
    return requiredActions.map((item) => `- Before merge: ${item}`);
  }
  return [`- Before merge: ${plan.beforeMergeFallback}`];
}

function evidenceGapLabel(item: string): string {
  const normalized = item.toLowerCase();
  if (
    normalized.includes("validation") ||
    normalized.includes("test") ||
    normalized.includes("ci") ||
    normalized.includes("check")
  ) {
    return "Validation evidence";
  }
  if (
    normalized.includes("acceptance") ||
    normalized.includes("intent") ||
    normalized.includes("scope") ||
    normalized.includes("linked issue")
  ) {
    return "Scope evidence";
  }
  if (normalized.includes("doc")) {
    return "Docs evidence";
  }
  return "Missing information";
}
