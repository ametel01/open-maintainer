import type { ModelProvider } from "@open-maintainer/ai";
import { assertProviderConsent } from "@open-maintainer/ai";
import type {
  ModelProviderConfig,
  RepoProfile,
  ReviewEvidenceCitation,
  ReviewFinding,
  ReviewInput,
  ReviewMergeReadiness,
  ReviewResult,
  ReviewSeverity,
} from "@open-maintainer/shared";
import {
  NotEvaluatedContributionTriage,
  ReviewFindingSchema,
  ReviewResultSchema,
  newId,
  nowIso,
} from "@open-maintainer/shared";
import { z } from "zod";
import type { ReviewEvidencePrecheck } from "./index";

const ModelReviewCategorySchema = z.enum([
  "correctness",
  "security",
  "tests",
  "validation",
  "documentation",
  "repo_policy",
  "performance",
  "maintainability",
  "compatibility",
  "deployment",
  "generated_files",
]);

const ModelEvidenceKindSchema = z.enum([
  "patch",
  "changed_file",
  "check_status",
  "repo_profile",
  "openmaintainer_rule",
  "agents_md",
  "repo_skill",
  "issue_context",
  "precheck",
  "generated_context",
]);

const ModelFindingEvidenceSchema = z.object({
  id: z.string().min(1),
  kind: ModelEvidenceKindSchema,
  summary: z.string().min(1),
});

const ModelReviewFindingSchema = z.object({
  severity: z.enum(["blocker", "major", "minor", "note"]),
  category: ModelReviewCategorySchema,
  title: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive().nullable(),
  evidence: z.array(ModelFindingEvidenceSchema).min(1),
  impact: z.string().min(1),
  recommendation: z.string().min(1),
});

const ModelContributionTriageCategorySchema = z.enum([
  "ready_for_review",
  "needs_author_input",
  "needs_maintainer_design",
  "not_agent_ready",
  "possible_spam",
]);

const ModelContributionTriageSchema = z.object({
  category: ModelContributionTriageCategorySchema,
  recommendation: z.string().min(1),
  evidence: z.array(ModelFindingEvidenceSchema).min(1),
  missingInformation: z.array(z.string().min(1)),
  requiredActions: z.array(z.string().min(1)),
});

export const ModelReviewOutputSchema = z.object({
  summary: z.object({
    overview: z.string().min(1),
    changedSurfaces: z.array(z.string().min(1)),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    validationSummary: z.string().min(1),
    docsSummary: z.string().min(1),
  }),
  findings: z.array(ModelReviewFindingSchema).default([]),
  contributionTriage: ModelContributionTriageSchema,
  mergeReadiness: z.object({
    status: z.enum(["ready", "conditionally_ready", "blocked"]),
    reason: z.string().min(1),
    requiredActions: z.array(z.string().min(1)),
  }),
  residualRisk: z.array(
    z.object({
      risk: z.string().min(1),
      reason: z.string().min(1),
      suggestedFollowUp: z.string().min(1),
    }),
  ),
});
export type ModelReviewOutput = z.infer<typeof ModelReviewOutputSchema>;

export const modelReviewOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "findings",
    "contributionTriage",
    "mergeReadiness",
    "residualRisk",
  ],
  properties: {
    summary: {
      type: "object",
      additionalProperties: false,
      required: [
        "overview",
        "changedSurfaces",
        "riskLevel",
        "validationSummary",
        "docsSummary",
      ],
      properties: {
        overview: { type: "string", minLength: 1 },
        changedSurfaces: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        riskLevel: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
        },
        validationSummary: { type: "string", minLength: 1 },
        docsSummary: { type: "string", minLength: 1 },
      },
    },
    findings: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "severity",
          "category",
          "title",
          "file",
          "line",
          "evidence",
          "impact",
          "recommendation",
        ],
        properties: {
          severity: {
            type: "string",
            enum: ["blocker", "major", "minor", "note"],
          },
          category: {
            type: "string",
            enum: [
              "correctness",
              "security",
              "tests",
              "validation",
              "documentation",
              "repo_policy",
              "performance",
              "maintainability",
              "compatibility",
              "deployment",
              "generated_files",
            ],
          },
          title: { type: "string", minLength: 1 },
          file: { type: "string", minLength: 1 },
          line: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
          evidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "kind", "summary"],
              properties: {
                id: { type: "string", minLength: 1 },
                kind: {
                  type: "string",
                  enum: [
                    "patch",
                    "changed_file",
                    "check_status",
                    "repo_profile",
                    "openmaintainer_rule",
                    "agents_md",
                    "repo_skill",
                    "issue_context",
                    "precheck",
                    "generated_context",
                  ],
                },
                summary: { type: "string", minLength: 1 },
              },
            },
          },
          impact: { type: "string", minLength: 1 },
          recommendation: { type: "string", minLength: 1 },
        },
      },
    },
    contributionTriage: {
      type: "object",
      additionalProperties: false,
      required: [
        "category",
        "recommendation",
        "evidence",
        "missingInformation",
        "requiredActions",
      ],
      properties: {
        category: {
          type: "string",
          enum: [
            "ready_for_review",
            "needs_author_input",
            "needs_maintainer_design",
            "not_agent_ready",
            "possible_spam",
          ],
        },
        recommendation: { type: "string", minLength: 1 },
        evidence: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "kind", "summary"],
            properties: {
              id: { type: "string", minLength: 1 },
              kind: {
                type: "string",
                enum: [
                  "patch",
                  "changed_file",
                  "check_status",
                  "repo_profile",
                  "openmaintainer_rule",
                  "agents_md",
                  "repo_skill",
                  "issue_context",
                  "precheck",
                  "generated_context",
                ],
              },
              summary: { type: "string", minLength: 1 },
            },
          },
        },
        missingInformation: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        requiredActions: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
    mergeReadiness: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reason", "requiredActions"],
      properties: {
        status: {
          type: "string",
          enum: ["ready", "conditionally_ready", "blocked"],
        },
        reason: { type: "string", minLength: 1 },
        requiredActions: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
    residualRisk: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["risk", "reason", "suggestedFollowUp"],
        properties: {
          risk: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
          suggestedFollowUp: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

export type ReviewPromptContext = {
  openMaintainerConfig?: string;
  generatedContext?: string;
  agentsMd?: string;
  repoPrReviewSkill?: string;
  repoTestingWorkflowSkill?: string;
  repoOverviewSkill?: string;
  copilotInstructions?: string;
  cursorRule?: string;
  repoSkill?: string;
};

export type ModelBackedReviewOptions = {
  repoId?: string;
  profile: RepoProfile;
  input: ReviewInput;
  rules?: string[];
  precheck: ReviewEvidencePrecheck;
  providerConfig: ModelProviderConfig;
  provider: ModelProvider;
  promptContext?: ReviewPromptContext;
};

export type ReviewEvidenceKind = z.infer<typeof ModelEvidenceKindSchema>;

export type ReviewEvidenceItem = {
  id: string;
  kind: ReviewEvidenceKind;
  summary: string;
  path?: string;
  name?: string;
  content?: string;
};

export async function generateModelBackedReview(
  options: ModelBackedReviewOptions,
): Promise<ReviewResult> {
  assertProviderConsent(options.providerConfig);
  const prompt = buildReviewPrompt(options);
  const completion = await options.provider.complete(prompt, {
    outputSchema: modelReviewOutputJsonSchema,
  });
  const parsed = parseModelReviewOutput(completion.text);
  const evidenceItems = buildReviewEvidenceItems(options);
  const validation = validateModelFindings({
    input: options.input,
    profile: options.profile,
    evidenceItems,
    findings: parsed.findings,
  });
  const contributionTriage = modelContributionTriage({
    model: parsed.contributionTriage,
    evidenceItems,
  });
  const mergeReadiness = modelMergeReadiness(parsed.mergeReadiness);

  return ReviewResultSchema.parse({
    id: newId("review"),
    repoId: options.repoId ?? options.input.repoId,
    prNumber: options.input.prNumber,
    baseRef: options.input.baseRef,
    headRef: options.input.headRef,
    baseSha: options.input.baseSha,
    headSha: options.input.headSha,
    summary: renderModelSummary(parsed.summary),
    walkthrough: options.precheck.walkthrough,
    changedSurface: options.precheck.changedSurface,
    riskAnalysis: options.precheck.riskAnalysis,
    expectedValidation: options.precheck.expectedValidation,
    validationEvidence: options.precheck.validationEvidence,
    docsImpact: options.precheck.docsImpact,
    contributionTriage: contributionTriage.result,
    findings: validation.findings.sort(compareFindingSeverity),
    mergeReadiness,
    residualRisk: [
      ...options.precheck.residualRisk,
      ...parsed.residualRisk.map(formatModelResidualRisk),
      ...validation.residualRisk,
      ...contributionTriage.residualRisk,
    ],
    changedFiles: options.input.changedFiles,
    feedback: [],
    modelProvider: options.providerConfig.displayName,
    model: completion.model || options.providerConfig.model,
    createdAt: nowIso(),
  });
}

export function buildReviewPrompt(input: {
  profile: RepoProfile;
  input: ReviewInput;
  precheck: ReviewEvidencePrecheck;
  rules?: string[];
  promptContext?: ReviewPromptContext;
}) {
  const changedFiles = input.input.changedFiles.map((file, index) => ({
    evidenceId: `patch:${index + 1}`,
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    language: inferFileLanguage(file.path),
    isTest: isTestPath(file.path, input.profile),
    isDocs: isDocsPath(file.path),
    isGenerated: isGeneratedPath(file.path, input.profile),
    isLockfile: input.profile.lockfiles.includes(file.path),
    isConfig: input.profile.configFiles.includes(file.path),
    riskHints: riskHintsForPath(file.path, input.profile),
    patch: file.patch,
  }));
  const issueContext = input.input.issueContext.map((issue) => ({
    evidenceId: `issue:${issue.number}`,
    number: issue.number,
    title: issue.title,
    acceptanceCriteria: issue.acceptanceCriteria,
  }));
  const repository = {
    owner: input.profile.owner,
    name: input.profile.name,
    defaultBranch: input.profile.defaultBranch,
    languages: input.profile.primaryLanguages,
    frameworks: input.profile.frameworks,
    packageManager: input.profile.packageManager,
    commands: input.profile.commands,
    importantDocs: input.profile.importantDocs,
    riskHintPaths: input.profile.riskHintPaths,
    reviewRuleCandidates: input.profile.reviewRuleCandidates,
  };
  const promptContext = input.promptContext ?? {};
  const precheck = {
    changedSurface: input.precheck.changedSurface,
    expectedValidation: input.precheck.expectedValidation,
    validationEvidence: input.precheck.validationEvidence,
    docsImpact: input.precheck.docsImpact,
    riskAnalysis: input.precheck.riskAnalysis,
    residualRisk: input.precheck.residualRisk,
    contributionTriageEvidence: input.precheck.contributionTriageEvidence,
  };
  const evidenceItems = buildReviewEvidenceItems(input);

  return {
    system: [
      "You are OpenMaintainer PR Review, an expert repository-aware code reviewer for GitHub pull requests.",
      "",
      "Return JSON that satisfies the supplied schema.",
      "",
      "Your goal is to produce a high-signal review comparable to a strong senior engineer reviewing the PR before merge.",
      "",
      "Review the PR for concrete issues in:",
      "- correctness",
      "- security",
      "- reliability",
      "- tests",
      "- validation evidence",
      "- documentation alignment",
      "- API/CLI/schema/event/generated-output compatibility",
      "- deployment/CI/release risk",
      "- repo-specific rules",
      "- language/framework-specific pitfalls",
      "- maintainability only when tied to concrete changed code and plausible impact",
      "",
      "Contribution triage boundary:",
      "- The supplied contributionTriageEvidence entries are candidate evidence for PR reviewability only.",
      "- Deterministic precheck evidence is not a contribution-quality classification.",
      "- Do not infer whether the author used AI.",
      "- Assign exactly one contributionTriage category from the output schema using the supplied evidence.",
      "- Contribution triage answers what a maintainer should do before spending normal human review attention; it is not the same as merge readiness.",
      "- GitHub reviewDecision=REVIEW_REQUIRED is normal for PRs awaiting human review and must not by itself prevent ready_for_review.",
      "- GitHub mergeStateStatus=BLOCKED can mean required review is pending; treat it as blocking ready_for_review only when paired with failed/pending checks, draft status, merge conflicts, dirty merge state, or requested changes.",
      "- Do not assign ready_for_review when GitHub PR state says the PR is draft, has merge conflicts, has a dirty merge state, has changes requested, or has failed/pending checks.",
      "- Do not collapse every blocked or imperfect PR into needs_author_input; choose the most specific category below.",
      "- Failed checks block ready_for_review, but they do not automatically decide the replacement category.",
      "- When a PR has failed checks, still classify the primary contribution problem: missing author information, maintainer design decision, automation/agent unsafety, or spam-like noise.",
      "- A failed Open Maintainer audit/doctor drift check on a docs-only PR is usually an author follow-up to refresh or explain generated context, not automatically not_agent_ready.",
      "- Do not include a numeric quality score.",
      "- Do not produce issue labels, issue comments, duplicate issue handling, stale handling, auto-close, or agent task briefs.",
      "",
      "Contribution triage category rubric:",
      "- ready_for_review: clear intent, bounded diff, enough validation evidence or passing checks for the changed surface, and no objective blocker. REVIEW_REQUIRED or mergeStateStatus=BLOCKED from pending human review alone is compatible with ready_for_review.",
      "- needs_author_input: the primary blocker is missing or unclear author-supplied information, such as no acceptance criteria, no reproduction, unclear intent, missing validation evidence, or an unexplained standalone change.",
      "- needs_maintainer_design: the primary blocker is a maintainer-owned product, architecture, governance, permission, workflow, or policy decision rather than missing author detail.",
      "- not_agent_ready: the PR has objective execution or automation blockers such as draft status, merge conflicts, dirty merge state, broken tests/builds/typechecks, failed non-audit CI, or high-risk CI/release/dependency/security/generated-file changes that are not safe for agent handoff.",
      "- possible_spam: the PR is low-context, promotional, irrelevant, nonspecific, or asks for fast merge without a repository-specific problem, acceptance criteria, or useful validation.",
      "- Category priority when multiple signals apply: possible_spam, needs_maintainer_design, not_agent_ready, needs_author_input, ready_for_review.",
      "",
      "Evidence policy:",
      "- Every finding must cite one or more supplied evidence item IDs.",
      "- Changed file patches count as evidence.",
      "- Check statuses count as evidence.",
      "- AGENTS.md, repo skills, OpenMaintainer rules/config, generated context, issue context, and precheck evidence count as evidence.",
      "- You may use language/framework semantics to reason about impact, but every finding must still cite concrete patch or repo evidence.",
      "- If a concern is plausible but not directly supported by evidence, put it in residualRisk instead of findings.",
      "- Do not invent commands, files, services, tests, APIs, policies, owners, deployment flows, or runtime behavior.",
      "",
      "Noise control:",
      "- Do not emit generic style advice.",
      "- Do not emit broad refactor suggestions.",
      "- Do not comment on unchanged code unless the PR depends on it, exposes it, or makes it worse.",
      "- Do not duplicate findings.",
      "- Do not complain about missing tests/docs unless the changed behavior, repo context, or risk level makes them relevant.",
      "- Do not praise the PR.",
      "- Prefer fewer findings with higher confidence.",
      "",
      "Best-practice rule:",
      "- You may emit language/framework/security best-practice findings only when the patch concretely violates the practice and the impact is specific.",
      "- A best-practice finding must include the changed file/line, impact, and a concrete fix or verification step.",
      "",
      "Severity rules:",
      "- blocker: must fix before merge; likely security issue, data loss, broken build/tests, auth/permission bypass, unsafe release/deploy behavior, or severe correctness regression.",
      "- major: likely bug, missing required validation, missing tests for risky behavior, public contract mismatch, or significant reliability/security risk.",
      "- minor: localized issue with clear improvement value but low merge risk.",
      "- note: non-blocking observation, residual concern with some evidence, or useful follow-up.",
      "",
      "Merge readiness:",
      "- Block if there are blocker findings or failed required checks.",
      "- Block or conditionally approve if required validation/docs/tests are missing for high-risk changed surfaces.",
      "- Mark conditionally ready if only minor issues or clearly stated validation gaps remain.",
      "- Mark ready only when no blocking/major issues are found and validation evidence is adequate for the changed surface.",
      "",
      "Output:",
      "- Return only valid JSON.",
      "- Do not include markdown fences.",
      "- Do not include text outside JSON.",
    ].join("\n"),
    user: JSON.stringify(
      {
        task: "Review this pull request against approved repo context, changed code, check statuses, issue intent, and language/framework/security best practices.",
        reviewMode: {
          goal: "Produce a high-signal PR review comparable to a strong senior engineer review.",
          maxFindings: 10,
          preferFewerFindings: true,
          allowBestPracticeFindings: true,
          bestPracticeConstraint:
            "Allowed only when tied to a concrete changed line, repo context, language/framework semantics, and plausible impact.",
          reviewUnchangedCode:
            "Only if the PR depends on it, exposes it, or makes an existing risk worse.",
        },
        citationRules: [
          "Every finding must cite at least one supplied evidenceItems[].id.",
          "Changed file patches count as evidence.",
          "Check statuses count as evidence.",
          "OpenMaintainer rules, AGENTS.md, generated context, and repo skills count as evidence.",
          "Issue context counts as evidence.",
          "Language/framework reasoning may support impact analysis, but it does not replace a concrete citation to changed code or repo evidence.",
          "Uncited or generic concerns must go to residualRisk or be omitted.",
        ],
        pullRequest: {
          number: input.input.prNumber,
          title: input.input.title,
          body: input.input.body,
          author: input.input.author,
          isDraft: input.input.isDraft,
          mergeable: input.input.mergeable,
          mergeStateStatus: input.input.mergeStateStatus,
          reviewDecision: input.input.reviewDecision,
          baseRef: input.input.baseRef,
          headRef: input.input.headRef,
        },
        repository,
        evidenceItems,
        context: {
          openMaintainerRules: input.rules ?? [],
          openMaintainerConfig: promptContext.openMaintainerConfig ?? null,
          agentsMd:
            promptContext.agentsMd ?? promptContext.generatedContext ?? null,
          generatedContext: promptContext.generatedContext ?? null,
          repoPrReviewSkill:
            promptContext.repoPrReviewSkill ?? promptContext.repoSkill ?? null,
          repoTestingWorkflowSkill:
            promptContext.repoTestingWorkflowSkill ?? null,
          repoOverviewSkill: promptContext.repoOverviewSkill ?? null,
          copilotInstructions: promptContext.copilotInstructions ?? null,
          cursorRule: promptContext.cursorRule ?? null,
        },
        issueContext,
        changedFiles,
        checkStatuses: input.input.checkStatuses.map((check, index) => ({
          evidenceId: `check:${index + 1}`,
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
          details: check.url,
        })),
        precheck,
        reviewKnowledge: selectedReviewKnowledge(input.profile, input.input),
        reviewDimensions: {
          correctness: {
            emitWhen:
              "Changed code can produce wrong output, crash, fail to compile, mishandle async/control flow, or violate expected behavior.",
          },
          security: {
            emitWhen:
              "Changed code introduces or worsens exposure around secrets, auth, permissions, external input, command execution, path/file access, webhooks, SQL/ORM, HTML/rendering, network requests, or dependency execution.",
          },
          tests: {
            emitWhen:
              "Behavior changes lack focused tests and repo context indicates tests are expected or available.",
          },
          validation: {
            emitWhen:
              "Required checks failed, are missing, or do not cover the changed surface.",
          },
          docs: {
            emitWhen:
              "Public behavior, CLI/API surface, generated output, setup, workflow, event/schema, or integration behavior changed without matching docs.",
          },
          repoGovernance: {
            emitWhen:
              "Patch violates AGENTS.md, repo skills, OpenMaintainer config, generated-file rules, lockfile rules, or high-risk path requirements.",
          },
          maintainability: {
            emitWhen:
              "Patch introduces concrete localized complexity likely to cause bugs, duplicated logic in a sensitive path, or hard-to-review behavior.",
          },
        },
        mergePolicy: {
          blockedIf: [
            "any blocker finding exists",
            "required CI/check failed",
            "security-sensitive changed surface lacks validation evidence",
            "repo policy requires docs/tests and they are missing",
            "patch changes deployment/release/default-branch write behavior without explicit intent",
          ],
          conditionallyReadyIf: [
            "only minor/note findings exist",
            "validation is partially missing but risk is low and residual risk is stated",
            "docs follow-up is needed but public behavior is not changed",
          ],
          readyIf: [
            "no blocker or major findings",
            "required checks passed or scoped validation is sufficient",
            "docs/tests are aligned with changed behavior",
          ],
        },
        reviewChecklist: {
          correctness: [
            "Check for changed-code behavior that can crash, return wrong results, skip required work, mishandle async/control flow, mishandle null/undefined, or break API/CLI/schema/event contracts.",
          ],
          security: [
            "Check concrete changed code touching auth, permissions, secrets, tokens, webhooks, user input, command execution, file paths, network requests, SQL/ORM, HTML rendering, dependencies, or CI/deploy behavior.",
            "Flag injection, path traversal, SSRF, XSS, CSRF, secret leakage, auth bypass, unsafe logging, unsafe default-branch mutation, and insufficient webhook signature handling when evidenced.",
          ],
          tests: [
            "Check whether behavior changes have focused tests or updated fixtures.",
            "Do not demand tests for docs-only or trivial mechanical changes unless repo rules require them.",
          ],
          validation: [
            "Check whether validation evidence matches the changed surface and repo rules.",
            "Failed required checks or missing validation for high-risk surfaces should produce findings.",
          ],
          docs: [
            "Check docs alignment for public behavior, CLI/API/generated-output/setup/workflow/schema/event/integration changes.",
          ],
          repoPolicy: [
            "Apply AGENTS.md, repo skills, OpenMaintainer rules/config, risk paths, generated-file rules, lockfile rules, and docs routing.",
          ],
          maintainability: [
            "Only flag maintainability when localized changed code creates concrete future bug risk or review burden.",
          ],
        },
        outputRequirements: {
          maxFindings: 10,
          severities: ["blocker", "major", "minor", "note"],
          contributionTriageCategories: {
            ready_for_review:
              "Clear intent, bounded diff, enough validation or passing checks for the changed surface, and no objective blocker. REVIEW_REQUIRED or mergeStateStatus=BLOCKED from pending human review alone is allowed.",
            needs_author_input:
              "Use when the primary blocker is missing or unclear author-supplied information, such as acceptance criteria, reproduction, intent, validation evidence, or explanation.",
            needs_maintainer_design:
              "Use when the primary blocker is a maintainer-owned product, architecture, governance, permission, workflow, or policy decision.",
            not_agent_ready:
              "Use when objective execution or automation blockers exist: draft status, merge conflicts, dirty merge state, broken tests/builds/typechecks, failed non-audit CI, or high-risk CI/release/dependency/security/generated-file changes unsafe for agent handoff.",
            possible_spam:
              "Use when the PR is low-context, promotional, irrelevant, nonspecific, or asks for fast merge without a repository-specific problem, acceptance criteria, or useful validation.",
          },
          contributionTriageRules: [
            "Use contributionTriageEvidence as candidate evidence, not as a deterministic classification.",
            "Return a categorical contributionTriage result only from model judgment.",
            "Classify readiness for human review, not readiness to merge.",
            "Do not treat reviewDecision=REVIEW_REQUIRED as an author-input problem; that is normal before human review.",
            "Do not treat mergeStateStatus=BLOCKED as an author-input problem unless the evidence also shows failed/pending checks, draft status, merge conflicts, dirty merge state, or requested changes.",
            "Do not return ready_for_review if contributionTriageEvidence or checkStatuses show draft status, merge conflicts, dirty merge state, changes requested, failed checks, or pending checks.",
            "Do not make every failed-check PR not_agent_ready; classify the primary problem and include failed checks in requiredActions.",
            "For docs-only PRs where the only failed check is Open Maintainer audit/doctor drift, prefer needs_author_input unless the content primarily needs maintainer design.",
            "Choose the most specific category using this priority: possible_spam, needs_maintainer_design, not_agent_ready, needs_author_input, ready_for_review.",
            "Do not include numeric quality scores.",
            "Do not infer whether the author used AI.",
            "Do not output issue labels, issue comments, duplicate issue handling, stale handling, auto-close, or agent task briefs.",
          ],
          invalidFindings:
            "Move uncited, speculative, duplicate, or generic concerns to residualRisk or omit.",
          requiredFindingProperties: [
            "severity",
            "category",
            "title",
            "file",
            "line",
            "evidence",
            "impact",
            "recommendation",
          ],
        },
      },
      null,
      2,
    ),
  };
}

export function parseModelReviewOutput(text: string): ModelReviewOutput {
  const parsed = JSON.parse(text) as unknown;
  return ModelReviewOutputSchema.parse(parsed);
}

function validateModelFindings(input: {
  input: ReviewInput;
  profile: RepoProfile;
  evidenceItems: ReviewEvidenceItem[];
  findings: ModelReviewOutput["findings"];
}): { findings: ReviewFinding[]; residualRisk: string[] } {
  const findings: ReviewFinding[] = [];
  const residualRisk: string[] = [];
  const evidenceById = new Map(
    input.evidenceItems.map((item) => [item.id, item]),
  );
  input.findings.forEach((finding, index) => {
    const citations = finding.evidence.flatMap((evidence) => {
      const evidenceItem = evidenceById.get(evidence.id);
      return evidenceItem
        ? [citationFromEvidenceItem(evidenceItem, evidence.summary)]
        : [];
    });
    const unknown = finding.evidence.filter(
      (evidence) => !evidenceById.has(evidence.id),
    );
    if (unknown.length > 0) {
      residualRisk.push(
        `Model finding "${finding.title}" was not rendered because it cited unknown evidence.`,
      );
      return;
    }
    findings.push(
      ReviewFindingSchema.parse({
        id: `model-${slugify(finding.title)}-${index + 1}`,
        title: finding.title,
        severity: finding.severity,
        body: [
          `Category: ${finding.category}.`,
          `Impact: ${finding.impact}`,
          `Recommendation: ${finding.recommendation}`,
        ].join("\n"),
        path: finding.file,
        line: finding.line,
        citations,
      }),
    );
  });
  return { findings, residualRisk };
}

function modelContributionTriage(input: {
  model: ModelReviewOutput["contributionTriage"];
  evidenceItems: ReviewEvidenceItem[];
}): {
  result: ReviewResult["contributionTriage"];
  residualRisk: string[];
} {
  const evidenceById = new Map(
    input.evidenceItems.map((item) => [item.id, item]),
  );
  const citations = input.model.evidence.flatMap((evidence) => {
    const evidenceItem = evidenceById.get(evidence.id);
    return evidenceItem
      ? [citationFromEvidenceItem(evidenceItem, evidence.summary)]
      : [];
  });
  const unknown = input.model.evidence.filter(
    (evidence) => !evidenceById.has(evidence.id),
  );
  if (citations.length === 0) {
    return {
      result: {
        ...NotEvaluatedContributionTriage,
        recommendation:
          "Contribution triage was not evaluated because model evidence citations were unavailable.",
      },
      residualRisk: [
        "Model contribution triage was not rendered because it cited no known evidence.",
      ],
    };
  }

  return {
    result: {
      status: "evaluated",
      category: input.model.category,
      recommendation: input.model.recommendation,
      evidence: citations,
      missingInformation: input.model.missingInformation,
      requiredActions: input.model.requiredActions,
    },
    residualRisk:
      unknown.length > 0
        ? [
            `Model contribution triage cited ${unknown.length} unknown evidence item(s).`,
          ]
        : [],
  };
}

function citationFromEvidenceItem(
  item: ReviewEvidenceItem,
  reason: string,
): ReviewEvidenceCitation {
  switch (item.kind) {
    case "patch":
    case "changed_file":
      return {
        source: "changed_file",
        path: item.path ?? null,
        excerpt: item.summary,
        reason,
      };
    case "check_status":
      return {
        source: "ci_status",
        path: item.name ?? item.path ?? null,
        excerpt: item.summary,
        reason,
      };
    case "openmaintainer_rule":
      return {
        source: "open_maintainer_config",
        path: ".open-maintainer.yml",
        excerpt: item.summary,
        reason,
      };
    case "agents_md":
    case "generated_context":
      return {
        source: "generated_context",
        path: item.path ?? "AGENTS.md",
        excerpt: item.summary,
        reason,
      };
    case "repo_skill":
      return {
        source: "repo_skill",
        path: item.path ?? null,
        excerpt: item.summary,
        reason,
      };
    case "issue_context":
      return {
        source: "issue_acceptance_criteria",
        path: item.path ?? null,
        excerpt: item.summary,
        reason,
      };
    case "precheck":
    case "repo_profile":
      return {
        source: "repo_profile",
        path: item.path ?? ".open-maintainer/profile.json",
        excerpt: item.summary,
        reason,
      };
  }
}

function renderModelSummary(summary: ModelReviewOutput["summary"]): string {
  return [
    summary.overview,
    `Risk: ${summary.riskLevel}.`,
    `Validation: ${summary.validationSummary}`,
    `Docs: ${summary.docsSummary}`,
  ].join("\n");
}

function formatModelResidualRisk(
  risk: ModelReviewOutput["residualRisk"][number],
): string {
  return `${risk.risk} ${risk.reason} Follow-up: ${risk.suggestedFollowUp}`;
}

export function buildReviewEvidenceItems(input: {
  profile: RepoProfile;
  input: ReviewInput;
  precheck: ReviewEvidencePrecheck;
  rules?: string[];
  promptContext?: ReviewPromptContext;
}): ReviewEvidenceItem[] {
  const items: ReviewEvidenceItem[] = [];
  input.input.changedFiles.forEach((file, index) => {
    items.push({
      id: `patch:${index + 1}`,
      kind: "patch",
      path: file.path,
      summary: `${file.status} ${file.path} (+${file.additions}/-${file.deletions})`,
    });
  });
  input.input.changedFiles.forEach((file, index) => {
    items.push({
      id: `changed_file:${index + 1}`,
      kind: "changed_file",
      path: file.path,
      summary: `${file.status} changed file ${file.path}`,
    });
  });
  input.input.checkStatuses.forEach((check, index) => {
    items.push({
      id: `check:${index + 1}`,
      kind: "check_status",
      name: check.name,
      summary: `${check.name} ${check.status} ${check.conclusion ?? ""}`.trim(),
    });
  });
  if (
    input.input.isDraft !== null ||
    input.input.mergeable ||
    input.input.mergeStateStatus ||
    input.input.reviewDecision
  ) {
    items.push({
      id: "pr_state:1",
      kind: "check_status",
      name: "GitHub PR state",
      summary: [
        `draft=${input.input.isDraft ?? "unknown"}`,
        `mergeable=${input.input.mergeable ?? "unknown"}`,
        `mergeStateStatus=${input.input.mergeStateStatus ?? "unknown"}`,
        `reviewDecision=${input.input.reviewDecision ?? "unknown"}`,
      ].join("; "),
    });
  }
  input.profile.evidence.forEach((evidence, index) => {
    items.push({
      id: `profile:${index + 1}`,
      kind: "repo_profile",
      path: evidence.path,
      summary: evidence.reason,
    });
  });
  input.profile.commands.forEach((command, index) => {
    items.push({
      id: `command:${index + 1}`,
      kind: "repo_profile",
      path: command.source,
      summary: `${command.name}: ${command.command}`,
    });
  });
  (input.rules ?? []).forEach((rule, index) => {
    items.push({
      id: `rule:${index + 1}`,
      kind: "openmaintainer_rule",
      path: ".open-maintainer.yml",
      summary: rule,
    });
  });
  for (const issue of input.input.issueContext) {
    items.push({
      id: `issue:${issue.number}`,
      kind: "issue_context",
      path: `#${issue.number}`,
      summary: `${issue.title}: ${issue.acceptanceCriteria.join("; ")}`,
    });
  }
  input.precheck.expectedValidation.forEach((validation, index) => {
    items.push({
      id: `precheck:validation:${index + 1}`,
      kind: "precheck",
      path: ".open-maintainer/profile.json",
      summary: `${validation.command}: ${validation.reason}`,
    });
  });
  input.precheck.docsImpact.forEach((docsImpact, index) => {
    items.push({
      id: `precheck:docs:${index + 1}`,
      kind: "precheck",
      path: docsImpact.path,
      summary: `${docsImpact.required ? "Required" : "Optional"} docs impact: ${docsImpact.reason}`,
    });
  });
  input.precheck.contributionTriageEvidence.forEach((candidate, index) => {
    items.push({
      id: `precheck:contribution:${index + 1}`,
      kind: "precheck",
      path: ".open-maintainer/profile.json",
      summary: `${candidate.signal}: ${candidate.summary}`,
    });
  });

  const promptContext = input.promptContext ?? {};
  addContextEvidence(items, {
    id: "context:agents-md",
    kind: "agents_md",
    path: "AGENTS.md",
    content: promptContext.agentsMd ?? promptContext.generatedContext,
  });
  addContextEvidence(items, {
    id: "context:openmaintainer-config",
    kind: "openmaintainer_rule",
    path: ".open-maintainer.yml",
    content: promptContext.openMaintainerConfig,
  });
  addContextEvidence(items, {
    id: "context:generated",
    kind: "generated_context",
    path: ".open-maintainer/report.md",
    content: promptContext.generatedContext,
  });
  addContextEvidence(items, {
    id: "context:pr-review-skill",
    kind: "repo_skill",
    path: `.agents/skills/${input.profile.name}-pr-review/SKILL.md`,
    content: promptContext.repoPrReviewSkill ?? promptContext.repoSkill,
  });
  addContextEvidence(items, {
    id: "context:testing-skill",
    kind: "repo_skill",
    path: `.agents/skills/${input.profile.name}-testing-workflow/SKILL.md`,
    content: promptContext.repoTestingWorkflowSkill,
  });
  addContextEvidence(items, {
    id: "context:overview-skill",
    kind: "repo_skill",
    path: `.agents/skills/${input.profile.name}-start-task/SKILL.md`,
    content: promptContext.repoOverviewSkill,
  });
  return items;
}

function addContextEvidence(
  items: ReviewEvidenceItem[],
  input: {
    id: string;
    kind: ReviewEvidenceKind;
    path: string;
    content: string | undefined;
  },
) {
  if (!input.content) {
    return;
  }
  items.push({
    id: input.id,
    kind: input.kind,
    path: input.path,
    summary: summarizeEvidenceContent(input.content),
    content: input.content,
  });
}

function summarizeEvidenceContent(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 240);
}

function selectedReviewKnowledge(
  profile: RepoProfile,
  input: ReviewInput,
): Record<string, string[]> {
  const selectors = new Set(
    [
      ...profile.primaryLanguages,
      ...profile.frameworks,
      ...input.changedFiles.map((file) => file.path),
    ].map((value) => value.toLowerCase()),
  );
  const has = (pattern: RegExp) =>
    [...selectors].some((value) => pattern.test(value));
  const knowledge: Record<string, string[]> = {};
  if (has(/typescript|javascript|\.tsx?$|\.jsx?$/)) {
    knowledge["typescript"] = [
      "Check async functions for missing await, swallowed promise rejection, and incorrect Promise handling.",
      "Check unsafe any, unchecked unknown casts, incorrect optional/null handling, and type assertions that bypass validation.",
      "Check API boundary validation with zod or equivalent when user input enters the system.",
      "Check package boundary changes against exported types and project references.",
      "Check React code for invalid hooks usage, unstable keys, client/server component boundary mistakes, and unsafe rendering.",
    ];
  }
  if (has(/node|bun|package\.json|child_process|process\.env/)) {
    knowledge["node"] = [
      "Check file path handling for traversal risks.",
      "Check child_process usage for command injection.",
      "Check environment variable access and secret logging.",
      "Check webhook handlers for signature verification before body parsing assumptions.",
    ];
  }
  if (has(/fastify|apps\/api/)) {
    knowledge["fastify"] = [
      "Check route handlers for schema validation, error handling, and reply lifecycle mistakes.",
      "Check auth/permission checks happen before side effects.",
    ];
  }
  if (has(/github|webhook|pull_request|packages\/github|action\.ya?ml/)) {
    knowledge["githubApps"] = [
      "Check webhook signature verification, installation auth, token scope, branch write behavior, and default-branch mutation.",
    ];
  }
  if (has(/docker|docker-compose|dockerfile/)) {
    knowledge["docker"] = [
      "Check env var exposure, port changes, volume changes, and service dependency changes.",
    ];
  }
  return knowledge;
}

function inferFileLanguage(repoPath: string): string | null {
  const lower = repoPath.toLowerCase();
  if (/\.(ts|tsx)$/.test(lower)) {
    return "TypeScript";
  }
  if (/\.(js|jsx|mjs|cjs)$/.test(lower)) {
    return "JavaScript";
  }
  if (lower.endsWith(".json")) {
    return "JSON";
  }
  if (/\.(ya?ml)$/.test(lower)) {
    return "YAML";
  }
  if (lower.endsWith(".md")) {
    return "Markdown";
  }
  return null;
}

function isTestPath(repoPath: string, profile: RepoProfile): boolean {
  return (
    profile.testFilePaths.includes(repoPath) ||
    /(^|\/)(tests?|__tests__)\//.test(repoPath) ||
    /\.(test|spec)\.[cm]?[tj]sx?$/.test(repoPath)
  );
}

function isDocsPath(repoPath: string): boolean {
  return (
    repoPath.endsWith(".md") ||
    repoPath.startsWith("docs/") ||
    repoPath === "README.md" ||
    repoPath === "CONTRIBUTING.md"
  );
}

function isGeneratedPath(repoPath: string, profile: RepoProfile): boolean {
  return (
    isKnownGeneratedContextPath(repoPath, profile) ||
    profile.generatedFilePaths.includes(repoPath)
  );
}

function riskHintsForPath(repoPath: string, profile: RepoProfile): string[] {
  return profile.riskHintPaths.filter((riskPath) =>
    repoPath.startsWith(riskPath),
  );
}

function isKnownGeneratedContextPath(path: string, profile: RepoProfile) {
  return (
    path === "AGENTS.md" ||
    path.startsWith(".open-maintainer/") ||
    profile.generatedFilePaths.includes(path) ||
    profile.generatedFileHints.includes(path)
  );
}

function compareFindingSeverity(a: ReviewFinding, b: ReviewFinding): number {
  const severityOrder: Record<ReviewSeverity, number> = {
    blocker: 0,
    major: 1,
    minor: 2,
    note: 3,
  };
  return severityOrder[a.severity] - severityOrder[b.severity];
}

function modelMergeReadiness(
  model: ModelReviewOutput["mergeReadiness"],
): ReviewMergeReadiness {
  return {
    status:
      model.status === "conditionally_ready" ? "needs_attention" : model.status,
    reason: model.reason,
    evidence: [],
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
