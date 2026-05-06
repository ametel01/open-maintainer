import type { ModelProvider } from "@open-maintainer/ai";
import type {
  ModelProviderConfig,
  Repo,
  RepoProfile,
  ReviewCheckStatus,
  ReviewContributionTriageCategory,
  ReviewEvidenceCitation,
  ReviewExistingComment,
  ReviewFinding,
  ReviewInput,
  ReviewResult,
  ReviewSeverity,
  ReviewSkippedFile,
  ReviewValidationExpectation,
  RunRecord,
} from "@open-maintainer/shared";
import { ReviewResultSchema, nowIso } from "@open-maintainer/shared";
import { assembleLocalReviewInput } from "./local-git";
import { buildReviewEvidenceItems, generateModelBackedReview } from "./model";
import type { ReviewPromptContext as ModelReviewPromptContext } from "./model";
export { assembleLocalReviewInput } from "./local-git";
export type { LocalReviewInputOptions } from "./local-git";
export {
  buildReviewEvidenceItems,
  buildReviewPrompt,
  modelReviewOutputJsonSchema,
  parseModelReviewOutput,
} from "./model";
export type {
  ModelBackedReviewOptions,
  ModelReviewOutput,
  ReviewEvidenceItem,
  ReviewPromptContext,
} from "./model";
export { loadReviewPromptContext } from "./prompt-context";
export type {
  LoadReviewPromptContextInput,
  ReviewPromptContextSource,
} from "./prompt-context";

const severityOrder: ReviewSeverity[] = ["blocker", "major", "minor", "note"];

export type ReviewEvidencePrecheck = Pick<
  ReviewResult,
  | "walkthrough"
  | "changedSurface"
  | "riskAnalysis"
  | "expectedValidation"
  | "validationEvidence"
  | "docsImpact"
  | "residualRisk"
> & {
  contributionTriageEvidence: ContributionTriageEvidenceCandidate[];
};

export type ContributionTriageEvidenceSignal =
  | "intent_clarity"
  | "linked_issue_or_acceptance_criteria"
  | "pr_state"
  | "diff_scope"
  | "validation_evidence"
  | "docs_alignment"
  | "broad_churn"
  | "high_risk_files"
  | "generated_file_changes"
  | "lockfile_changes"
  | "dependency_changes";

export type ContributionTriageEvidenceCandidate = {
  signal: ContributionTriageEvidenceSignal;
  summary: string;
  evidence: ReviewEvidenceCitation[];
};

export type GenerateReviewOptions = {
  repoId?: string;
  profile: RepoProfile;
  input: ReviewInput;
  rules?: string[];
  providerConfig: ModelProviderConfig;
  provider: ModelProvider;
  promptContext?: ModelReviewPromptContext;
};

export type ReviewContentLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export type ReviewModelSelection =
  | {
      provider: "codex";
      model?: string;
      consent: { repositoryContentTransfer: true };
    }
  | {
      provider: "claude";
      model?: string;
      consent: { repositoryContentTransfer: true };
    };

export type ReviewPublishOptions = {
  summary?: boolean;
  inline?: false | { cap?: number };
  triageLabel?:
    | false
    | {
        apply: true;
        createMissingLabels?: boolean;
      };
};

export type ReviewPublicationIntent =
  | { mode: "publish"; options?: ReviewPublishOptions }
  | { mode: "plan"; options?: ReviewPublishOptions };

export type ReviewOutputIntent = {
  markdownPath?: string;
  json?: boolean;
  write?: "apply-only" | "always" | "never";
};

export type ReviewRepositoryRequest =
  | { kind: "local"; repoRoot: string }
  | { kind: "stored"; repoId: string }
  | {
      kind: "prepared";
      profile: RepoProfile;
      input: ReviewInput;
      repoRoot?: string;
    };

export type ReviewTargetRequest =
  | {
      kind: "diff";
      baseRef?: string;
      headRef?: string;
      prNumber?: number | null;
    }
  | {
      kind: "pullRequest";
      number: number;
      baseRef?: string;
      headRef?: string;
    };

export type ReviewModelRequest =
  | ReviewModelSelection
  | { providerId: string }
  | { providerConfig: ModelProviderConfig; provider: ModelProvider };

export type ReviewPersistenceIntent =
  | false
  | {
      run?: true;
      review?: true;
    };

export type ReviewTargetShortcut =
  | { diff?: { baseRef?: string; headRef?: string; prNumber?: number | null } }
  | { pr: number; baseRef?: string; headRef?: string };

export type ReviewOutputShortcut =
  | false
  | {
      markdownPath: string;
      write?: "apply-only" | "always" | "never";
    };

export type ReviewPublicationShortcut =
  | "plan"
  | "publish"
  | {
      mode: "plan" | "publish";
      summary?: boolean;
      inline?: false | { cap?: number };
      triageLabel?:
        | false
        | {
            apply: true;
            createMissingLabels?: boolean;
          };
    };

export type LocalReviewRequest = {
  repoRoot: string;
  model: ReviewModelSelection;
  target?: ReviewTargetShortcut;
  output?: ReviewOutputShortcut;
  publish?: false | ReviewPublicationShortcut;
  mode?: "preview" | "apply";
  limits?: Partial<ReviewContentLimits>;
};

export type StoredReviewPreviewRequest = {
  repoId: string;
  modelProviderId: string;
  target?: ReviewTargetShortcut;
  persist?: boolean;
  limits?: Partial<ReviewContentLimits>;
};

export type PreparedReviewRequest = {
  profile: RepoProfile;
  input: ReviewInput;
  repoRoot?: string | null;
  model: ReviewModelRequest;
  mode?: "preview" | "apply";
  output?: ReviewOutputShortcut;
  publish?: false | ReviewPublicationShortcut;
  persist?: ReviewPersistenceIntent;
};

export type ReviewRequest = {
  repository: ReviewRepositoryRequest;
  target?: ReviewTargetRequest;
  model: ReviewModelRequest;
  intent?: "preview" | "apply";
  output?: ReviewOutputIntent;
  publication?: false | ReviewPublicationIntent;
  persistence?: ReviewPersistenceIntent;
  limits?: Partial<ReviewContentLimits>;
};

export type PullRequestReviewRequest = {
  repoRoot: string;
  pullNumber: number;
  model: ReviewModelSelection;
  publication?: ReviewPublicationIntent;
  output?: ReviewOutputIntent;
  limits?: Partial<ReviewContentLimits>;
};

export type PullRequestReviewTarget = {
  owner: string;
  repo: string;
  pullNumber: number;
  url: string | null;
  baseSha: string | null;
  headSha: string | null;
};

export type ReviewSummaryCommentPlan = {
  action: "create" | "update";
  body: string;
  existingCommentId: number | null;
};

export type ReviewSummaryCommentResult = ReviewSummaryCommentPlan & {
  commentId: number;
  url: string | null;
};

export type ReviewInlineCommentPlan = {
  comments: Array<{
    findingId: string;
    severity: ReviewSeverity;
    path: string;
    line: number;
    body: string;
    fingerprint: string;
  }>;
  skipped: Array<{
    findingId: string;
    reason:
      | "missing_path"
      | "missing_line"
      | "unchanged_path"
      | "missing_patch"
      | "duplicate"
      | "cap_reached";
  }>;
};

export type ReviewInlineCommentResult = ReviewInlineCommentPlan & {
  reviewId: number | null;
  url: string | null;
};

export type ReviewTriageLabelPlan = {
  label: string;
  apply: boolean;
  createMissingLabels: boolean;
  labelsToCreate: string[];
  labelsToRemove: string[];
};

export type ReviewTriageLabelResult = ReviewTriageLabelPlan & {
  applied: boolean;
  created: number;
  removed: string[];
};

export type ReviewPublicationPlan = {
  summary: ReviewSummaryCommentPlan | null;
  inline: ReviewInlineCommentPlan | null;
  triageLabel: ReviewTriageLabelPlan | null;
};

export type ReviewPublicationResult = {
  summary: ReviewSummaryCommentResult | null;
  inline: ReviewInlineCommentResult | null;
  triageLabel: ReviewTriageLabelResult | null;
};

export type ReviewPublicationInput = {
  review: ReviewResult;
  markdown: string;
  target: PullRequestReviewTarget;
  reviewInput: ReviewInput;
  options: RequiredReviewPublishOptions;
};

export type PullRequestReviewRun = {
  review: ReviewResult;
  markdown: string;
  target: PullRequestReviewTarget;
  output: ReviewOutputResult | null;
  publication:
    | { mode: "skipped" }
    | ({ mode: "planned" } & ReviewPublicationPlan)
    | ({ mode: "published" } & ReviewPublicationResult);
  diagnostics: {
    promptContextPaths: string[];
    skippedFiles: ReviewSkippedFile[];
    changedFileCount: number;
  };
};

export type ReviewOutputResult = {
  markdownPath: string;
  written: boolean;
};

export type ReviewPreparedSource = {
  profile: RepoProfile;
  input: ReviewInput;
  repoRoot: string | null;
  adapter?: string;
  warnings?: string[];
  sourceFallbacks?: string[];
};

export type PreparedReviewCase = {
  source: {
    profile: RepoProfile;
    input: ReviewInput;
    repoRoot: string | null;
  };
  target: PullRequestReviewTarget | null;
  promptContext: {
    context: ModelReviewPromptContext;
    paths: string[];
  };
  precheck: ReviewEvidencePrecheck;
  evidence: {
    version: 1;
    items: ReturnType<typeof buildReviewEvidenceItems>;
  };
  provenance: {
    sourceKind: ReviewPipelineRequest["source"]["kind"];
    collectedAt: string;
    adapter: string;
  };
  diagnostics: {
    changedFileCount: number;
    skippedFiles: ReviewSkippedFile[];
    promptContextPaths: string[];
    warnings: string[];
    sourceFallbacks: string[];
  };
};

export type ReviewRun = {
  review: ReviewResult;
  markdown: string;
  source: {
    profile: RepoProfile;
    input: ReviewInput;
    repoRoot: string | null;
  };
  output: ReviewOutputResult | null;
  publication: PullRequestReviewRun["publication"];
  persistence: {
    run: RunRecord | null;
    reviewStored: boolean;
  };
  diagnostics: {
    promptContextPaths: string[];
    skippedFiles: ReviewSkippedFile[];
    changedFileCount: number;
  };
};

export type ReviewSourcePort = {
  prepareLocal(input: {
    repoRoot: string;
    target?: ReviewTargetRequest;
    limits?: Partial<ReviewContentLimits>;
  }): Promise<ReviewPreparedSource>;
  prepareStored?(input: {
    repoId: string;
    target?: ReviewTargetRequest;
    limits?: Partial<ReviewContentLimits>;
  }): Promise<ReviewPreparedSource>;
};

export type ReviewPromptContextPort = {
  load(input: {
    repoRoot: string | null;
    profile: RepoProfile;
    reviewInput: ReviewInput;
  }): Promise<{
    context: ModelReviewPromptContext;
    paths: string[];
  }>;
};

export type ReviewModelProviderPort = {
  resolve(input: {
    model: ReviewModelRequest;
    repoRoot: string | null;
    profile: RepoProfile;
    reviewInput: ReviewInput;
  }):
    | Promise<{
        providerConfig: ModelProviderConfig;
        provider: ModelProvider;
      }>
    | {
        providerConfig: ModelProviderConfig;
        provider: ModelProvider;
      };
};

export type ReviewPersistencePort = {
  startRun(input: {
    request: ReviewRequest;
    source: ReviewPreparedSource;
  }): Promise<RunRecord>;
  succeedRun(input: {
    run: RunRecord;
    review: ReviewResult;
    source: ReviewPreparedSource;
  }): Promise<RunRecord>;
  failRun(input: {
    run: RunRecord;
    error: unknown;
    source: ReviewPreparedSource;
  }): Promise<RunRecord>;
  storeReview(input: { review: ReviewResult }): Promise<void>;
};

export type ReviewOrchestratorDeps = {
  sources: ReviewSourcePort;
  promptContext?: ReviewPromptContextPort;
  modelProviders: ReviewModelProviderPort;
  publisher?: PullRequestReviewWorkflowDeps["publisher"];
  output?: PullRequestReviewWorkflowDeps["output"];
  persistence?: ReviewPersistencePort;
};

/** @deprecated Use ReviewOperation. */
export type ReviewOrchestrator = {
  review(request: ReviewRequest): Promise<ReviewRun>;
};

export type LocalDiffInput = {
  repoRoot: string;
  profile: RepoProfile;
  baseRef: string;
  headRef: string;
  limits?: Partial<ReviewContentLimits>;
};

export type LocalPullRequestInput = {
  repoRoot: string;
  profile: RepoProfile;
  prNumber: number;
  baseRef?: string;
  headRef?: string;
  limits?: Partial<ReviewContentLimits>;
};

export type ReviewPullRequestMetadata = {
  number: number;
  owner?: string;
  repo?: string;
  title?: string | null;
  body?: string;
  url?: string | null;
  author?: string | null;
  isDraft?: boolean | null;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  reviewDecision?: string | null;
  baseRef: string;
  headRef?: string;
  baseSha?: string | null;
  headSha?: string | null;
  checkStatuses?: ReviewCheckStatus[];
  existingComments?: ReviewExistingComment[];
};

export type NormalizedReviewTarget = ReviewTargetRequest;

export type LocalReviewEnvironment = {
  prepareProfile(input: { repoRoot: string }): Promise<RepoProfile>;
  detectDefaultBranch(input: { repoRoot: string }): Promise<string | null>;
  assembleDiff(input: LocalDiffInput): Promise<ReviewInput>;
  fetchPullRequest?(input: LocalPullRequestInput): Promise<ReviewInput>;
  fetchPullRequestMetadata?(input: {
    repoRoot: string;
    profile: RepoProfile;
    prNumber: number;
    baseRef?: string;
    headRef?: string;
  }): Promise<ReviewPullRequestMetadata>;
};

export type StoredReviewEnvironment = {
  prepareReview(input: {
    repoId: string;
    target?: NormalizedReviewTarget;
    limits: ReviewContentLimits;
  }): Promise<ReviewPreparedSource>;
};

export type ReviewRepositorySourceWorkspace = {
  repo: Repo;
  profile: RepoProfile;
  worktreeRoot: string | null;
};

export type ReviewRepositorySourcePreparationResult =
  | {
      ok: true;
      value: ReviewRepositorySourceWorkspace;
    }
  | {
      ok: false;
      error: {
        statusCode: 404 | 409 | 422;
        message: string;
      };
    };

export type ReviewRepositorySourceLifecyclePort = {
  prepare(input: {
    repoId: string;
    intent: {
      kind: "review-preview";
      baseRef?: string;
      headRef?: string;
      prNumber?: number;
    };
  }): Promise<ReviewRepositorySourcePreparationResult>;
};

export type StoredReviewSourceAdapterInput = {
  repo: Repo;
  repositorySources: ReviewRepositorySourceLifecyclePort;
  pullRequestContext?: {
    fetch(input: {
      repoId: string;
      repo: Repo;
      prNumber: number;
    }): Promise<ReviewInput | null>;
  };
  localPullRequestMetadata?: {
    fetch(input: {
      worktreeRoot: string;
      repo: Repo;
      prNumber: number;
    }): Promise<ReviewPullRequestMetadata>;
  };
  localDiff?: {
    assemble(input: LocalDiffInput): Promise<ReviewInput>;
  };
};

export type ReviewModelResolver = {
  resolve(input: {
    model: ReviewModelRequest;
    source: ReviewPreparedSource;
  }):
    | Promise<{ providerConfig: ModelProviderConfig; provider: ModelProvider }>
    | { providerConfig: ModelProviderConfig; provider: ModelProvider };
};

export type ReviewPromptContextResolver = {
  resolve(input: { source: ReviewPreparedSource }): Promise<{
    context: ModelReviewPromptContext;
    paths: string[];
  }>;
};

export type ReviewPublisherPort = NonNullable<
  PullRequestReviewWorkflowDeps["publisher"]
>;

export type ReviewOutputPort = NonNullable<
  PullRequestReviewWorkflowDeps["output"]
>;

export type ReviewErrorMapper = {
  map(error: unknown): Error;
};

export type ReviewWorkflowDeps = {
  local?: LocalReviewEnvironment;
  stored?: StoredReviewEnvironment;
  modelProviders: ReviewModelResolver;
  promptContext?: ReviewPromptContextResolver;
  publisher?: ReviewPublisherPort;
  output?: ReviewOutputPort;
  persistence?: ReviewPersistencePort;
  errors?: ReviewErrorMapper;
};

export type ReviewOperationDeps = ReviewOrchestratorDeps & {
  errors?: ReviewErrorMapper;
};

/** @deprecated Use ReviewOperation. */
export type ReviewWorkflow = {
  reviewLocal(input: LocalReviewRequest): Promise<ReviewRun>;
  previewStored(input: StoredReviewPreviewRequest): Promise<ReviewRun>;
  reviewPrepared(input: PreparedReviewRequest): Promise<ReviewRun>;
};

export type RepositoryContentConsent = {
  repositoryContentTransfer: true;
  grantedAt: string;
  grantedBy: "cli-flag" | "dashboard-provider" | "github-action-input";
};

export type ReviewOperationModelRequest =
  | {
      kind: "cli";
      provider: ReviewModelSelection["provider"];
      model?: string | null;
      consent: RepositoryContentConsent;
    }
  | {
      kind: "stored-provider";
      providerId: string;
      consent: RepositoryContentConsent;
    }
  | {
      kind: "resolved";
      providerConfig: ModelProviderConfig;
      provider: ModelProvider;
      consent: RepositoryContentConsent;
    };

export type ReviewPipelineSource =
  | { kind: "local"; repoRoot: string }
  | { kind: "stored"; repoId: string }
  | {
      kind: "prepared";
      profile: RepoProfile;
      input: ReviewInput;
      repoRoot?: string | null;
    };

export type ReviewPipelineEffects = {
  output?: ReviewOutputIntent;
  publication?: false | ReviewOperationPublicationRequest;
  persistence?: ReviewPersistenceIntent;
};

export type ReviewPipelineRequest = {
  source: ReviewPipelineSource;
  target?: ReviewTargetRequest;
  model: ReviewOperationModelRequest;
  mode: "preview" | "apply";
  effects?: ReviewPipelineEffects;
  limits?: Partial<ReviewContentLimits>;
};

export type ReviewCasePreparationRequest = ReviewPipelineRequest;

export type ReviewPipelineResult = ReviewOperationResult;

export type ReviewPipeline = {
  review(request: ReviewPipelineRequest): Promise<ReviewPipelineResult>;
  prepareCase(
    request: ReviewCasePreparationRequest,
  ): Promise<PreparedReviewCase>;
};

export type ReviewOperationTarget = ReviewTargetRequest;

export type ReviewOperationPublicationRequest = {
  mode: "plan" | "publish";
  summary?: boolean;
  inline?: false | { cap?: number };
  triageLabel?:
    | false
    | {
        apply: true;
        createMissingLabels?: boolean;
      };
};

export type ReviewOperationRequest = {
  source:
    | {
        kind: "local";
        repoRoot: string;
        target?: ReviewOperationTarget;
      }
    | {
        kind: "stored";
        repoId: string;
        target?: ReviewOperationTarget;
      }
    | {
        kind: "prepared";
        profile: RepoProfile;
        input: ReviewInput;
        repoRoot?: string | null;
      };
  model: ReviewOperationModelRequest;
  mode: "preview" | "apply";
  output?: ReviewOutputIntent;
  publish?: false | ReviewOperationPublicationRequest;
  persist?: ReviewPersistenceIntent;
  limits?: Partial<ReviewContentLimits>;
};

export type ReviewOperationPhase =
  | "consent"
  | "source"
  | "prompt-context"
  | "model"
  | "output"
  | "publication"
  | "persistence";

export type ReviewOperationResult =
  | {
      ok: true;
      run: ReviewRun;
    }
  | {
      ok: false;
      error: Error;
      phase: ReviewOperationPhase;
      run: RunRecord | null;
      statusCode?: 403 | 409 | 422;
    };

export type LocalReviewShortcut = {
  repoRoot: string;
  model: Extract<ReviewOperationModelRequest, { kind: "cli" }>;
  baseRef?: string;
  headRef?: string;
  limits?: Partial<ReviewContentLimits>;
};

export type PullRequestReviewShortcut = {
  repoRoot: string;
  prNumber: number;
  model: Extract<ReviewOperationModelRequest, { kind: "cli" }>;
  limits?: Partial<ReviewContentLimits>;
};

export type ReviewOperation = {
  run(request: ReviewOperationRequest): Promise<ReviewOperationResult>;
  previewLocalDiff(input: LocalReviewShortcut): Promise<ReviewOperationResult>;
  previewPullRequest(
    input: PullRequestReviewShortcut,
  ): Promise<ReviewOperationResult>;
  publishPullRequest(
    input: PullRequestReviewShortcut & {
      publish?: Omit<ReviewOperationPublicationRequest, "mode">;
    },
  ): Promise<ReviewOperationResult>;
};

export function createCliReviewOperationModelRequest(input: {
  provider: ReviewModelSelection["provider"];
  model?: string | null;
  consent: { repositoryContentTransfer: true };
  grantedAt?: string;
  grantedBy?: RepositoryContentConsent["grantedBy"];
}): Extract<ReviewOperationModelRequest, { kind: "cli" }> {
  return {
    kind: "cli",
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
    consent: {
      repositoryContentTransfer: input.consent.repositoryContentTransfer,
      grantedBy: input.grantedBy ?? "cli-flag",
      grantedAt: input.grantedAt ?? nowIso(),
    },
  };
}

export function createStoredProviderReviewOperationModelRequest(input: {
  providerId: string;
  consent: RepositoryContentConsent;
}): Extract<ReviewOperationModelRequest, { kind: "stored-provider" }> {
  return {
    kind: "stored-provider",
    providerId: input.providerId,
    consent: input.consent,
  };
}

export function reviewOperationTargetFromShortcut(
  target: ReviewTargetShortcut | undefined,
): ReviewOperationTarget | undefined {
  return target ? normalizeReviewTargetShortcut(target) : undefined;
}

export function reviewOperationOutputFromShortcut(
  output: ReviewOutputShortcut | undefined,
): ReviewOutputIntent | undefined {
  return normalizeOutputShortcut(output);
}

export function reviewOperationPublicationFromShortcut(
  publication: false | ReviewPublicationShortcut | undefined,
): false | ReviewOperationPublicationRequest | undefined {
  if (publication === undefined || publication === false) {
    return publication;
  }
  if (publication === "plan" || publication === "publish") {
    return { mode: publication };
  }
  return {
    mode: publication.mode,
    ...(publication.summary !== undefined
      ? { summary: publication.summary }
      : {}),
    ...(publication.inline !== undefined ? { inline: publication.inline } : {}),
    ...(publication.triageLabel !== undefined
      ? { triageLabel: publication.triageLabel }
      : {}),
  };
}

export class ReviewOrchestratorError extends Error {
  run: RunRecord | null;

  constructor(
    message: string,
    run: RunRecord | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ReviewOrchestratorError";
    this.run = run;
  }
}

/** @deprecated Use ReviewOperation. */
export type PullRequestReviewWorkflow = {
  reviewPullRequest(
    request: PullRequestReviewRequest,
  ): Promise<PullRequestReviewRun>;
};

export type PullRequestReviewWorkflowDeps = {
  repoProfile: {
    load(repoRoot: string): Promise<RepoProfile>;
  };
  pullRequests: {
    fetchReviewInput(input: {
      repoId: string;
      owner: string;
      repo: string;
      pullNumber: number;
      limits?: Partial<ReviewContentLimits>;
    }): Promise<ReviewInput>;
  };
  promptContext: {
    load(input: {
      repoRoot: string;
      profile: RepoProfile;
    }): Promise<{
      context: ModelReviewPromptContext;
      paths: string[];
    }>;
  };
  modelProviders: {
    create(input: ReviewModelSelection & { repoRoot: string }): {
      providerConfig: ModelProviderConfig;
      provider: ModelProvider;
    };
  };
  publisher: {
    plan(input: ReviewPublicationInput): Promise<ReviewPublicationPlan>;
    publish(input: ReviewPublicationInput): Promise<ReviewPublicationResult>;
  };
  output?: {
    writeMarkdown(input: {
      repoRoot: string;
      path: string;
      markdown: string;
    }): Promise<void>;
  };
};

export type RequiredReviewPublishOptions = {
  summary: boolean;
  inline: false | { cap: number };
  triageLabel:
    | false
    | {
        apply: true;
        createMissingLabels: boolean;
      };
};

export const reviewTriageLabelDefinitions: Record<
  ReviewContributionTriageCategory,
  { name: string; color: string; description: string }
> = {
  ready_for_review: {
    name: "open-maintainer/ready-for-review",
    color: "2da44e",
    description: "Open Maintainer: PR appears ready for human review.",
  },
  needs_author_input: {
    name: "open-maintainer/needs-author-input",
    color: "d29922",
    description: "Open Maintainer: PR needs author information before review.",
  },
  needs_maintainer_design: {
    name: "open-maintainer/needs-maintainer-design",
    color: "8250df",
    description: "Open Maintainer: PR needs maintainer design judgment.",
  },
  not_agent_ready: {
    name: "open-maintainer/not-agent-ready",
    color: "bf8700",
    description: "Open Maintainer: PR is not ready for agent-assisted review.",
  },
  possible_spam: {
    name: "open-maintainer/possible-spam",
    color: "cf222e",
    description: "Open Maintainer: PR may be spam-like contribution noise.",
  },
};

export const reviewTriageLabelNames = new Set(
  Object.values(reviewTriageLabelDefinitions).map((label) => label.name),
);

const defaultReviewContentLimits: ReviewContentLimits = {
  maxFiles: 800,
  maxFileBytes: 128_000,
  maxTotalBytes: 512_000,
};

export class ReviewWorkflowSourceError extends Error {
  statusCode: 409 | 422;

  constructor(statusCode: 409 | 422, message: string) {
    super(message);
    this.name = "ReviewWorkflowSourceError";
    this.statusCode = statusCode;
  }
}

/** @deprecated Use createReviewOperation with createReviewOperationDeps. */
export function createReviewWorkflow(deps: ReviewWorkflowDeps): ReviewWorkflow {
  const orchestrator = createReviewOrchestrator(
    createReviewOperationDeps(deps),
  );

  return {
    reviewLocal(input) {
      const publication = normalizePublicationShortcut(input.publish);
      const output = normalizeOutputShortcut(input.output);
      return runWorkflowRequest(deps, () =>
        orchestrator.review({
          repository: { kind: "local", repoRoot: input.repoRoot },
          ...(input.target
            ? { target: normalizeReviewTargetShortcut(input.target) }
            : {}),
          model: input.model,
          intent: input.mode ?? intentForPublication(publication),
          ...(output ? { output } : {}),
          ...(publication !== undefined ? { publication } : {}),
          ...(input.limits ? { limits: input.limits } : {}),
        }),
      );
    },
    previewStored(input) {
      return runWorkflowRequest(deps, () =>
        orchestrator.review({
          repository: { kind: "stored", repoId: input.repoId },
          ...(input.target
            ? { target: normalizeReviewTargetShortcut(input.target) }
            : {}),
          model: { providerId: input.modelProviderId },
          intent: "preview",
          publication: false,
          persistence:
            input.persist === false ? false : { run: true, review: true },
          ...(input.limits ? { limits: input.limits } : {}),
        }),
      );
    },
    reviewPrepared(input) {
      const publication = normalizePublicationShortcut(input.publish);
      const output = normalizeOutputShortcut(input.output);
      return runWorkflowRequest(deps, () =>
        orchestrator.review({
          repository: {
            kind: "prepared",
            profile: input.profile,
            input: input.input,
            ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
          },
          model: input.model,
          intent: input.mode ?? intentForPublication(publication),
          ...(output ? { output } : {}),
          ...(publication !== undefined ? { publication } : {}),
          ...(input.persist !== undefined
            ? { persistence: input.persist }
            : {}),
        }),
      );
    },
  };
}

export function createReviewPipeline(
  deps: ReviewOperationDeps,
): ReviewPipeline {
  const phasedDeps = withReviewOperationPhases(deps);

  const prepareCase = async (
    request: ReviewCasePreparationRequest,
  ): Promise<PreparedReviewCase> => {
    assertOperationRepositoryContentConsent(request.model);
    const source = await preparePipelineReviewSource(
      phasedDeps.sources,
      request,
    );
    return buildPreparedReviewCase(phasedDeps, request, source);
  };

  const review = async (
    request: ReviewPipelineRequest,
  ): Promise<ReviewPipelineResult> => {
    let source: ReviewPreparedSource | null = null;
    let activeRun: RunRecord | null = null;
    try {
      assertOperationRepositoryContentConsent(request.model);
      source = await preparePipelineReviewSource(phasedDeps.sources, request);
      const persistence = request.effects?.persistence;
      if (shouldPersistRun(persistence)) {
        if (!phasedDeps.persistence) {
          throw new Error(
            "Review run persistence requires a persistence port.",
          );
        }
        activeRun = await phasedDeps.persistence.startRun({
          request: reviewRequestFromPipelineRequest(request),
          source,
        });
      }
      try {
        const preparedCase = await buildPreparedReviewCase(
          phasedDeps,
          request,
          source,
        );
        const providerReview = await phasedDeps.modelProviders.resolve({
          model: modelRequestForOperation(request.model),
          repoRoot: source.repoRoot,
          profile: source.profile,
          reviewInput: source.input,
        });
        const review = await generateReview({
          profile: source.profile,
          input: source.input,
          rules: source.profile.reviewRuleCandidates,
          providerConfig: providerReview.providerConfig,
          provider: providerReview.provider,
          ...(Object.keys(preparedCase.promptContext.context).length > 0
            ? { promptContext: preparedCase.promptContext.context }
            : {}),
        });
        const markdown = renderReviewMarkdown(review);
        const publicationIntent = reviewPublicationIntentForPipeline(
          request.effects?.publication,
        );
        const output = await runReviewOutput({
          intent: request.effects?.output,
          reviewIntent: request.mode,
          publicationIntent,
          deps: phasedDeps,
          repoRoot: source.repoRoot,
          markdown,
        });
        const publication = await runReviewPublication({
          intent: publicationIntent,
          deps: phasedDeps,
          review,
          markdown,
          target: publicationIntent ? preparedCase.target : null,
          reviewInput: source.input,
        });
        let reviewStored = false;
        if (shouldPersistReview(persistence)) {
          if (!phasedDeps.persistence) {
            throw new Error("Review storage requires a persistence port.");
          }
          await phasedDeps.persistence.storeReview({ review });
          reviewStored = true;
        }
        if (activeRun && phasedDeps.persistence) {
          activeRun = await phasedDeps.persistence.succeedRun({
            run: activeRun,
            review,
            source,
          });
        }
        return {
          ok: true,
          run: {
            review,
            markdown,
            source: preparedCase.source,
            output,
            publication,
            persistence: { run: activeRun, reviewStored },
            diagnostics: {
              promptContextPaths: preparedCase.diagnostics.promptContextPaths,
              skippedFiles: preparedCase.diagnostics.skippedFiles,
              changedFileCount: preparedCase.diagnostics.changedFileCount,
            },
          },
        };
      } catch (error) {
        if (activeRun && phasedDeps.persistence && source) {
          const failedRun = await phasedDeps.persistence.failRun({
            run: activeRun,
            error,
            source,
          });
          throw new ReviewOrchestratorError(errorMessage(error), failedRun, {
            cause: error,
          });
        }
        throw error;
      }
    } catch (error) {
      const mapped = deps.errors ? deps.errors.map(error) : error;
      return reviewOperationFailure(mapped);
    }
  };

  return { review, prepareCase };
}

export function createReviewOperation(
  deps: ReviewOperationDeps,
): ReviewOperation {
  const pipeline = createReviewPipeline(deps);

  const run = (
    request: ReviewOperationRequest,
  ): Promise<ReviewOperationResult> =>
    pipeline.review(reviewPipelineRequestFromOperation(request));

  return {
    run,
    previewLocalDiff(input) {
      return run({
        source: {
          kind: "local",
          repoRoot: input.repoRoot,
          target: {
            kind: "diff",
            ...(input.baseRef ? { baseRef: input.baseRef } : {}),
            ...(input.headRef ? { headRef: input.headRef } : {}),
          },
        },
        model: input.model,
        mode: "preview",
        publish: false,
        ...(input.limits ? { limits: input.limits } : {}),
      });
    },
    previewPullRequest(input) {
      return run({
        source: {
          kind: "local",
          repoRoot: input.repoRoot,
          target: { kind: "pullRequest", number: input.prNumber },
        },
        model: input.model,
        mode: "preview",
        publish: false,
        ...(input.limits ? { limits: input.limits } : {}),
      });
    },
    publishPullRequest(input) {
      return run({
        source: {
          kind: "local",
          repoRoot: input.repoRoot,
          target: { kind: "pullRequest", number: input.prNumber },
        },
        model: input.model,
        mode: "apply",
        publish: { mode: "publish", ...(input.publish ?? {}) },
        ...(input.limits ? { limits: input.limits } : {}),
      });
    },
  };
}

async function preparePipelineReviewSource(
  sources: ReviewSourcePort,
  request: ReviewPipelineRequest,
): Promise<ReviewPreparedSource> {
  const source = await prepareReviewSource(
    sources,
    reviewRequestFromPipelineRequest(request),
  );
  assertNonEmptyReviewSource(source);
  return source;
}

async function buildPreparedReviewCase(
  deps: Pick<ReviewOperationDeps, "promptContext">,
  request: ReviewPipelineRequest,
  source: ReviewPreparedSource,
): Promise<PreparedReviewCase> {
  const promptContext = deps.promptContext
    ? await deps.promptContext.load({
        repoRoot: source.repoRoot,
        profile: source.profile,
        reviewInput: source.input,
      })
    : { context: {}, paths: [] };
  const precheck = buildReviewEvidencePrecheck({
    profile: source.profile,
    input: source.input,
    rules: source.profile.reviewRuleCandidates,
  });
  return {
    source: {
      profile: source.profile,
      input: source.input,
      repoRoot: source.repoRoot,
    },
    target: reviewTargetFromCaseInput(source.input),
    promptContext,
    precheck,
    evidence: {
      version: 1,
      items: buildReviewEvidenceItems({
        profile: source.profile,
        input: source.input,
        rules: source.profile.reviewRuleCandidates,
        precheck,
        ...(Object.keys(promptContext.context).length > 0
          ? { promptContext: promptContext.context }
          : {}),
      }),
    },
    provenance: {
      sourceKind: request.source.kind,
      collectedAt: nowIso(),
      adapter: source.adapter ?? request.source.kind,
    },
    diagnostics: {
      changedFileCount: source.input.changedFiles.length,
      skippedFiles: source.input.skippedFiles,
      promptContextPaths: promptContext.paths,
      warnings: source.warnings ?? [],
      sourceFallbacks: source.sourceFallbacks ?? [],
    },
  };
}

function reviewTargetFromCaseInput(
  input: ReviewInput,
): PullRequestReviewTarget | null {
  return input.prNumber ? reviewTargetFromInput(input) : null;
}

function reviewPipelineRequestFromOperation(
  request: ReviewOperationRequest,
): ReviewPipelineRequest {
  const effects: ReviewPipelineEffects = {};
  if (request.output) {
    effects.output = request.output;
  }
  if (request.publish !== undefined) {
    effects.publication = request.publish;
  }
  if (request.persist !== undefined) {
    effects.persistence = request.persist;
  }
  const source = reviewPipelineSourceFromOperation(request.source);
  const target =
    request.source.kind === "prepared" ? undefined : request.source.target;
  return {
    source,
    ...(target ? { target } : {}),
    model: request.model,
    mode: request.mode,
    ...(Object.keys(effects).length > 0 ? { effects } : {}),
    ...(request.limits ? { limits: request.limits } : {}),
  };
}

function reviewPipelineSourceFromOperation(
  source: ReviewOperationRequest["source"],
): ReviewPipelineSource {
  if (source.kind === "prepared") {
    return {
      kind: "prepared",
      profile: source.profile,
      input: source.input,
      ...(source.repoRoot ? { repoRoot: source.repoRoot } : {}),
    };
  }
  if (source.kind === "stored") {
    return { kind: "stored", repoId: source.repoId };
  }
  return { kind: "local", repoRoot: source.repoRoot };
}

function reviewRequestFromPipelineRequest(
  request: ReviewPipelineRequest,
): ReviewRequest {
  const reviewRequest: ReviewRequest = {
    repository: reviewRepositoryRequestFromPipelineSource(request.source),
    model: modelRequestForOperation(request.model),
    intent: request.mode,
  };
  if (request.target) {
    reviewRequest.target = request.target;
  }
  if (request.effects?.output) {
    reviewRequest.output = request.effects.output;
  }
  if (request.effects?.publication !== undefined) {
    reviewRequest.publication =
      request.effects.publication === false
        ? false
        : reviewPublicationIntentForOperation(request.effects.publication);
  }
  if (request.effects?.persistence !== undefined) {
    reviewRequest.persistence = request.effects.persistence;
  }
  if (request.limits) {
    reviewRequest.limits = request.limits;
  }
  return reviewRequest;
}

function reviewRepositoryRequestFromPipelineSource(
  source: ReviewPipelineSource,
): ReviewRepositoryRequest {
  if (source.kind === "prepared") {
    return {
      kind: "prepared",
      profile: source.profile,
      input: source.input,
      ...(source.repoRoot ? { repoRoot: source.repoRoot } : {}),
    };
  }
  if (source.kind === "stored") {
    return { kind: "stored", repoId: source.repoId };
  }
  return { kind: "local", repoRoot: source.repoRoot };
}

function reviewPublicationIntentForPipeline(
  publication: false | ReviewOperationPublicationRequest | undefined,
): ReviewRequest["publication"] {
  if (publication === undefined || publication === false) {
    return publication;
  }
  return reviewPublicationIntentForOperation(publication);
}

export function createReviewOperationDeps(
  deps: ReviewWorkflowDeps,
): ReviewOperationDeps {
  return {
    sources: {
      async prepareLocal(input) {
        if (!deps.local) {
          throw new Error("Local review requires a local environment port.");
        }
        const source = await prepareLocalWorkflowSource(deps.local, input);
        assertNonEmptyReviewSource(source);
        return source;
      },
      async prepareStored(input) {
        if (!deps.stored) {
          throw new Error("Stored review requires a stored environment port.");
        }
        const source = await deps.stored.prepareReview({
          repoId: input.repoId,
          ...(input.target ? { target: input.target } : {}),
          limits: normalizeReviewContentLimits(input.limits),
        });
        assertNonEmptyReviewSource(source);
        return source;
      },
    },
    ...(deps.promptContext
      ? {
          promptContext: {
            async load(input) {
              return (
                deps.promptContext?.resolve({
                  source: {
                    profile: input.profile,
                    input: input.reviewInput,
                    repoRoot: input.repoRoot,
                  },
                }) ?? { context: {}, paths: [] }
              );
            },
          },
        }
      : {}),
    modelProviders: {
      resolve(input) {
        return deps.modelProviders.resolve({
          model: input.model,
          source: {
            profile: input.profile,
            input: input.reviewInput,
            repoRoot: input.repoRoot,
          },
        });
      },
    },
    ...(deps.publisher ? { publisher: deps.publisher } : {}),
    ...(deps.output ? { output: deps.output } : {}),
    ...(deps.persistence ? { persistence: deps.persistence } : {}),
    ...(deps.errors ? { errors: deps.errors } : {}),
  };
}

export function createStoredReviewSourceEnvironment(
  input: StoredReviewSourceAdapterInput,
): StoredReviewEnvironment {
  return {
    prepareReview(request) {
      return prepareStoredReviewSource(input, request);
    },
  };
}

async function prepareStoredReviewSource(
  adapter: StoredReviewSourceAdapterInput,
  request: {
    repoId: string;
    target?: NormalizedReviewTarget;
    limits: ReviewContentLimits;
  },
): Promise<ReviewPreparedSource> {
  const prNumber =
    request.target?.kind === "pullRequest" ? request.target.number : undefined;
  if (prNumber && adapter.pullRequestContext) {
    const githubReviewInput = await adapter.pullRequestContext.fetch({
      repoId: request.repoId,
      repo: adapter.repo,
      prNumber,
    });
    if (githubReviewInput) {
      if (githubReviewInput.changedFiles.length === 0) {
        throw new ReviewWorkflowSourceError(
          422,
          `No changed files were detected for PR #${prNumber}. Check the pull request before creating a review preview.`,
        );
      }
      const workspace = await prepareStoredReviewWorkspace(adapter, {
        repoId: request.repoId,
        intent: {
          kind: "review-preview",
          baseRef: githubReviewInput.baseRef,
          prNumber,
        },
      });
      return {
        profile: workspace.profile,
        input: githubReviewInput,
        repoRoot: workspace.worktreeRoot,
        adapter: "github-app-pull-request",
      };
    }
  }

  const workspace = await prepareStoredReviewWorkspace(adapter, {
    repoId: request.repoId,
    intent: storedReviewWorkspaceIntent(request.target),
  });
  const worktreeRoot = workspace.worktreeRoot;
  if (!worktreeRoot) {
    throw new ReviewWorkflowSourceError(
      409,
      prNumber
        ? "PR number review requires GitHub App credentials or a registered local repository worktree with gh available."
        : "Review preview requires a registered local repository worktree in this release.",
    );
  }

  const sourceFallbacks: string[] = [];
  let metadata: ReviewPullRequestMetadata | null = null;
  let metadataError: string | null = null;
  if (prNumber && adapter.localPullRequestMetadata) {
    try {
      metadata = await adapter.localPullRequestMetadata.fetch({
        worktreeRoot,
        repo: adapter.repo,
        prNumber,
      });
      if (adapter.pullRequestContext) {
        sourceFallbacks.push("github-app-pr-context-unavailable");
      }
    } catch (error) {
      metadataError =
        error instanceof Error ? error.message : "Unable to resolve PR refs.";
    }
  }
  if (prNumber && !request.target?.baseRef && !metadata) {
    throw new ReviewWorkflowSourceError(
      422,
      `Unable to resolve the base ref for PR #${prNumber}. Enter a base ref manually or authenticate gh in the API environment. ${metadataError ?? ""}`.trim(),
    );
  }

  const baseRef = request.target?.baseRef ?? metadata?.baseRef;
  const headRef = request.target?.headRef ?? metadata?.headRef ?? "HEAD";
  const effectiveBaseRef = baseRef ?? adapter.repo.defaultBranch;
  const localInput = adapter.localDiff
    ? await adapter.localDiff.assemble({
        repoRoot: worktreeRoot,
        profile: workspace.profile,
        baseRef: effectiveBaseRef,
        headRef,
        limits: request.limits,
      })
    : await assembleLocalReviewInput({
        repoRoot: worktreeRoot,
        repoId: request.repoId,
        baseRef: effectiveBaseRef,
        headRef,
        ...request.limits,
      });
  if (localInput.changedFiles.length === 0) {
    throw new ReviewWorkflowSourceError(
      422,
      `No changed files were detected for ${effectiveBaseRef}...${headRef}. Check the base/head refs before creating a review preview.`,
    );
  }

  return {
    profile: workspace.profile,
    input: {
      ...localInput,
      owner: adapter.repo.owner,
      repo: adapter.repo.name,
      prNumber: prNumber ?? null,
      title: metadata?.title ?? localInput.title,
      body: metadata?.body ?? localInput.body,
      url: metadata?.url ?? localInput.url,
      author: metadata?.author ?? localInput.author,
      isDraft: metadata?.isDraft ?? localInput.isDraft,
      mergeable: metadata?.mergeable ?? localInput.mergeable,
      mergeStateStatus:
        metadata?.mergeStateStatus ?? localInput.mergeStateStatus,
      reviewDecision: metadata?.reviewDecision ?? localInput.reviewDecision,
      baseSha: metadata?.baseSha ?? localInput.baseSha,
      headSha: metadata?.headSha ?? localInput.headSha,
      checkStatuses: metadata?.checkStatuses ?? localInput.checkStatuses,
      existingComments:
        metadata?.existingComments ?? localInput.existingComments,
    },
    repoRoot: worktreeRoot,
    adapter: metadata
      ? "stored-local-pull-request-metadata"
      : "stored-local-diff",
    sourceFallbacks,
  };
}

async function prepareStoredReviewWorkspace(
  adapter: StoredReviewSourceAdapterInput,
  input: {
    repoId: string;
    intent: Parameters<
      ReviewRepositorySourceLifecyclePort["prepare"]
    >[0]["intent"];
  },
): Promise<ReviewRepositorySourceWorkspace> {
  const workspace = await adapter.repositorySources.prepare(input);
  if (!workspace.ok) {
    throw new ReviewWorkflowSourceError(
      workspace.error.statusCode === 404 ? 409 : workspace.error.statusCode,
      workspace.error.message,
    );
  }
  return workspace.value;
}

function storedReviewWorkspaceIntent(
  target: NormalizedReviewTarget | undefined,
): Parameters<ReviewRepositorySourceLifecyclePort["prepare"]>[0]["intent"] {
  if (target?.kind === "pullRequest") {
    return {
      kind: "review-preview",
      ...(target.baseRef ? { baseRef: target.baseRef } : {}),
      ...(target.headRef ? { headRef: target.headRef } : {}),
      prNumber: target.number,
    };
  }
  return {
    kind: "review-preview",
    ...(target?.baseRef ? { baseRef: target.baseRef } : {}),
    ...(target?.headRef ? { headRef: target.headRef } : {}),
    ...(target?.prNumber ? { prNumber: target.prNumber } : {}),
  };
}

function cliModelSelectionForOperation(
  model: ReviewOperationModelRequest,
): ReviewModelSelection {
  if (model.kind !== "cli") {
    throw new Error("Local review operations require a CLI model selection.");
  }
  return {
    provider: model.provider,
    ...(model.model ? { model: model.model } : {}),
    consent: { repositoryContentTransfer: true },
  };
}

function modelRequestForOperation(
  model: ReviewOperationModelRequest,
): ReviewModelRequest {
  if (model.kind === "resolved") {
    return {
      providerConfig: model.providerConfig,
      provider: model.provider,
    };
  }
  if (model.kind === "stored-provider") {
    return { providerId: model.providerId };
  }
  return cliModelSelectionForOperation(model);
}

function reviewPublicationIntentForOperation(
  publication: false | ReviewOperationPublicationRequest,
): false | ReviewPublicationIntent {
  if (publication === false) {
    return false;
  }
  return {
    mode: publication.mode,
    options: {
      ...(publication.summary !== undefined
        ? { summary: publication.summary }
        : {}),
      ...(publication.inline !== undefined
        ? { inline: publication.inline }
        : {}),
      ...(publication.triageLabel !== undefined
        ? { triageLabel: publication.triageLabel }
        : {}),
    },
  };
}

function assertOperationRepositoryContentConsent(
  model: ReviewOperationModelRequest,
): void {
  if (model.consent.repositoryContentTransfer !== true) {
    throw new Error(
      "PR review requires explicit repository-content transfer consent before model invocation.",
    );
  }
}

function reviewOperationFailure(error: unknown): ReviewOperationResult {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const phaseError = findReviewOperationPhaseError(normalized);
  const statusError =
    phaseError?.cause instanceof Error ? phaseError.cause : normalized;
  return {
    ok: false,
    error: normalized,
    phase: phaseError?.phase ?? reviewOperationFailurePhase(normalized),
    run: error instanceof ReviewOrchestratorError ? error.run : null,
    ...reviewOperationStatusCode(statusError),
  };
}

function reviewOperationFailurePhase(error: Error): ReviewOperationPhase {
  if (error.message.includes("repository-content transfer consent")) {
    return "consent";
  }
  if (error instanceof ReviewWorkflowSourceError) {
    return "source";
  }
  if (
    error.message.includes("publication") ||
    error.message.includes("ready-for-review") ||
    error.message.includes("publisher")
  ) {
    return "publication";
  }
  if (error.message.includes("output")) {
    return "output";
  }
  if (error instanceof ReviewOrchestratorError) {
    return "model";
  }
  return "model";
}

function reviewOperationStatusCode(error: Error): {
  statusCode?: 403 | 409 | 422;
} {
  if (error.message.includes("repository-content transfer consent")) {
    return { statusCode: 403 };
  }
  if (error instanceof ReviewWorkflowSourceError) {
    return { statusCode: error.statusCode };
  }
  return {};
}

class ReviewOperationPhaseFailure extends Error {
  phase: ReviewOperationPhase;

  constructor(phase: ReviewOperationPhase, cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "ReviewOperationPhaseFailure";
    this.phase = phase;
  }
}

function withReviewOperationPhases(
  deps: ReviewOperationDeps,
): ReviewOperationDeps {
  return {
    sources: {
      prepareLocal(input) {
        return withReviewOperationPhase("source", () =>
          deps.sources.prepareLocal(input),
        );
      },
      ...(deps.sources.prepareStored
        ? {
            prepareStored(input) {
              return withReviewOperationPhase(
                "source",
                () =>
                  deps.sources.prepareStored?.(input) ??
                  Promise.reject(
                    new Error(
                      "Stored repository review requires a stored source port.",
                    ),
                  ),
              );
            },
          }
        : {}),
    },
    ...(deps.promptContext
      ? {
          promptContext: {
            load(input) {
              return withReviewOperationPhase(
                "prompt-context",
                () =>
                  deps.promptContext?.load(input) ??
                  Promise.resolve({ context: {}, paths: [] }),
              );
            },
          },
        }
      : {}),
    modelProviders: {
      resolve(input) {
        return withReviewOperationPhase("model", () =>
          deps.modelProviders.resolve(input),
        );
      },
    },
    ...(deps.publisher
      ? {
          publisher: {
            plan(input) {
              return withReviewOperationPhase(
                "publication",
                () =>
                  deps.publisher?.plan(input) ??
                  Promise.reject(
                    new Error("Review publication requires a publisher port."),
                  ),
              );
            },
            publish(input) {
              return withReviewOperationPhase(
                "publication",
                () =>
                  deps.publisher?.publish(input) ??
                  Promise.reject(
                    new Error("Review publication requires a publisher port."),
                  ),
              );
            },
          },
        }
      : {}),
    ...(deps.output
      ? {
          output: {
            writeMarkdown(input) {
              return withReviewOperationPhase(
                "output",
                () =>
                  deps.output?.writeMarkdown(input) ??
                  Promise.reject(
                    new Error(
                      "Review markdown output requires an output writer port.",
                    ),
                  ),
              );
            },
          },
        }
      : {}),
    ...(deps.persistence
      ? {
          persistence: {
            startRun(input) {
              return withReviewOperationPhase(
                "persistence",
                () =>
                  deps.persistence?.startRun(input) ??
                  Promise.reject(
                    new Error(
                      "Review run persistence requires a persistence port.",
                    ),
                  ),
              );
            },
            succeedRun(input) {
              return withReviewOperationPhase(
                "persistence",
                () =>
                  deps.persistence?.succeedRun(input) ??
                  Promise.reject(
                    new Error(
                      "Review run persistence requires a persistence port.",
                    ),
                  ),
              );
            },
            failRun(input) {
              return withReviewOperationPhase(
                "persistence",
                () =>
                  deps.persistence?.failRun(input) ??
                  Promise.reject(
                    new Error(
                      "Review run persistence requires a persistence port.",
                    ),
                  ),
              );
            },
            storeReview(input) {
              return withReviewOperationPhase(
                "persistence",
                () =>
                  deps.persistence?.storeReview(input) ??
                  Promise.reject(
                    new Error("Review storage requires a persistence port."),
                  ),
              );
            },
          },
        }
      : {}),
    ...(deps.errors ? { errors: deps.errors } : {}),
  };
}

async function withReviewOperationPhase<T>(
  phase: ReviewOperationPhase,
  action: () => T | Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ReviewOperationPhaseFailure) {
      throw error;
    }
    throw new ReviewOperationPhaseFailure(phase, error);
  }
}

function findReviewOperationPhaseError(
  error: Error,
): ReviewOperationPhaseFailure | null {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current instanceof ReviewOperationPhaseFailure) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

async function runWorkflowRequest(
  deps: ReviewWorkflowDeps,
  request: () => Promise<ReviewRun>,
): Promise<ReviewRun> {
  try {
    return await request();
  } catch (error) {
    if (!deps.errors) {
      throw error;
    }
    throw deps.errors.map(error);
  }
}

async function prepareLocalWorkflowSource(
  local: LocalReviewEnvironment,
  input: {
    repoRoot: string;
    target?: ReviewTargetRequest;
    limits?: Partial<ReviewContentLimits>;
  },
): Promise<ReviewPreparedSource> {
  const profile = await local.prepareProfile({ repoRoot: input.repoRoot });
  if (input.target?.kind === "pullRequest") {
    if (local.fetchPullRequest) {
      const reviewInput = await local.fetchPullRequest({
        repoRoot: input.repoRoot,
        profile,
        prNumber: input.target.number,
        ...(input.target.baseRef ? { baseRef: input.target.baseRef } : {}),
        ...(input.target.headRef ? { headRef: input.target.headRef } : {}),
        ...(input.limits ? { limits: input.limits } : {}),
      });
      return {
        profile,
        input: reviewInput,
        repoRoot: input.repoRoot,
        adapter: "local-pull-request",
      };
    }
    if (!local.fetchPullRequestMetadata) {
      throw new ReviewWorkflowSourceError(
        422,
        "Pull request review requires a pull request source port.",
      );
    }
    return prepareLocalPullRequestWorkflowSource({
      local,
      repoRoot: input.repoRoot,
      profile,
      target: input.target,
      ...(input.limits ? { limits: input.limits } : {}),
    });
  }
  const baseRef =
    input.target?.kind === "diff" && input.target.baseRef
      ? input.target.baseRef
      : ((await local.detectDefaultBranch({ repoRoot: input.repoRoot })) ??
        profile.defaultBranch ??
        "main");
  const headRef =
    input.target?.kind === "diff" && input.target.headRef
      ? input.target.headRef
      : "HEAD";
  const localInput = await local
    .assembleDiff({
      repoRoot: input.repoRoot,
      profile,
      baseRef,
      headRef,
      ...(input.limits ? { limits: input.limits } : {}),
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new ReviewWorkflowSourceError(
        422,
        `Unable to assemble review diff for ${baseRef}...${headRef}. Verify --base-ref and --head-ref. ${message}`,
      );
    });
  return {
    profile,
    input: {
      ...localInput,
      prNumber:
        input.target?.kind === "diff"
          ? (input.target.prNumber ?? null)
          : localInput.prNumber,
      owner: profile.owner,
      repo: profile.name,
      isDraft: null,
      mergeable: null,
      mergeStateStatus: null,
      reviewDecision: null,
    },
    repoRoot: input.repoRoot,
    adapter: "local-diff",
  };
}

async function prepareLocalPullRequestWorkflowSource(input: {
  local: LocalReviewEnvironment;
  repoRoot: string;
  profile: RepoProfile;
  target: Extract<ReviewTargetRequest, { kind: "pullRequest" }>;
  limits?: Partial<ReviewContentLimits>;
}): Promise<ReviewPreparedSource> {
  if (!input.local.fetchPullRequestMetadata) {
    throw new ReviewWorkflowSourceError(
      422,
      "Pull request review requires a pull request metadata port.",
    );
  }
  const metadata = await input.local.fetchPullRequestMetadata({
    repoRoot: input.repoRoot,
    profile: input.profile,
    prNumber: input.target.number,
    ...(input.target.baseRef ? { baseRef: input.target.baseRef } : {}),
    ...(input.target.headRef ? { headRef: input.target.headRef } : {}),
  });
  const baseRef = input.target.baseRef ?? metadata.baseRef;
  const headRef = input.target.headRef ?? metadata.headRef ?? "HEAD";
  const localInput = await input.local
    .assembleDiff({
      repoRoot: input.repoRoot,
      profile: input.profile,
      baseRef,
      headRef,
      ...(input.limits ? { limits: input.limits } : {}),
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new ReviewWorkflowSourceError(
        422,
        `Unable to assemble review diff for ${baseRef}...${headRef}. Verify PR #${input.target.number}. ${message}`,
      );
    });
  return {
    profile: input.profile,
    input: {
      ...localInput,
      prNumber: metadata.number,
      owner: metadata.owner ?? input.profile.owner,
      repo: metadata.repo ?? input.profile.name,
      title: metadata.title ?? localInput.title,
      body: metadata.body ?? localInput.body,
      url: metadata.url ?? localInput.url,
      author: metadata.author ?? localInput.author,
      isDraft: metadata.isDraft ?? localInput.isDraft,
      mergeable: metadata.mergeable ?? localInput.mergeable,
      mergeStateStatus:
        metadata.mergeStateStatus ?? localInput.mergeStateStatus,
      reviewDecision: metadata.reviewDecision ?? localInput.reviewDecision,
      baseSha: metadata.baseSha ?? localInput.baseSha,
      headSha: metadata.headSha ?? localInput.headSha,
      checkStatuses: metadata.checkStatuses ?? localInput.checkStatuses,
      existingComments:
        metadata.existingComments ?? localInput.existingComments,
    },
    repoRoot: input.repoRoot,
    adapter: "local-pull-request-metadata",
  };
}

function normalizeReviewTargetShortcut(
  target: ReviewTargetShortcut,
): ReviewTargetRequest {
  if ("pr" in target) {
    return {
      kind: "pullRequest",
      number: target.pr,
      ...(target.baseRef ? { baseRef: target.baseRef } : {}),
      ...(target.headRef ? { headRef: target.headRef } : {}),
    };
  }
  const diff = target.diff ?? {};
  return {
    kind: "diff",
    ...(diff.baseRef ? { baseRef: diff.baseRef } : {}),
    ...(diff.headRef ? { headRef: diff.headRef } : {}),
    ...(diff.prNumber !== undefined ? { prNumber: diff.prNumber } : {}),
  };
}

function normalizeOutputShortcut(
  output: ReviewOutputShortcut | undefined,
): ReviewOutputIntent | undefined {
  if (!output) {
    return undefined;
  }
  return {
    markdownPath: output.markdownPath,
    ...(output.write ? { write: output.write } : {}),
  };
}

function normalizePublicationShortcut(
  publication: false | ReviewPublicationShortcut | undefined,
): false | ReviewPublicationIntent | undefined {
  if (publication === undefined || publication === false) {
    return publication;
  }
  if (publication === "plan" || publication === "publish") {
    return { mode: publication };
  }
  return {
    mode: publication.mode,
    options: {
      ...(publication.summary !== undefined
        ? { summary: publication.summary }
        : {}),
      ...(publication.inline !== undefined
        ? { inline: publication.inline }
        : {}),
      ...(publication.triageLabel !== undefined
        ? { triageLabel: publication.triageLabel }
        : {}),
    },
  };
}

function intentForPublication(
  publication: false | ReviewPublicationIntent | undefined,
): "preview" | "apply" {
  return publication !== undefined &&
    publication !== false &&
    publication.mode === "plan"
    ? "preview"
    : "apply";
}

function normalizeReviewContentLimits(
  limits: Partial<ReviewContentLimits> | undefined,
): ReviewContentLimits {
  return { ...defaultReviewContentLimits, ...(limits ?? {}) };
}

function assertNonEmptyReviewSource(source: ReviewPreparedSource): void {
  if (source.input.changedFiles.length === 0) {
    throw new ReviewWorkflowSourceError(
      422,
      `No changed files were detected for ${source.input.baseRef}...${source.input.headRef}. Check the review target before creating a review.`,
    );
  }
}

/** @deprecated Use createReviewOperation. */
export function createPullRequestReviewWorkflow(
  deps: PullRequestReviewWorkflowDeps,
): PullRequestReviewWorkflow {
  const orchestrator = createReviewOrchestrator({
    sources: {
      async prepareLocal(input) {
        if (input.target?.kind !== "pullRequest") {
          throw new Error(
            "Pull request review workflow requires a pull request target.",
          );
        }
        const profile = await deps.repoProfile.load(input.repoRoot);
        const reviewInput = await deps.pullRequests.fetchReviewInput({
          repoId: profile.repoId,
          owner: profile.owner,
          repo: profile.name,
          pullNumber: input.target.number,
          ...(input.limits ? { limits: input.limits } : {}),
        });
        return { profile, input: reviewInput, repoRoot: input.repoRoot };
      },
    },
    promptContext: {
      async load(input) {
        if (!input.repoRoot) {
          return { context: {}, paths: [] };
        }
        return deps.promptContext.load({
          repoRoot: input.repoRoot,
          profile: input.profile,
        });
      },
    },
    modelProviders: {
      resolve(input) {
        if (!("provider" in input.model) || "providerConfig" in input.model) {
          throw new Error(
            "Pull request review workflow requires a CLI model selection.",
          );
        }
        if (!input.repoRoot) {
          throw new Error(
            "Pull request review workflow requires a local repository root.",
          );
        }
        return deps.modelProviders.create({
          ...input.model,
          repoRoot: input.repoRoot,
        });
      },
    },
    publisher: deps.publisher,
    ...(deps.output ? { output: deps.output } : {}),
  });
  return {
    async reviewPullRequest(request) {
      const run = await orchestrator.review({
        repository: { kind: "local", repoRoot: request.repoRoot },
        target: { kind: "pullRequest", number: request.pullNumber },
        model: request.model,
        intent: request.publication?.mode === "plan" ? "preview" : "apply",
        ...(request.publication ? { publication: request.publication } : {}),
        ...(request.output ? { output: request.output } : {}),
        ...(request.limits ? { limits: request.limits } : {}),
      });
      return {
        review: run.review,
        markdown: run.markdown,
        target: reviewTargetFromInput(run.source.input),
        output: run.output,
        publication: run.publication,
        diagnostics: run.diagnostics,
      };
    },
  };
}

/** @deprecated Use createReviewOperation. */
export function createReviewOrchestrator(
  deps: ReviewOrchestratorDeps,
  defaults: Partial<ReviewRequest> = {},
): ReviewOrchestrator {
  return {
    async review(request) {
      const resolvedRequest = { ...defaults, ...request } as ReviewRequest;
      assertReviewRequestModelConsent(resolvedRequest.model);
      const source = await prepareReviewSource(deps.sources, resolvedRequest);
      let activeRun: RunRecord | null = null;
      if (shouldPersistRun(resolvedRequest.persistence)) {
        if (!deps.persistence) {
          throw new Error(
            "Review run persistence requires a persistence port.",
          );
        }
        activeRun = await deps.persistence.startRun({
          request: resolvedRequest,
          source,
        });
      }
      try {
        const promptContext = deps.promptContext
          ? await deps.promptContext.load({
              repoRoot: source.repoRoot,
              profile: source.profile,
              reviewInput: source.input,
            })
          : { context: {}, paths: [] };
        const providerReview = await deps.modelProviders.resolve({
          model: resolvedRequest.model,
          repoRoot: source.repoRoot,
          profile: source.profile,
          reviewInput: source.input,
        });
        const review = await generateReview({
          profile: source.profile,
          input: source.input,
          rules: source.profile.reviewRuleCandidates,
          providerConfig: providerReview.providerConfig,
          provider: providerReview.provider,
          ...(Object.keys(promptContext.context).length > 0
            ? { promptContext: promptContext.context }
            : {}),
        });
        const markdown = renderReviewMarkdown(review);
        const output = await runReviewOutput({
          intent: resolvedRequest.output,
          reviewIntent: resolvedRequest.intent,
          publicationIntent: resolvedRequest.publication,
          deps,
          repoRoot: source.repoRoot,
          markdown,
        });
        const publication = await runReviewPublication({
          intent: resolvedRequest.publication,
          deps,
          review,
          markdown,
          target: resolvedRequest.publication
            ? reviewTargetFromInput(source.input)
            : null,
          reviewInput: source.input,
        });
        let reviewStored = false;
        if (shouldPersistReview(resolvedRequest.persistence)) {
          if (!deps.persistence) {
            throw new Error("Review storage requires a persistence port.");
          }
          await deps.persistence.storeReview({ review });
          reviewStored = true;
        }
        if (activeRun && deps.persistence) {
          activeRun = await deps.persistence.succeedRun({
            run: activeRun,
            review,
            source,
          });
        }
        return {
          review,
          markdown,
          source: {
            profile: source.profile,
            input: source.input,
            repoRoot: source.repoRoot,
          },
          output,
          publication,
          persistence: { run: activeRun, reviewStored },
          diagnostics: {
            promptContextPaths: promptContext.paths,
            skippedFiles: source.input.skippedFiles,
            changedFileCount: source.input.changedFiles.length,
          },
        };
      } catch (error) {
        if (activeRun && deps.persistence) {
          const failedRun = await deps.persistence.failRun({
            run: activeRun,
            error,
            source,
          });
          throw new ReviewOrchestratorError(errorMessage(error), failedRun, {
            cause: error,
          });
        }
        throw error;
      }
    },
  };
}

async function prepareReviewSource(
  sources: ReviewSourcePort,
  request: ReviewRequest,
): Promise<ReviewPreparedSource> {
  if (request.repository.kind === "prepared") {
    return {
      profile: request.repository.profile,
      input: request.repository.input,
      repoRoot: request.repository.repoRoot ?? null,
    };
  }
  if (request.repository.kind === "local") {
    return sources.prepareLocal({
      repoRoot: request.repository.repoRoot,
      ...(request.target ? { target: request.target } : {}),
      ...(request.limits ? { limits: request.limits } : {}),
    });
  }
  if (!sources.prepareStored) {
    throw new Error("Stored repository review requires a stored source port.");
  }
  return sources.prepareStored({
    repoId: request.repository.repoId,
    ...(request.target ? { target: request.target } : {}),
    ...(request.limits ? { limits: request.limits } : {}),
  });
}

async function runReviewOutput(input: {
  intent: ReviewOutputIntent | undefined;
  reviewIntent: ReviewRequest["intent"];
  publicationIntent: ReviewRequest["publication"];
  deps: Pick<ReviewOrchestratorDeps, "output">;
  repoRoot: string | null;
  markdown: string;
}): Promise<ReviewOutputResult | null> {
  if (!input.intent?.markdownPath) {
    return null;
  }
  const writeMode = input.intent.write ?? "apply-only";
  const result = {
    markdownPath: input.intent.markdownPath,
    written: shouldWriteReviewOutput({
      writeMode,
      reviewIntent: input.reviewIntent,
      publicationIntent: input.publicationIntent,
    }),
  };
  if (!result.written) {
    return result;
  }
  if (!input.repoRoot) {
    throw new Error("Review markdown output requires a repository root.");
  }
  if (!input.deps.output) {
    throw new Error("Review markdown output requires an output writer port.");
  }
  await input.deps.output.writeMarkdown({
    repoRoot: input.repoRoot,
    path: input.intent.markdownPath,
    markdown: input.markdown,
  });
  return result;
}

function shouldWriteReviewOutput(input: {
  writeMode: "apply-only" | "always" | "never";
  reviewIntent: ReviewRequest["intent"];
  publicationIntent: ReviewRequest["publication"];
}): boolean {
  if (input.writeMode === "never") {
    return false;
  }
  if (
    input.reviewIntent === "preview" ||
    (input.publicationIntent !== undefined &&
      input.publicationIntent !== false &&
      input.publicationIntent.mode === "plan")
  ) {
    return false;
  }
  if (input.writeMode === "always") {
    return true;
  }
  return input.publicationIntent !== false;
}

export async function generateReview(
  options: GenerateReviewOptions,
): Promise<ReviewResult> {
  const precheck = buildReviewEvidencePrecheck(options);
  return generateModelBackedReview({
    ...(options.repoId ? { repoId: options.repoId } : {}),
    profile: options.profile,
    input: options.input,
    rules: options.rules ?? [],
    precheck,
    providerConfig: options.providerConfig,
    provider: options.provider,
    ...(options.promptContext ? { promptContext: options.promptContext } : {}),
  });
}

async function runReviewPublication(input: {
  intent: ReviewRequest["publication"];
  deps: Pick<ReviewOrchestratorDeps, "publisher">;
  review: ReviewResult;
  markdown: string;
  target: PullRequestReviewTarget | null;
  reviewInput: ReviewInput;
}): Promise<PullRequestReviewRun["publication"]> {
  if (!input.intent) {
    return { mode: "skipped" };
  }
  if (!input.target) {
    throw new Error("Review publication requires a pull request target.");
  }
  if (!input.deps.publisher) {
    throw new Error("Review publication requires a publisher port.");
  }
  const options = normalizeReviewPublishOptions(input.intent.options);
  assertReviewPublicationAllowed({
    review: input.review,
    reviewInput: input.reviewInput,
    options,
  });
  const publicationInput = {
    review: input.review,
    markdown: input.markdown,
    target: input.target,
    reviewInput: input.reviewInput,
    options,
  };
  if (input.intent.mode === "plan") {
    return {
      mode: "planned",
      ...(await input.deps.publisher.plan(publicationInput)),
    };
  }
  return {
    mode: "published",
    ...(await input.deps.publisher.publish(publicationInput)),
  };
}

function normalizeReviewPublishOptions(
  options: ReviewPublishOptions | undefined,
): RequiredReviewPublishOptions {
  return {
    summary: options?.summary ?? true,
    inline:
      options?.inline === false
        ? false
        : { cap: Math.max(0, options?.inline?.cap ?? 5) },
    triageLabel:
      options?.triageLabel === false || !options?.triageLabel
        ? false
        : {
            apply: true,
            createMissingLabels:
              options.triageLabel.createMissingLabels ?? false,
          },
  };
}

function assertReviewRequestModelConsent(model: ReviewModelRequest): void {
  if ("consent" in model) {
    assertReviewModelConsent(model);
  }
}

function assertReviewModelConsent(model: ReviewModelSelection): void {
  if (model.consent.repositoryContentTransfer !== true) {
    throw new Error(
      "PR review requires explicit repository-content transfer consent before model invocation.",
    );
  }
}

function shouldPersistRun(
  intent: ReviewPersistenceIntent | undefined,
): boolean {
  return intent !== false && intent?.run === true;
}

function shouldPersistReview(
  intent: ReviewPersistenceIntent | undefined,
): boolean {
  return intent !== false && intent?.review === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertReviewPublicationAllowed(input: {
  review: ReviewResult;
  reviewInput: ReviewInput;
  options: RequiredReviewPublishOptions;
}): void {
  if (!input.options.triageLabel) {
    return;
  }
  if (input.review.contributionTriage.category !== "ready_for_review") {
    return;
  }
  const blockers = blockingPullRequestStateReasons(input.reviewInput);
  if (blockers.length === 0) {
    return;
  }
  throw new Error(
    `Refusing to apply open-maintainer/ready-for-review because GitHub reports this PR is blocked: ${blockers.join("; ")}.`,
  );
}

function blockingPullRequestStateReasons(input: ReviewInput): string[] {
  const reasons = [];
  if (input.isDraft === true) {
    reasons.push("PR is draft");
  }
  if (normalizeState(input.mergeable) === "CONFLICTING") {
    reasons.push("PR has merge conflicts");
  }
  if (normalizeState(input.mergeStateStatus) === "DIRTY") {
    reasons.push("merge state is dirty");
  }
  if (normalizeState(input.reviewDecision) === "CHANGES_REQUESTED") {
    reasons.push("changes are requested");
  }
  const blockingChecks = input.checkStatuses.filter((check) =>
    isBlockingCheckStatus(check),
  );
  if (blockingChecks.length > 0) {
    reasons.push(
      `blocking checks: ${blockingChecks.map((check) => check.name).join(", ")}`,
    );
  }
  return reasons;
}

function reviewTargetFromInput(input: ReviewInput): PullRequestReviewTarget {
  if (!input.prNumber) {
    throw new Error("Pull request review workflow requires a PR number.");
  }
  return {
    owner: input.owner,
    repo: input.repo,
    pullNumber: input.prNumber,
    url: input.url,
    baseSha: input.baseSha,
    headSha: input.headSha,
  };
}

export function buildReviewEvidencePrecheck(input: {
  profile: RepoProfile;
  input: ReviewInput;
  rules?: string[];
}): ReviewEvidencePrecheck {
  const changedSurface = classifyChangedSurface(input.input, input.profile);
  const expectedValidation = inferExpectedValidation({
    profile: input.profile,
    changedSurface,
    input: input.input,
    rules: input.rules ?? [],
  });
  const validationEvidence = detectValidationEvidence(
    input.input,
    expectedValidation,
  );
  const docsImpact = inferDocsImpact(input.input, changedSurface);
  const riskAnalysis = buildRiskAnalysis(input.input, input.profile);
  const residualRisk = buildResidualRisk(input.input);
  const contributionTriageEvidence = buildContributionTriageEvidence({
    profile: input.profile,
    input: input.input,
    changedSurface,
    expectedValidation,
    validationEvidence,
    docsImpact,
  });

  return {
    walkthrough: input.input.changedFiles.map(
      (file) =>
        `${file.status} ${file.path} (+${file.additions}/-${file.deletions})`,
    ),
    changedSurface,
    riskAnalysis,
    expectedValidation,
    validationEvidence,
    docsImpact,
    residualRisk,
    contributionTriageEvidence,
  };
}

export function parseReviewResult(input: unknown): ReviewResult {
  return ReviewResultSchema.parse(input);
}

export function classifyChangedSurface(
  input: ReviewInput,
  profile: RepoProfile,
): string[] {
  const surfaces = new Set<string>();
  for (const file of input.changedFiles) {
    const path = file.path;
    if (path.startsWith("apps/cli/")) {
      surfaces.add("cli");
    } else if (path.startsWith("apps/api/")) {
      surfaces.add("api");
    } else if (path.startsWith("apps/web/")) {
      surfaces.add("web");
    } else if (path.startsWith("apps/worker/")) {
      surfaces.add("worker");
    } else if (path.startsWith("packages/")) {
      const [, packageName = "unknown"] = path.split("/");
      surfaces.add(`package:${packageName}`);
    } else if (path === "action.yml" || path.startsWith(".github/workflows/")) {
      surfaces.add("github-action/workflow");
    } else if (path === "docker-compose.yml" || path === ".dockerignore") {
      surfaces.add("docker-compose");
    } else if (isGeneratedContextPath(path, profile)) {
      surfaces.add("generated-context");
    } else if (isDocsPath(path)) {
      surfaces.add("docs");
    } else if (path.startsWith("tests/")) {
      surfaces.add("fixtures/tests");
    } else if (isConfigOrLockPath(path, profile)) {
      surfaces.add("config/lockfile");
    }
    if (profile.riskHintPaths.some((riskPath) => path.startsWith(riskPath))) {
      surfaces.add("risk");
    }
  }
  return [...surfaces].sort();
}

export function inferExpectedValidation(input: {
  profile: RepoProfile;
  changedSurface: string[];
  input: ReviewInput;
  rules?: string[];
}): ReviewValidationExpectation[] {
  const commands = new Map<string, ReviewValidationExpectation>();
  const addCommand = (
    command: string,
    reason: string,
    evidence: ReviewEvidenceCitation,
  ) => {
    if (!commands.has(command)) {
      commands.set(command, { command, reason, evidence: [evidence] });
    }
  };
  const ruleCitation = {
    source: "open_maintainer_config" as const,
    path: ".open-maintainer.yml",
    excerpt: input.rules?.[0] ?? null,
    reason: "Repository validation rules define expected checks.",
  };

  for (const command of input.profile.commands) {
    if (shouldRunCommandForSurface(command.command, input.changedSurface)) {
      addCommand(
        command.command,
        `Changed surfaces ${input.changedSurface.join(", ")} match ${command.name} validation.`,
        {
          source: "repo_profile",
          path: command.source,
          excerpt: command.command,
          reason: "Repository profile detected this validation command.",
        },
      );
    }
  }

  if (
    input.input.changedFiles.some((file) =>
      /\.(ts|tsx|js|jsx)$/.test(file.path),
    )
  ) {
    for (const command of input.profile.commands.filter((item) =>
      /(tsc|typecheck)/i.test(`${item.name} ${item.command}`),
    )) {
      addCommand(command.command, "TypeScript or JavaScript files changed.", {
        source: "repo_profile",
        path: command.source,
        excerpt: command.command,
        reason: "Typecheck command was detected in the repo profile.",
      });
    }
  }

  if (input.rules && input.rules.length > 0) {
    for (const rule of input.rules) {
      const command = extractCommandFromRule(rule);
      if (command) {
        addCommand(command, "Repository rule names this validation command.", {
          ...ruleCitation,
          excerpt: rule,
        });
      }
    }
  }

  return [...commands.values()];
}

export function detectValidationEvidence(
  input: ReviewInput,
  expectedValidation: ReviewValidationExpectation[],
): string[] {
  const evidence = new Set<string>();
  const body = input.body.toLowerCase();
  for (const expected of expectedValidation) {
    const normalizedCommand = expected.command.toLowerCase();
    if (body.includes(normalizedCommand)) {
      evidence.add(`PR body mentions \`${expected.command}\`.`);
    }
    const commandWords = normalizedCommand.split(/\s+/).filter(Boolean);
    for (const check of input.checkStatuses) {
      const checkText =
        `${check.name} ${check.status} ${check.conclusion ?? ""}`.toLowerCase();
      if (
        commandWords.some(
          (word) => word.length > 2 && checkText.includes(word),
        ) ||
        (normalizedCommand.includes("tsc") && checkText.includes("typecheck"))
      ) {
        evidence.add(
          `Check \`${check.name}\` reported ${check.conclusion ?? check.status}.`,
        );
      }
    }
  }
  return [...evidence].sort();
}

function inferDocsImpact(input: ReviewInput, changedSurface: string[]) {
  const docsChanged = input.changedFiles.some((file) => isDocsPath(file.path));
  const impacts = new Map<string, ReviewResult["docsImpact"][number]>();
  const addImpact = (path: string, reason: string, required: boolean) => {
    if (!impacts.has(path)) {
      impacts.set(path, {
        path,
        reason,
        required,
        evidence: [
          {
            source: "changed_file",
            path: input.changedFiles[0]?.path ?? null,
            excerpt: null,
            reason: "Changed surface can affect user-facing documentation.",
          },
        ],
      });
    }
  };
  if (changedSurface.includes("cli")) {
    addImpact("README.md", "CLI behavior or help may have changed.", true);
    addImpact("docs/DEMO_RUNBOOK.md", "Demo commands may need review.", true);
  }
  if (changedSurface.includes("github-action/workflow")) {
    addImpact("README.md", "Action behavior may have changed.", true);
  }
  if (
    changedSurface.includes("api") ||
    changedSurface.includes("web") ||
    changedSurface.includes("docker-compose")
  ) {
    addImpact(
      "docs/DEMO_RUNBOOK.md",
      "Self-hosted or dashboard workflow may have changed.",
      true,
    );
  }
  if (changedSurface.includes("generated-context")) {
    addImpact("AGENTS.md", "Generated context changed.", false);
  }
  return docsChanged ? [] : [...impacts.values()];
}

function buildRiskAnalysis(input: ReviewInput, profile: RepoProfile): string[] {
  const risks = new Set<string>();
  for (const skipped of input.skippedFiles) {
    risks.add(`${skipped.path} was skipped during review (${skipped.reason}).`);
  }
  for (const file of input.changedFiles) {
    if (
      profile.riskHintPaths.some((riskPath) => file.path.startsWith(riskPath))
    ) {
      risks.add(`${file.path} matches a repository risk path.`);
    }
  }
  return risks.size > 0
    ? [...risks].sort()
    : ["No risk path or skipped-file risk was detected before model review."];
}

function buildResidualRisk(input: ReviewInput): string[] {
  const risks = [];
  if (input.checkStatuses.length === 0) {
    risks.push("CI/check status was unavailable in the review input.");
  }
  if (input.issueContext.length === 0) {
    risks.push("No linked issue acceptance criteria were available.");
  }
  return risks;
}

function buildContributionTriageEvidence(input: {
  profile: RepoProfile;
  input: ReviewInput;
  changedSurface: string[];
  expectedValidation: ReviewValidationExpectation[];
  validationEvidence: string[];
  docsImpact: ReviewResult["docsImpact"];
}): ContributionTriageEvidenceCandidate[] {
  const changedLines = input.input.changedFiles.reduce(
    (total, file) => total + file.additions + file.deletions,
    0,
  );
  const changedFileCitations = input.input.changedFiles
    .slice(0, 8)
    .map((file) =>
      reviewCitation({
        source: "changed_file",
        path: file.path,
        excerpt: `${file.status} (+${file.additions}/-${file.deletions})`,
        reason: "Changed file contributes to PR contribution-triage evidence.",
      }),
    );
  const bodyText = input.input.body.trim();
  const titleText = input.input.title?.trim() ?? "";
  const issueReferences = detectIssueReferences(
    `${input.input.title ?? ""}\n${input.input.body}`,
  );
  const issueCriteria = input.input.issueContext.flatMap(
    (issue) => issue.acceptanceCriteria,
  );
  const blockingChecks = input.input.checkStatuses.filter((check) =>
    isBlockingCheckStatus(check),
  );
  const prStateSummary = [
    `draft=${formatUnknownBoolean(input.input.isDraft)}`,
    `mergeable=${input.input.mergeable ?? "unknown"}`,
    `mergeStateStatus=${input.input.mergeStateStatus ?? "unknown"}`,
    `reviewDecision=${input.input.reviewDecision ?? "unknown"}`,
    `blockingChecks=${blockingChecks.length}`,
  ].join("; ");
  const generatedFiles = input.input.changedFiles.filter((file) =>
    isGeneratedContextPath(file.path, input.profile),
  );
  const lockfiles = input.input.changedFiles.filter(
    (file) =>
      input.profile.lockfiles.includes(file.path) || isLockfilePath(file.path),
  );
  const dependencyFiles = input.input.changedFiles.filter((file) =>
    isDependencyManifestPath(file.path),
  );
  const highRiskFiles = input.input.changedFiles.filter((file) =>
    input.profile.riskHintPaths.some((riskPath) =>
      file.path.startsWith(riskPath),
    ),
  );
  const docsChanged = input.input.changedFiles.filter((file) =>
    isDocsPath(file.path),
  );

  return [
    {
      signal: "intent_clarity",
      summary: `PR title is ${titleText ? "present" : "missing"}; PR body has ${wordCount(bodyText)} words.`,
      evidence: [
        reviewCitation({
          source: "user_input",
          path: null,
          excerpt: titleText || null,
          reason: "PR title is available as stated intent evidence.",
        }),
        reviewCitation({
          source: "user_input",
          path: null,
          excerpt: summarizeText(bodyText) || null,
          reason: "PR body is available as stated intent evidence.",
        }),
      ],
    },
    {
      signal: "linked_issue_or_acceptance_criteria",
      summary: `Detected ${input.input.issueContext.length} linked issue context item(s), ${issueReferences.length} issue reference(s), and ${issueCriteria.length} acceptance criterion item(s).`,
      evidence: [
        ...input.input.issueContext.map((issue) =>
          reviewCitation({
            source: "issue_acceptance_criteria",
            path: issue.url ?? `#${issue.number}`,
            excerpt: issue.acceptanceCriteria.join("; ") || issue.title,
            reason: "Linked issue context can ground contribution intent.",
          }),
        ),
        ...issueReferences.slice(0, 5).map((reference) =>
          reviewCitation({
            source: "user_input",
            path: null,
            excerpt: reference,
            reason: "PR text references an issue or pull request number.",
          }),
        ),
      ],
    },
    {
      signal: "pr_state",
      summary: `GitHub PR state: ${prStateSummary}.`,
      evidence: [
        reviewCitation({
          source: "ci_status",
          path: input.input.url,
          excerpt: prStateSummary,
          reason:
            "GitHub PR state affects whether the PR is ready for human review.",
        }),
        ...blockingChecks.map((check) =>
          reviewCitation({
            source: "ci_status",
            path: check.url,
            excerpt:
              `${check.name} ${check.status} ${check.conclusion ?? ""}`.trim(),
            reason:
              "Blocking check status affects contribution triage readiness.",
          }),
        ),
      ],
    },
    {
      signal: "diff_scope",
      summary: `${input.input.changedFiles.length} file(s) changed across ${input.changedSurface.join(", ") || "unclassified surface"} with +${totalAdditions(input.input.changedFiles)}/-${totalDeletions(input.input.changedFiles)}.`,
      evidence: changedFileCitations,
    },
    {
      signal: "validation_evidence",
      summary:
        input.validationEvidence.length > 0
          ? `Detected validation evidence: ${input.validationEvidence.join(" ")}`
          : `No validation evidence detected for ${input.expectedValidation.length} expected validation item(s).`,
      evidence:
        input.validationEvidence.length > 0
          ? validationEvidenceCitations(input.input, input.validationEvidence)
          : input.expectedValidation.flatMap((item) => item.evidence),
    },
    {
      signal: "docs_alignment",
      summary:
        input.docsImpact.length > 0
          ? `Documentation impact inferred for ${input.docsImpact.map((item) => item.path).join(", ")}; ${docsChanged.length} docs file(s) changed.`
          : `No documentation impact was inferred; ${docsChanged.length} docs file(s) changed.`,
      evidence:
        input.docsImpact.length > 0
          ? input.docsImpact.flatMap((item) => item.evidence)
          : docsChanged.map((file) =>
              reviewCitation({
                source: "changed_file",
                path: file.path,
                excerpt: `${file.status} docs file`,
                reason:
                  "Changed documentation can satisfy docs-alignment evidence.",
              }),
            ),
    },
    {
      signal: "broad_churn",
      summary: `Diff size candidate: ${input.input.changedFiles.length} file(s), ${changedLines} changed line(s), and ${input.input.skippedFiles.length} skipped file(s).`,
      evidence: [
        ...changedFileCitations,
        ...input.input.skippedFiles.map((file) =>
          reviewCitation({
            source: "changed_file",
            path: file.path,
            excerpt: file.reason,
            reason: "Skipped file contributes to reviewability scope evidence.",
          }),
        ),
      ],
    },
    {
      signal: "high_risk_files",
      summary:
        highRiskFiles.length > 0
          ? `High-risk path candidates changed: ${highRiskFiles.map((file) => file.path).join(", ")}.`
          : "No profile high-risk path candidate was detected in changed files.",
      evidence: highRiskFiles.map((file) =>
        reviewCitation({
          source: "changed_file",
          path: file.path,
          excerpt: matchingRiskHints(file.path, input.profile).join(", "),
          reason: "Changed file matches repository risk path hints.",
        }),
      ),
    },
    {
      signal: "generated_file_changes",
      summary:
        generatedFiles.length > 0
          ? `Generated/context file candidates changed: ${generatedFiles.map((file) => file.path).join(", ")}.`
          : "No generated/context file candidate was detected in changed files.",
      evidence: generatedFiles.map((file) =>
        reviewCitation({
          source: "changed_file",
          path: file.path,
          excerpt: file.status,
          reason: "Changed file matches generated context hints.",
        }),
      ),
    },
    {
      signal: "lockfile_changes",
      summary:
        lockfiles.length > 0
          ? `Lockfile candidates changed: ${lockfiles.map((file) => file.path).join(", ")}.`
          : "No lockfile candidate was detected in changed files.",
      evidence: lockfiles.map((file) =>
        reviewCitation({
          source: "changed_file",
          path: file.path,
          excerpt: file.status,
          reason: "Changed file is a detected lockfile.",
        }),
      ),
    },
    {
      signal: "dependency_changes",
      summary:
        dependencyFiles.length > 0
          ? `Dependency manifest candidates changed: ${dependencyFiles.map((file) => file.path).join(", ")}.`
          : "No dependency manifest candidate was detected in changed files.",
      evidence: dependencyFiles.map((file) =>
        reviewCitation({
          source: "changed_file",
          path: file.path,
          excerpt: file.status,
          reason: "Changed file is a dependency manifest candidate.",
        }),
      ),
    },
  ];
}

function reviewCitation(input: {
  source: ReviewEvidenceCitation["source"];
  path: string | null;
  excerpt: string | null;
  reason: string;
}): ReviewEvidenceCitation {
  return input;
}

function detectIssueReferences(text: string): string[] {
  const references = new Set<string>();
  for (const match of text.matchAll(
    /(?:^|\s)(?:#(\d+)|(?:issues|pull)\/(\d+))/gi,
  )) {
    const number = match[1] ?? match[2];
    if (number) {
      references.add(`#${number}`);
    }
  }
  return [...references];
}

function validationEvidenceCitations(
  input: ReviewInput,
  validationEvidence: string[],
): ReviewEvidenceCitation[] {
  const citations: ReviewEvidenceCitation[] = [];
  if (validationEvidence.some((item) => /PR body mentions/.test(item))) {
    citations.push(
      reviewCitation({
        source: "user_input",
        path: null,
        excerpt: summarizeText(input.body) || null,
        reason: "PR body includes validation evidence.",
      }),
    );
  }
  for (const check of input.checkStatuses) {
    if (
      validationEvidence.some((item) =>
        item.includes(`Check \`${check.name}\``),
      )
    ) {
      citations.push(
        reviewCitation({
          source: "ci_status",
          path: check.url,
          excerpt: `${check.status} ${check.conclusion ?? ""}`.trim(),
          reason: "Check status includes validation evidence.",
        }),
      );
    }
  }
  return citations;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function summarizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function totalAdditions(files: ReviewInput["changedFiles"]): number {
  return files.reduce((total, file) => total + file.additions, 0);
}

function totalDeletions(files: ReviewInput["changedFiles"]): number {
  return files.reduce((total, file) => total + file.deletions, 0);
}

function isBlockingCheckStatus(check: ReviewInput["checkStatuses"][number]) {
  const status = normalizeState(check.status);
  const conclusion = normalizeState(check.conclusion);
  if (status && status !== "COMPLETED") {
    return true;
  }
  return (
    conclusion === "FAILURE" ||
    conclusion === "TIMED_OUT" ||
    conclusion === "CANCELLED" ||
    conclusion === "ACTION_REQUIRED"
  );
}

function normalizeState(value: string | null | undefined): string | null {
  return value ? value.trim().toUpperCase() : null;
}

function formatUnknownBoolean(value: boolean | null): string {
  if (value === null) {
    return "unknown";
  }
  return value ? "true" : "false";
}

function matchingRiskHints(repoPath: string, profile: RepoProfile): string[] {
  return profile.riskHintPaths.filter((riskPath) =>
    repoPath.startsWith(riskPath),
  );
}

function isLockfilePath(repoPath: string): boolean {
  const fileName = repoPath.split("/").at(-1)?.toLowerCase() ?? "";
  return (
    fileName.endsWith(".lock") ||
    fileName === "bun.lock" ||
    fileName === "package-lock.json" ||
    fileName === "pnpm-lock.yaml" ||
    fileName === "yarn.lock"
  );
}

function isDependencyManifestPath(repoPath: string): boolean {
  const fileName = repoPath.split("/").at(-1)?.toLowerCase() ?? "";
  return (
    fileName === "package.json" ||
    fileName === "pyproject.toml" ||
    fileName === "requirements.txt" ||
    fileName === "go.mod" ||
    fileName === "cargo.toml" ||
    fileName === "gemfile"
  );
}

export function renderReviewMarkdown(input: ReviewResult): string {
  const review = parseReviewResult(input);
  const summary = parseStructuredSummary(review.summary);
  const lines = [
    `## OpenMaintainer Review ${review.prNumber ? `#${review.prNumber}` : "local"}`,
    "",
    `${review.baseRef}...${review.headRef}`,
    renderModelLine(review),
    "",
    "### Summary",
    "",
    summary.overview,
    "",
    `Risk level: **${summary.riskLevel ?? inferredRiskLevel(review)}**`,
    "",
    "Main concerns:",
    renderMainConcerns(review),
    "",
    "### Walkthrough",
    "",
    renderWalkthroughTable(review),
    "",
    "### Contribution Triage",
    "",
    renderContributionTriage(review),
    "",
    "### Findings",
    "",
    renderFindings(review.findings),
    "",
    "### Required Validation For This PR",
    "",
    renderRequiredValidationBlock(review),
    "",
    "### Merge Readiness",
    "",
    review.mergeReadiness.reason,
    "",
    "### Residual Risk",
    "",
    renderListOrFallback(review.residualRisk, "No residual risk recorded."),
  ];

  return trimTrailingBlankLines(lines).join("\n");
}

export function renderReviewAgentFeedback(input: ReviewResult): string {
  const review = parseReviewResult(input);
  const findings = orderedFindings(review.findings);
  const requiredActions = [
    ...review.contributionTriage.requiredActions,
    ...requiredValidationCommands(review).map(
      (command) => `Run validation command: ${command}`,
    ),
  ];
  const lines = [
    `Open Maintainer agent feedback ${review.prNumber ? `#${review.prNumber}` : "local"}`,
    "",
    `Diff: ${review.baseRef}...${review.headRef}`,
    `Merge readiness: ${formatReadiness(review.mergeReadiness.status)} - ${review.mergeReadiness.reason}`,
    `Contribution triage: ${formatSnakeCase(review.contributionTriage.category ?? review.contributionTriage.status)} - ${review.contributionTriage.recommendation}`,
    "",
    "Finding types: BLOCKER means must fix; MAJOR means should fix before merge; MINOR means small fix; NOTE means question or observation.",
    "",
    "Required actions:",
    ...(requiredActions.length > 0
      ? requiredActions.map((action) => `- ${action}`)
      : ["- No required author action or validation command was inferred."]),
    "",
    "Numbered comments:",
    ...(findings.length > 0
      ? findings.flatMap(renderAgentFeedbackFinding)
      : ["No concrete findings."]),
  ];

  return trimTrailingBlankLines(lines).join("\n");
}

export function renderReviewSummaryComment(input: ReviewResult): string {
  const review = parseReviewResult(input);
  return [
    "<!-- open-maintainer-review-summary -->",
    renderReviewMarkdown(review),
  ].join("\n");
}

export function renderInlineReviewComment(finding: ReviewFinding): string {
  if (finding.citations.length === 0) {
    throw new Error(`Review finding ${finding.id} has no citations.`);
  }
  return [
    `**${formatSeverity(finding.severity)}: ${finding.title}**`,
    "",
    finding.body,
    "",
    "Evidence:",
    renderCitationList(finding.citations),
  ].join("\n");
}

function renderModelLine(review: ReviewResult): string {
  return review.modelProvider && review.model
    ? `Model: ${review.modelProvider} / ${review.model}`
    : "Model: not recorded";
}

function renderList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function renderListOrFallback(items: string[], fallback: string): string {
  return items.length > 0 ? renderList(items) : `- ${fallback}`;
}

function renderContributionTriage(review: ReviewResult): string {
  const triage = review.contributionTriage;
  if (triage.status === "not_evaluated") {
    return [
      "Status: **Not evaluated**",
      "",
      `Maintainer action: ${triage.recommendation}`,
    ].join("\n");
  }
  return [
    `Category: **${formatSnakeCase(triage.category ?? "not_evaluated")}**`,
    "",
    `Maintainer action: ${triage.recommendation}`,
    "",
    "Missing information:",
    renderListOrFallback(
      triage.missingInformation,
      "No missing contribution information recorded.",
    ),
    "",
    "Required author actions:",
    renderListOrFallback(
      triage.requiredActions,
      "No author action required by contribution triage.",
    ),
    renderCitationBlock(triage.evidence),
  ].join("\n");
}

function parseStructuredSummary(summary: string): {
  overview: string;
  riskLevel: string | null;
  validationSummary: string | null;
  docsSummary: string | null;
} {
  const lines = summary.split(/\r?\n/).map((line) => line.trim());
  const riskLine = lines.find((line) => /^Risk:/i.test(line));
  const validationLine = lines.find((line) => /^Validation:/i.test(line));
  const docsLine = lines.find((line) => /^Docs:/i.test(line));
  const overview = lines
    .filter(
      (line) =>
        line &&
        !/^Risk:/i.test(line) &&
        !/^Validation:/i.test(line) &&
        !/^Docs:/i.test(line),
    )
    .join("\n");
  return {
    overview: overview || summary,
    riskLevel: riskLine?.replace(/^Risk:\s*/i, "").replace(/\.$/, "") ?? null,
    validationSummary:
      validationLine?.replace(/^Validation:\s*/i, "").replace(/\.$/, "") ??
      null,
    docsSummary: docsLine?.replace(/^Docs:\s*/i, "").replace(/\.$/, "") ?? null,
  };
}

function inferredRiskLevel(review: ReviewResult): string {
  if (review.findings.some((finding) => finding.severity === "blocker")) {
    return "critical";
  }
  if (review.findings.some((finding) => finding.severity === "major")) {
    return "high";
  }
  if (review.findings.some((finding) => finding.severity === "minor")) {
    return "medium";
  }
  return "low";
}

function renderMainConcerns(review: ReviewResult): string {
  const concerns = review.findings.slice(0, 5).map((finding) => finding.title);
  if (concerns.length === 0) {
    return "- No concrete findings.";
  }
  return renderList(concerns);
}

function renderWalkthroughTable(review: ReviewResult): string {
  const areas = review.changedSurface.length
    ? review.changedSurface
    : review.walkthrough;
  const rows = areas.map((area) => {
    const files = review.changedFiles.filter((file) =>
      fileMatchesSurface(file.path, area),
    );
    const changed = files.length
      ? files
          .slice(0, 3)
          .map((file) => `\`${file.path}\``)
          .join(", ")
      : review.walkthrough[0] || "Changed files in this area.";
    const focus =
      review.riskAnalysis.find((risk) =>
        risk.toLowerCase().includes(area.toLowerCase()),
      ) ??
      review.findings.find((finding) =>
        finding.path ? fileMatchesSurface(finding.path, area) : false,
      )?.title ??
      "Review changed behavior, validation, and repo policy.";
    return `| \`${area}\` | ${escapeTableCell(changed)} | ${escapeTableCell(focus)} |`;
  });
  return [
    "| Area | What changed | Review focus |",
    "|---|---|---|",
    ...(rows.length
      ? rows
      : ["| general | Changed files | Review changed behavior |"]),
  ].join("\n");
}

function fileMatchesSurface(repoPath: string, surface: string): boolean {
  if (surface.startsWith("package:")) {
    return repoPath.startsWith(`packages/${surface.slice("package:".length)}/`);
  }
  if (surface === "api") {
    return repoPath.startsWith("apps/api/");
  }
  if (surface === "cli") {
    return repoPath.startsWith("apps/cli/");
  }
  if (surface === "web") {
    return repoPath.startsWith("apps/web/");
  }
  if (surface === "worker") {
    return repoPath.startsWith("apps/worker/");
  }
  if (surface === "docs") {
    return repoPath.endsWith(".md") || repoPath.startsWith("docs/");
  }
  if (surface === "github-action/workflow") {
    return repoPath === "action.yml" || repoPath.startsWith(".github/");
  }
  if (surface === "fixtures/tests") {
    return repoPath.startsWith("tests/");
  }
  return repoPath.includes(surface);
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderRequiredValidationBlock(review: ReviewResult): string {
  const commands = requiredValidationCommands(review);
  if (commands.length === 0) {
    return "No required validation was inferred.";
  }
  return ["```sh", ...commands, "```"].join("\n");
}

function orderedFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return severityOrder.flatMap((severity) =>
    findings.filter((item) => item.severity === severity),
  );
}

function requiredValidationCommands(review: ReviewResult): string[] {
  const commands = review.expectedValidation
    .map((item) => item.command)
    .filter(isReviewValidationCommand);
  const preferred = [
    "biome check .",
    "tsc -b",
    "vitest run",
    "bun run build",
    "bun run tests/smoke/mvp-demo.ts",
    "bun run tests/smoke/compose-smoke.ts",
  ];
  const selected = preferred.filter(
    (command) =>
      commands.includes(command) ||
      (command === "bun run build" &&
        commands.some((item) => item.includes("bun run --cwd"))),
  );
  for (const command of commands) {
    if (!selected.includes(command) && selected.length < 10) {
      selected.push(command);
    }
  }
  return selected;
}

function isReviewValidationCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    !normalized.includes("--watch") &&
    !normalized.includes(" next dev") &&
    !normalized.includes("bun src/server") &&
    !normalized.includes("format --write") &&
    /(biome check|tsc|typecheck|vitest|bun test|bun run build|smoke|mvp-demo|compose-smoke)/.test(
      normalized,
    )
  );
}

function parseFindingBody(body: string): {
  category: string | null;
  description: string;
  impact: string;
  recommendation: string;
} {
  const category = body.match(/^Category:\s*(.+)$/m)?.[1] ?? null;
  const impact = body.match(
    /^Impact:\s*([\s\S]*?)(?:\nRecommendation:|$)/m,
  )?.[1];
  const recommendation = body.match(/^Recommendation:\s*([\s\S]*)$/m)?.[1];
  const description = body
    .replace(/^Category:.*$/m, "")
    .replace(/^Impact:[\s\S]*$/m, "")
    .trim();
  return {
    category,
    description,
    impact: impact?.trim() ?? "",
    recommendation: recommendation?.trim() ?? "",
  };
}

function renderParagraphList(value: string): string {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");
}

function renderFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) {
    return "No concrete findings.";
  }

  return orderedFindings(findings)
    .map((finding) => {
      const detail = parseFindingBody(finding.body);
      return [
        `#### ${formatSeverity(finding.severity)}: ${finding.title}`,
        "",
        finding.path
          ? `File: \`${finding.path}${finding.line ? `:${finding.line}` : ""}\``
          : "File: not path-specific",
        "",
        detail.category ? `Category: ${detail.category}` : "",
        detail.description,
        "",
        "Impact:",
        detail.impact ? renderParagraphList(detail.impact) : "- Not specified.",
        "",
        "Recommendation:",
        detail.recommendation
          ? renderParagraphList(detail.recommendation)
          : "- Not specified.",
        "",
        "Evidence:",
        renderCitationList(finding.citations),
      ].join("\n");
    })
    .join("\n");
}

function renderAgentFeedbackFinding(
  finding: ReviewFinding,
  index: number,
): string[] {
  const detail = parseFindingBody(finding.body);
  const location = finding.path
    ? `${finding.path}${finding.line ? `:${finding.line}` : ""}`
    : "not path-specific";
  const description =
    detail.description ||
    (detail.category ? `Category: ${detail.category}` : finding.body);
  return [
    `${index + 1}. [${finding.severity.toUpperCase()}] \`${location}\` - ${finding.title}`,
    `Issue: ${description}`,
    `Impact: ${detail.impact || "Not specified."}`,
    `Recommendation: ${detail.recommendation || "Not specified."}`,
    "Evidence:",
    renderCitationList(finding.citations),
    "",
  ];
}

function renderCitationBlock(citations: ReviewEvidenceCitation[]): string {
  if (citations.length === 0) {
    return "";
  }
  return ["", "Evidence:", renderCitationList(citations)].join("\n");
}

function renderCitationList(
  citations: ReviewEvidenceCitation[],
  prefix = "",
): string {
  return citations
    .map((citation) => {
      const location = citation.path ? ` ${citation.path}` : "";
      const excerpt = citation.excerpt ? `: ${citation.excerpt}` : "";
      return `${prefix}- ${citation.source}${location}: ${citation.reason}${excerpt}`;
    })
    .join("\n");
}

function formatSeverity(severity: ReviewSeverity): string {
  return `${severity.charAt(0).toUpperCase()}${severity.slice(1)}`;
}

function formatReadiness(status: ReviewResult["mergeReadiness"]["status"]) {
  return formatSnakeCase(status);
}

function formatSnakeCase(status: string) {
  return status
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const next = [...lines];
  while (next.at(-1) === "") {
    next.pop();
  }
  return next;
}

function shouldRunCommandForSurface(
  command: string,
  changedSurface: string[],
): boolean {
  const normalized = command.toLowerCase();
  if (
    changedSurface.some((surface) => surface.startsWith("package:")) &&
    !normalized.includes("smoke") &&
    /(build|tsc|test|vitest|lint|biome)/.test(normalized)
  ) {
    return true;
  }
  if (changedSurface.includes("cli") && normalized.includes("apps/cli")) {
    return true;
  }
  if (changedSurface.includes("api") && normalized.includes("apps/api")) {
    return true;
  }
  if (changedSurface.includes("web") && normalized.includes("apps/web")) {
    return true;
  }
  if (changedSurface.includes("worker") && normalized.includes("apps/worker")) {
    return true;
  }
  if (
    changedSurface.includes("github-action/workflow") &&
    /(action|lint|test|vitest)/.test(normalized)
  ) {
    return true;
  }
  if (
    changedSurface.includes("docker-compose") &&
    /(compose|docker|smoke)/.test(normalized)
  ) {
    return true;
  }
  if (
    changedSurface.includes("fixtures/tests") &&
    /(test|vitest)/.test(normalized)
  ) {
    return true;
  }
  if (
    changedSurface.includes("config/lockfile") &&
    /(lint|typecheck|build|test|tsc|biome|vitest)/.test(normalized)
  ) {
    return true;
  }
  if (
    changedSurface.includes("generated-context") &&
    /(doctor|context|render|test)/.test(normalized)
  ) {
    return true;
  }
  return false;
}

function extractCommandFromRule(rule: string): string | null {
  const command = rule.match(/`([^`]+)`/)?.[1];
  return command && command.trim().length > 0 ? command : null;
}

function isGeneratedContextPath(path: string, profile: RepoProfile): boolean {
  return (
    path === "AGENTS.md" ||
    path === ".open-maintainer.yml" ||
    path.startsWith(".open-maintainer/") ||
    path.startsWith(".agents/skills/") ||
    profile.generatedFilePaths.includes(path) ||
    profile.generatedFileHints.includes(path)
  );
}

function isDocsPath(path: string): boolean {
  return (
    /^readme(\..*)?$/i.test(path) ||
    /^contributing(\..*)?$/i.test(path) ||
    path.startsWith("docs/") ||
    path.startsWith("local-docs/")
  );
}

function isConfigOrLockPath(path: string, profile: RepoProfile): boolean {
  return (
    profile.lockfiles.includes(path) ||
    profile.configFiles.includes(path) ||
    path.endsWith("package.json") ||
    path.endsWith("tsconfig.json") ||
    path === "biome.json"
  );
}
