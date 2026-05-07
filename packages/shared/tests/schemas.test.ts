import { describe, expect, it } from "vitest";
import {
  DefaultIssueTriageLabelMappings,
  IssueTriageAgentReadinessSchema,
  IssueTriageLabelIntentSchema,
  IssueTriageModelResultSchema,
  IssueTriageResultSchema,
  NotEvaluatedContributionTriage,
  RepoProfileSchema,
  ReviewContributionTriageSchema,
  ReviewFeedbackSchema,
  inferPullRequestTriageTags,
  nowIso,
  reviewTriageLabelDefinitions,
  reviewTriageLabelNames,
} from "../src";

describe("shared schemas", () => {
  it("validates a versioned repo profile", () => {
    const profile = RepoProfileSchema.parse({
      id: "profile_1",
      repoId: "repo_1",
      version: 1,
      owner: "ametel01",
      name: "open-maintainer",
      defaultBranch: "main",
      primaryLanguages: ["TypeScript"],
      frameworks: ["Next.js"],
      packageManager: "bun",
      commands: [],
      ciWorkflows: [],
      importantDocs: ["README.md"],
      architecturePathGroups: ["apps"],
      generatedFileHints: ["AGENTS.md"],
      generatedFilePaths: [],
      existingContextFiles: [],
      detectedRiskAreas: [],
      riskHintPaths: [],
      ownershipHints: [],
      environmentFiles: [],
      environmentVariables: [],
      ignoreFiles: [".gitignore"],
      testFilePaths: ["tests/index.test.ts"],
      reviewRuleCandidates: [],
      evidence: [{ path: "README.md", reason: "project overview" }],
      workspaceManifests: ["package.json"],
      lockfiles: ["bun.lock"],
      configFiles: ["tsconfig.json"],
      agentReadiness: {
        score: 40,
        categories: [
          {
            name: "setup clarity",
            score: 20,
            maxScore: 20,
            missing: [],
            evidence: [{ path: "README.md", reason: "project overview" }],
          },
        ],
        missingItems: [],
        generatedAt: nowIso(),
      },
      createdAt: nowIso(),
    });

    expect(profile.version).toBe(1);
  });

  it("validates PR review feedback verdicts", () => {
    for (const verdict of [
      "false_positive",
      "accepted",
      "needs_more_context",
      "unclear",
    ]) {
      const feedback = ReviewFeedbackSchema.parse({
        findingId: "missing-validation-evidence",
        verdict,
        reason: verdict === "false_positive" ? "Covered by CI." : null,
        actor: "maintainer",
        createdAt: nowIso(),
      });

      expect(feedback.verdict).toBe(verdict);
    }

    expect(() =>
      ReviewFeedbackSchema.parse({
        findingId: "missing-validation-evidence",
        verdict: "ignored",
        reason: null,
        actor: null,
        createdAt: nowIso(),
      }),
    ).toThrow();
  });

  it("validates contribution triage category boundaries", () => {
    const evaluated = ReviewContributionTriageSchema.parse({
      status: "evaluated",
      category: "needs_author_input",
      recommendation: "Ask the author for validation evidence.",
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
    });

    expect(evaluated.category).toBe("needs_author_input");
    expect(reviewTriageLabelDefinitions[evaluated.category].name).toBe(
      "open-maintainer/needs-author-input",
    );
    expect(reviewTriageLabelNames.has("open-maintainer/ready-for-review")).toBe(
      true,
    );
    expect(
      ReviewContributionTriageSchema.parse(NotEvaluatedContributionTriage)
        .status,
    ).toBe("not_evaluated");
    expect(() =>
      ReviewContributionTriageSchema.parse({
        status: "evaluated",
        category: "authorship_detection",
        recommendation: "Guess whether AI wrote this.",
        evidence: [],
        missingInformation: [],
        requiredActions: [],
      }),
    ).toThrow();
    expect(() =>
      ReviewContributionTriageSchema.parse({
        ...NotEvaluatedContributionTriage,
        category: "ready_for_review",
      }),
    ).toThrow();
  });

  it("infers automatic PR triage tags for LLM-authored context PRs", () => {
    expect(
      inferPullRequestTriageTags({
        author: "codex",
        title: "Open Maintainer Context Update",
        body: "This PR writes generated Open Maintainer context artifacts for review.",
        files: [{ path: "AGENTS.md" }],
        headRef: "open-maintainer/context-2",
        labels: [],
      }).map((tag) => tag.githubLabel),
    ).toEqual([
      "open-maintainer/llm-authored",
      "open-maintainer/context-update",
    ]);
  });

  it("validates issue triage model results and rejects unknown categories", () => {
    const result = IssueTriageModelResultSchema.parse({
      classification: "needs_author_input",
      qualityScore: 40,
      spamRisk: "low",
      agentReadiness: "not_agent_ready",
      confidence: 0.76,
      signals: ["needs_author_input", "missing_reproduction"],
      evidence: [
        {
          signal: "needs_author_input",
          issueTextQuote: "It fails sometimes.",
          reason: "Issue body is too vague for implementation.",
        },
      ],
      missingInfo: ["reproduction_steps"],
      possibleDuplicates: [],
      maintainerSummary:
        "Ask the author for a reproduction and validation plan.",
      suggestedAuthorRequest: "Add steps to reproduce.",
    });

    expect(result.classification).toBe("needs_author_input");
    expect(result.taskBrief.status).toBe("not_generated");

    expect(() =>
      IssueTriageModelResultSchema.parse({
        ...result,
        classification: "authorship_detection",
      }),
    ).toThrow();
    expect(() =>
      IssueTriageModelResultSchema.parse({
        ...result,
        agentReadiness: "bot_ready",
      }),
    ).toThrow();
  });

  it("requires model-backed issue triage results to cite evidence", () => {
    expect(() =>
      IssueTriageModelResultSchema.parse({
        classification: "ready_for_maintainer_review",
        qualityScore: 92,
        spamRisk: "low",
        agentReadiness: "agent_ready",
        confidence: 0.92,
        signals: ["ready_for_maintainer_review", "agent_ready"],
        evidence: [],
        missingInfo: [],
        possibleDuplicates: [],
        maintainerSummary: "Ready for maintainer review.",
      }),
    ).toThrow();
  });

  it("defines default issue triage label mappings and rejects unknown intents", () => {
    expect(DefaultIssueTriageLabelMappings.needs_author_input).toBe(
      "needs-author-input",
    );
    expect(IssueTriageLabelIntentSchema.parse("possible_duplicate")).toBe(
      "possible_duplicate",
    );
    expect(() =>
      IssueTriageLabelIntentSchema.parse("please_merge_fast"),
    ).toThrow();
  });

  it("keeps issue classification separate from agent readiness", () => {
    expect(IssueTriageAgentReadinessSchema.parse("needs_human_design")).toBe(
      "needs_human_design",
    );
    expect(() =>
      IssueTriageResultSchema.parse({
        id: "triage_1",
        repoId: "repo_1",
        issueNumber: 3,
        classification: "ready_for_maintainer_review",
        qualityScore: 90,
        spamRisk: "low",
        confidence: 0.9,
        signals: ["ready_for_maintainer_review"],
        evidence: [
          {
            signal: "ready_for_maintainer_review",
            issueTextQuote: "Add batch issue triage.",
            reason: "Issue body supplies the requested behavior.",
          },
        ],
        missingInfo: [],
        possibleDuplicates: [],
        maintainerSummary: "Generate a task brief.",
        commentPreview: {
          marker: "<!-- open-maintainer:issue-triage -->",
          summary: "Ready for review.",
          body: "This issue appears ready for review.",
          artifactPath: null,
        },
        writeActions: [],
        modelProvider: "codex-cli",
        model: "codex",
        consentMode: "explicit_repository_content_transfer",
        sourceProfileVersion: 1,
        contextArtifactVersion: null,
        createdAt: nowIso(),
      }),
    ).toThrow();
  });
});
