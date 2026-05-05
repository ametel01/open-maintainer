import type { ReviewResult } from "@open-maintainer/shared";
import {
  NotEvaluatedContributionTriage,
  ReviewResultSchema,
} from "@open-maintainer/shared";
import { describe, expect, it } from "vitest";
import {
  parseReviewResult,
  renderInlineReviewComment,
  renderReviewAgentFeedback,
  renderReviewMarkdown,
  renderReviewSummaryComment,
} from "../src";

const citation = {
  source: "open_maintainer_config" as const,
  path: ".open-maintainer.yml",
  excerpt: "Run `bun test` before finishing changes that affect test.",
  reason: "Repo policy defines test validation expectations.",
};

const review: ReviewResult = {
  id: "review_1",
  repoId: "repo_1",
  prNumber: 12,
  baseRef: "main",
  headRef: "feature/review",
  baseSha: "base123",
  headSha: "head456",
  summary: "This PR changes the CLI review flow.",
  walkthrough: ["Updates CLI command handling.", "Adds review rendering."],
  changedSurface: ["apps/cli", "packages/review"],
  riskAnalysis: ["CLI behavior changed and needs focused help coverage."],
  expectedValidation: [
    {
      command: "bun test tests/cli-help.test.ts",
      reason: "CLI help text changed.",
      evidence: [citation],
    },
  ],
  validationEvidence: ["CI reported `bun test` passed."],
  docsImpact: [
    {
      path: "README.md",
      reason: "New CLI behavior is user-facing.",
      required: true,
      evidence: [citation],
    },
  ],
  contributionTriage: NotEvaluatedContributionTriage,
  findings: [
    {
      id: "finding_blocker",
      title: "Missing consent guard",
      severity: "blocker",
      body: "Model-backed review must require explicit repo-content consent.",
      path: "apps/cli/src/index.ts",
      line: 42,
      citations: [citation],
    },
    {
      id: "finding_major",
      title: "Missing focused test",
      severity: "major",
      body: "The CLI behavior changed without a focused help test.",
      path: "tests/cli-help.test.ts",
      line: null,
      citations: [citation],
    },
    {
      id: "finding_minor",
      title: "Docs need update",
      severity: "minor",
      body: "The README should mention the new review command.",
      path: "README.md",
      line: null,
      citations: [citation],
    },
    {
      id: "finding_note",
      title: "Residual CI context",
      severity: "note",
      body: "CI status was not available in the local review.",
      path: null,
      line: null,
      citations: [citation],
    },
  ],
  mergeReadiness: {
    status: "blocked",
    reason: "A blocker finding is present.",
    evidence: [citation],
  },
  residualRisk: [
    "Inline comments are not available until GitHub posting lands.",
  ],
  changedFiles: [
    {
      path: "apps/cli/src/index.ts",
      status: "modified",
      additions: 20,
      deletions: 3,
      patch: "@@ -1 +1 @@",
      previousPath: null,
    },
  ],
  feedback: [],
  modelProvider: null,
  model: null,
  createdAt: "2026-05-02T00:00:00.000Z",
};

const reviewedWithContributionTriage: ReviewResult = {
  ...review,
  contributionTriage: {
    status: "evaluated",
    category: "needs_author_input",
    recommendation: "Ask the author to add validation evidence.",
    evidence: [
      {
        source: "user_input",
        path: null,
        excerpt: "No validation listed.",
        reason: "PR body lacks validation evidence.",
      },
    ],
    missingInformation: ["Validation command output"],
    requiredActions: ["Add validation evidence to the PR description."],
  },
};

describe("review schemas", () => {
  it("accepts a complete rule-grounded review result", () => {
    expect(parseReviewResult(review).findings).toHaveLength(4);
  });

  it("defaults legacy or deterministic review results to not evaluated", () => {
    const { contributionTriage: _contributionTriage, ...legacyReview } = review;

    expect(parseReviewResult(legacyReview).contributionTriage).toEqual(
      NotEvaluatedContributionTriage,
    );
  });

  it("rejects uncited findings", () => {
    const invalid = {
      ...review,
      findings: [{ ...review.findings[0], citations: [] }],
    };

    expect(() => ReviewResultSchema.parse(invalid)).toThrow();
  });
});

describe("review renderers", () => {
  it("renders a full review document", () => {
    const rendered = renderReviewMarkdown(review);

    expect(rendered).toContain("## OpenMaintainer Review #12");
    expect(rendered).toContain("### Walkthrough");
    expect(rendered).toContain("| Area | What changed | Review focus |");
    expect(rendered).toContain("### Contribution Triage");
    expect(rendered).toContain("Status: **Not evaluated**");
    expect(rendered).toContain("### Required Validation For This PR");
    expect(rendered).toContain("### Merge Readiness");
    expect(rendered).toContain("#### Blocker: Missing consent guard");
    expect(rendered).toContain("Impact:");
    expect(rendered).toContain("Recommendation:");
    expect(rendered).toContain("open_maintainer_config .open-maintainer.yml");
  });

  it("renders evaluated contribution triage in markdown", () => {
    const rendered = renderReviewMarkdown(reviewedWithContributionTriage);

    expect(rendered).toContain("### Contribution Triage");
    expect(rendered).toContain("Category: **Needs Author Input**");
    expect(rendered).toContain(
      "Maintainer action: Ask the author to add validation evidence.",
    );
    expect(rendered).toContain("- Validation command output");
    expect(rendered).toContain(
      "- Add validation evidence to the PR description.",
    );
    expect(rendered).toContain("user_input");
  });

  it("renders compact numbered agent feedback", () => {
    const rendered = renderReviewAgentFeedback(reviewedWithContributionTriage);

    expect(rendered).toContain("Open Maintainer agent feedback #12");
    expect(rendered).toContain(
      "Finding types: BLOCKER means must fix; MAJOR means should fix before merge",
    );
    expect(rendered).toContain(
      "- Add validation evidence to the PR description.",
    );
    expect(rendered).toContain(
      "- Run validation command: bun test tests/cli-help.test.ts",
    );
    expect(rendered).toContain(
      "1. [BLOCKER] `apps/cli/src/index.ts:42` - Missing consent guard",
    );
    expect(rendered).toContain(
      "2. [MAJOR] `tests/cli-help.test.ts` - Missing focused test",
    );
    expect(rendered).not.toContain("### Walkthrough");
  });

  it("renders a marked summary comment without GitHub APIs", () => {
    const rendered = renderReviewSummaryComment(reviewedWithContributionTriage);

    expect(rendered).toContain("<!-- open-maintainer-review-summary -->");
    expect(rendered).toContain("This PR changes the CLI review flow.");
    expect(rendered).toContain("### Contribution Triage");
    expect(rendered).toContain("Category: **Needs Author Input**");
    expect(rendered).toContain("### Merge Readiness");
    expect(rendered).toContain("A blocker finding is present.");
  });

  it("renders inline comments from a cited finding", () => {
    const [finding] = review.findings;
    if (!finding) {
      throw new Error("Expected test finding.");
    }
    const rendered = renderInlineReviewComment(finding);

    expect(rendered).toContain("**Blocker: Missing consent guard**");
    expect(rendered).toContain("Evidence:");
  });

  it("throws when rendering an uncited inline finding", () => {
    const [finding] = review.findings;
    if (!finding) {
      throw new Error("Expected test finding.");
    }
    expect(() =>
      renderInlineReviewComment({
        ...finding,
        citations: [],
      }),
    ).toThrow("has no citations");
  });
});
