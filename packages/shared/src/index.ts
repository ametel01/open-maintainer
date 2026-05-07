import { z } from "zod";

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const EvidenceReferenceSchema = z.object({
  path: z.string(),
  reason: z.string(),
});
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const DetectedCommandSchema = z.object({
  name: z.string(),
  command: z.string(),
  source: z.string(),
});
export type DetectedCommand = z.infer<typeof DetectedCommandSchema>;

export const TrackedFileHashSchema = z.object({
  path: z.string(),
  hash: z.string(),
});
export type TrackedFileHash = z.infer<typeof TrackedFileHashSchema>;

export const RepoProfileSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  version: z.number().int().positive(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  primaryLanguages: z.array(z.string()),
  frameworks: z.array(z.string()),
  packageManager: z.string().nullable(),
  commands: z.array(DetectedCommandSchema),
  ciWorkflows: z.array(z.string()),
  importantDocs: z.array(z.string()),
  repoTemplates: z.array(z.string()).default([]),
  architecturePathGroups: z.array(z.string()),
  generatedFileHints: z.array(z.string()),
  generatedFilePaths: z.array(z.string()).default([]),
  existingContextFiles: z.array(z.string()),
  detectedRiskAreas: z.array(z.string()),
  riskHintPaths: z.array(z.string()).default([]),
  ownershipHints: z.array(z.string()).default([]),
  environmentFiles: z.array(z.string()).default([]),
  environmentVariables: z.array(z.string()).default([]),
  ignoreFiles: z.array(z.string()).default([]),
  testFilePaths: z.array(z.string()).default([]),
  reviewRuleCandidates: z.array(z.string()),
  evidence: z.array(EvidenceReferenceSchema),
  workspaceManifests: z.array(z.string()),
  lockfiles: z.array(z.string()),
  configFiles: z.array(z.string()),
  trackedFileHashes: z.array(TrackedFileHashSchema).default([]),
  contextArtifactHashes: z.array(TrackedFileHashSchema).default([]),
  agentReadiness: z.object({
    score: z.number().int().min(0).max(100),
    categories: z.array(
      z.object({
        name: z.enum([
          "setup clarity",
          "architecture clarity",
          "testing",
          "CI",
          "docs",
          "risk handling",
          "generated-file handling",
          "agent instructions",
        ]),
        score: z.number().int().min(0).max(100),
        maxScore: z.number().int().min(1).max(100),
        missing: z.array(z.string()),
        evidence: z.array(EvidenceReferenceSchema),
      }),
    ),
    missingItems: z.array(z.string()),
    generatedAt: z.string(),
  }),
  createdAt: z.string(),
});
export type RepoProfile = z.infer<typeof RepoProfileSchema>;

const StaticArtifactTypeSchema = z.enum([
  "repo_profile",
  "AGENTS.md",
  "CLAUDE.md",
  ".open-maintainer.yml",
  ".github/copilot-instructions.md",
  ".cursor/rules/open-maintainer.md",
  ".agents/skills/repo-overview/SKILL.md",
  ".agents/skills/testing-workflow/SKILL.md",
  ".agents/skills/pr-review/SKILL.md",
  ".claude/skills/repo-overview/SKILL.md",
  ".claude/skills/testing-workflow/SKILL.md",
  ".claude/skills/pr-review/SKILL.md",
  ".open-maintainer/profile.json",
  ".open-maintainer/report.md",
]);
const SkillArtifactTypeSchema = z
  .string()
  .regex(/^\.(agents|claude)\/skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md$/);
export const ArtifactTypeSchema = z.union([
  StaticArtifactTypeSchema,
  SkillArtifactTypeSchema,
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export type ContextArtifactTarget =
  | "agents"
  | "claude"
  | "copilot"
  | "cursor"
  | "skills"
  | "claude-skills"
  | "profile"
  | "report"
  | "config";

export type ContextArtifactPreset = "codex" | "claude" | "both";

export const availableContextArtifactTargets = [
  "agents",
  "claude",
  "copilot",
  "cursor",
  "skills",
  "claude-skills",
  "profile",
  "report",
  "config",
] as const satisfies readonly ContextArtifactTarget[];

export const defaultContextArtifactTargets = [
  "agents",
  "skills",
  "profile",
  "report",
  "config",
] as const satisfies readonly ContextArtifactTarget[];

export const requiredContextArtifactHints = [
  "AGENTS.md",
  ".agents/skills/<repo>-start-task/SKILL.md",
  ".agents/skills/<repo>-testing-workflow/SKILL.md",
  ".agents/skills/<repo>-pr-review/SKILL.md",
  ".open-maintainer/profile.json",
  ".open-maintainer/report.md",
  ".open-maintainer.yml",
] as const;

export const optionalContextArtifactHints = [
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ".cursor/rules/open-maintainer.md",
  ".claude/skills/<repo>-start-task/SKILL.md",
  ".claude/skills/<repo>-testing-workflow/SKILL.md",
  ".claude/skills/<repo>-pr-review/SKILL.md",
] as const;

export const recognizedContextArtifactHints = [
  ...requiredContextArtifactHints,
  ...optionalContextArtifactHints,
] as const;

export type WritableContextArtifact = {
  artifact: GeneratedArtifact;
  path: string;
};

export function contextArtifactSlug(value: string): string {
  let slug = "";
  let needsSeparator = false;

  for (const character of value.toLowerCase()) {
    const isAsciiLetter = character >= "a" && character <= "z";
    const isDigit = character >= "0" && character <= "9";
    if (isAsciiLetter || isDigit) {
      if (needsSeparator && slug.length > 0) {
        slug += "-";
      }
      slug += character;
      needsSeparator = false;
    } else {
      needsSeparator = slug.length > 0;
    }
  }

  return slug || "repo";
}

export function expectedContextArtifactTypes(input: {
  repoName: string;
  targets?: readonly ContextArtifactTarget[];
}): ArtifactType[] {
  const targets = new Set(input.targets ?? defaultContextArtifactTargets);
  const repoSlug = contextArtifactSlug(input.repoName);
  const types: ArtifactType[] = [];
  if (targets.has("agents")) {
    types.push("AGENTS.md");
  }
  if (targets.has("claude")) {
    types.push("CLAUDE.md");
  }
  if (targets.has("config")) {
    types.push(".open-maintainer.yml");
  }
  if (targets.has("copilot")) {
    types.push(".github/copilot-instructions.md");
  }
  if (targets.has("cursor")) {
    types.push(".cursor/rules/open-maintainer.md");
  }
  if (targets.has("skills")) {
    types.push(
      ArtifactTypeSchema.parse(
        `.agents/skills/${repoSlug}-start-task/SKILL.md`,
      ),
      ArtifactTypeSchema.parse(
        `.agents/skills/${repoSlug}-testing-workflow/SKILL.md`,
      ),
      ArtifactTypeSchema.parse(`.agents/skills/${repoSlug}-pr-review/SKILL.md`),
    );
  }
  if (targets.has("claude-skills")) {
    types.push(
      ArtifactTypeSchema.parse(
        `.claude/skills/${repoSlug}-start-task/SKILL.md`,
      ),
      ArtifactTypeSchema.parse(
        `.claude/skills/${repoSlug}-testing-workflow/SKILL.md`,
      ),
      ArtifactTypeSchema.parse(`.claude/skills/${repoSlug}-pr-review/SKILL.md`),
    );
  }
  if (targets.has("profile")) {
    types.push(".open-maintainer/profile.json");
  }
  if (targets.has("report")) {
    types.push(".open-maintainer/report.md");
  }
  return types;
}

export function contextArtifactPath(type: ArtifactType): string | null {
  return type === "repo_profile" ? null : type;
}

export function contextArtifactPathOrSelf(type: ArtifactType): string {
  return contextArtifactPath(type) ?? type;
}

export function contextArtifactPathsForTargets(input: {
  repoName: string;
  targets: readonly ContextArtifactTarget[];
}): string[] {
  return expectedContextArtifactTypes(input).map(contextArtifactPathOrSelf);
}

export function isContextArtifactPath(path: string): boolean {
  const parsed = ArtifactTypeSchema.safeParse(path);
  return parsed.success && parsed.data !== "repo_profile";
}

export function isWritableContextArtifactType(type: ArtifactType): boolean {
  return contextArtifactPath(type) !== null;
}

export function selectWritableContextArtifacts(
  artifacts: readonly GeneratedArtifact[],
): WritableContextArtifact[] {
  return artifacts.flatMap((artifact) => {
    const path = contextArtifactPath(artifact.type);
    return path ? [{ artifact, path }] : [];
  });
}

export function isOpenMaintainerGeneratedContent(content: string): boolean {
  return (
    content.includes("generated by open-maintainer") ||
    content.includes("by: open-maintainer") ||
    content.includes("artifactVersion:") ||
    content.includes('"openMaintainerProfileHash"') ||
    content.includes("# Open Maintainer Readiness Report") ||
    content.includes("# Open Maintainer Report:")
  );
}

export function contextArtifactTargetsForSelection(input: {
  context: ContextArtifactPreset;
  skills: ContextArtifactPreset;
}): ContextArtifactTarget[] {
  const targets: ContextArtifactTarget[] = [];
  if (input.context === "codex" || input.context === "both") {
    targets.push("agents");
  }
  if (input.context === "claude" || input.context === "both") {
    targets.push("claude");
  }
  if (input.skills === "codex" || input.skills === "both") {
    targets.push("skills");
  }
  if (input.skills === "claude" || input.skills === "both") {
    targets.push("claude-skills");
  }
  targets.push("profile", "report", "config");
  return targets;
}

export function defaultContextArtifactPresetForProviderKind(
  providerKind: string,
): ContextArtifactPreset {
  return providerKind === "claude-cli" ? "claude" : "codex";
}

export function obsoleteGeneratedContextArtifactPaths(input: {
  generatedPaths: Set<string>;
  artifactPaths: Set<string>;
  targets: readonly ContextArtifactTarget[];
}): string[] {
  const targetRoots = new Set<string>();
  if (input.targets.includes("skills")) {
    targetRoots.add(".agents/skills/");
  }
  if (input.targets.includes("claude-skills")) {
    targetRoots.add(".claude/skills/");
  }
  if (targetRoots.size === 0) {
    return [];
  }
  return [...input.generatedPaths]
    .filter((generatedPath) =>
      [...targetRoots].some((root) => generatedPath.startsWith(root)),
    )
    .filter((generatedPath) => !input.artifactPaths.has(generatedPath))
    .sort();
}

export const GeneratedArtifactSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  type: ArtifactTypeSchema,
  version: z.number().int().positive(),
  content: z.string(),
  sourceProfileVersion: z.number().int().positive(),
  modelProvider: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: z.string(),
});
export type GeneratedArtifact = z.infer<typeof GeneratedArtifactSchema>;

export type RepositoryIgnoreRule = {
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  anchored: boolean;
};

export type RepositoryIgnoreFile = {
  path: string;
  content: string;
};

export type RepositoryIgnoreDecision = {
  ignored: boolean;
  matched: boolean;
};

export const repositoryIgnoreFileNames = [
  ".gitignore",
  ".open-maintainerignore",
] as const;

export function parseRepositoryIgnoreFile(
  content: string,
): RepositoryIgnoreRule[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!");
      const rawPattern = negated ? line.slice(1) : line;
      const anchored = rawPattern.startsWith("/");
      const directoryOnly = rawPattern.endsWith("/");
      const pattern = normalizeRepositoryPath(rawPattern)
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");
      return { pattern, negated, directoryOnly, anchored };
    })
    .filter((rule) => rule.pattern.length > 0);
}

export function buildRepositoryIgnoreRules(
  files: readonly RepositoryIgnoreFile[],
): RepositoryIgnoreRule[] {
  return files.flatMap((file) => parseRepositoryIgnoreFile(file.content));
}

export function getRepositoryIgnoreDecision(
  repoPath: string,
  rules: readonly RepositoryIgnoreRule[],
): RepositoryIgnoreDecision {
  const normalizedPath = normalizeRepositoryPath(repoPath).replace(/^\/+/, "");
  if (!normalizedPath) {
    return { ignored: false, matched: false };
  }
  let ignored = false;
  let matched = false;
  for (const rule of rules) {
    if (repositoryIgnoreRuleMatches(normalizedPath, rule)) {
      ignored = !rule.negated;
      matched = true;
    }
  }
  return { ignored, matched };
}

export function isRepositoryPathIgnored(
  repoPath: string,
  rules: readonly RepositoryIgnoreRule[],
): boolean {
  return getRepositoryIgnoreDecision(repoPath, rules).ignored;
}

function repositoryIgnoreRuleMatches(
  repoPath: string,
  rule: RepositoryIgnoreRule,
): boolean {
  const pattern = rule.pattern;
  if (!pattern.includes("/")) {
    return repoPath.split("/").some((part) => globMatch(pattern, part));
  }

  const candidates = rule.anchored
    ? [repoPath]
    : repoPath
        .split("/")
        .map((_, index, parts) => parts.slice(index).join("/"));
  return candidates.some((candidate) =>
    rule.directoryOnly
      ? globMatch(pattern, candidate) || globMatch(`${pattern}/**`, candidate)
      : globMatch(pattern, candidate),
  );
}

function globMatch(pattern: string, value: string): boolean {
  const regex = new RegExp(`^${globPatternToRegex(pattern)}$`);
  return regex.test(value);
}

function globPatternToRegex(pattern: string): string {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (character === "*" && next === "*" && afterNext === "/") {
      output += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (character === "*" && next === "*") {
      output += ".*";
      index += 1;
      continue;
    }
    if (character === "*") {
      output += "[^/]*";
      continue;
    }
    if (character === "?") {
      output += "[^/]";
      continue;
    }
    output += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return output;
}

function normalizeRepositoryPath(repoPath: string): string {
  return repoPath.replaceAll("\\", "/");
}

export const repositoryUploadLimits = {
  maxFiles: 800,
  maxFileBytes: 128_000,
  maxTotalBytes: 8_000_000,
  maxRequestBodyBytes: 10_485_760,
  maxPathLength: 1_000,
  maxNameLength: 120,
} as const;

export const repositoryUploadIgnoredPathParts = [
  ".git",
  ".next",
  ".turbo",
  ".cache",
  ".vercel",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "out",
  "target",
  "vendor",
] as const;

export const repositoryUploadReadableExtensions = [
  ".cairo",
  ".css",
  ".go",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".lock",
  ".md",
  ".nr",
  ".rs",
  ".sol",
  ".sum",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
] as const;

export const repositoryUploadReadableNames = [
  ".env.example",
  ".gitignore",
  ".open-maintainerignore",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Dockerfile",
  "go.sum",
  "Makefile",
  "package-lock.json",
  "pnpm-lock.yaml",
  "README",
  "Scarb.lock",
  "uv.lock",
  "yarn.lock",
] as const;

export const RepositoryUploadFileSchema = z.object({
  path: z.string().min(1).max(repositoryUploadLimits.maxPathLength),
  content: z.string().max(repositoryUploadLimits.maxFileBytes),
});
export type RepositoryUploadFile = z.infer<typeof RepositoryUploadFileSchema>;

export const RepositoryUploadRequestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(repositoryUploadLimits.maxNameLength)
      .optional(),
    files: z
      .array(RepositoryUploadFileSchema)
      .min(1)
      .max(repositoryUploadLimits.maxFiles),
  })
  .superRefine((request, context) => {
    const totalBytes = request.files.reduce(
      (sum, file) => sum + file.content.length,
      0,
    );
    if (totalBytes > repositoryUploadLimits.maxTotalBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: "Repository upload payload is too large.",
      });
    }
  });
export type RepositoryUploadRequest = z.infer<
  typeof RepositoryUploadRequestSchema
>;

export function shouldAlwaysSkipRepositoryUploadPath(
  repoPath: string,
): boolean {
  const ignoredParts = new Set<string>(repositoryUploadIgnoredPathParts);
  return repoPath
    .split("/")
    .some((part) => ignoredParts.has(part) || part.endsWith(".tsbuildinfo"));
}

export function shouldReadRepositoryUploadPath(repoPath: string): boolean {
  const fileName = repoPath.split("/").at(-1) ?? "";
  const readableNames = new Set<string>(repositoryUploadReadableNames);
  if (
    readableNames.has(fileName) ||
    readableNames.has(fileName.split(".")[0] ?? "")
  ) {
    return true;
  }
  const readableExtensions = new Set<string>(
    repositoryUploadReadableExtensions,
  );
  const extensionStart = fileName.lastIndexOf(".");
  const extension =
    extensionStart >= 0 ? fileName.slice(extensionStart).toLowerCase() : "";
  return readableExtensions.has(extension);
}

export const RunRecordSchema = z.object({
  id: z.string(),
  repoId: z.string().nullable(),
  type: z.enum([
    "analysis",
    "generation",
    "ai",
    "webhook",
    "context_pr",
    "review",
    "worker",
  ]),
  status: RunStatusSchema,
  inputSummary: z.string(),
  safeMessage: z.string().nullable(),
  artifactVersions: z.array(z.number()),
  repoProfileVersion: z.number().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  externalId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const InstallationSchema = z.object({
  id: z.string(),
  accountLogin: z.string(),
  accountType: z.string(),
  repositorySelection: z.string(),
  permissions: z.record(z.string()),
  createdAt: z.string(),
});
export type Installation = z.infer<typeof InstallationSchema>;

export const RepoSchema = z.object({
  id: z.string(),
  installationId: z.string(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
  permissions: z.record(z.boolean()).default({}),
});
export type Repo = z.infer<typeof RepoSchema>;

export const ModelProviderKindSchema = z.enum([
  "openai-compatible",
  "anthropic",
  "local-openai-compatible",
  "codex-cli",
  "claude-cli",
]);
export type ModelProviderKind = z.infer<typeof ModelProviderKindSchema>;

export const ModelProviderConfigSchema = z.object({
  id: z.string(),
  kind: ModelProviderKindSchema,
  displayName: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  encryptedApiKey: z.string(),
  repoContentConsent: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ModelProviderConfig = z.infer<typeof ModelProviderConfigSchema>;

export const ContextPrSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  branchName: z.string(),
  commitSha: z.string().nullable(),
  prNumber: z.number().nullable(),
  prUrl: z.string().url().nullable(),
  artifactVersions: z.array(z.number()),
  status: RunStatusSchema,
  createdAt: z.string(),
});
export type ContextPr = z.infer<typeof ContextPrSchema>;

export const ReviewSeveritySchema = z.enum([
  "blocker",
  "major",
  "minor",
  "note",
]);
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

export const ReviewEvidenceSourceSchema = z.enum([
  "repo_profile",
  "open_maintainer_config",
  "generated_context",
  "repo_skill",
  "changed_file",
  "ci_status",
  "issue_acceptance_criteria",
  "user_input",
]);
export type ReviewEvidenceSource = z.infer<typeof ReviewEvidenceSourceSchema>;

export const ReviewEvidenceCitationSchema = z.object({
  source: ReviewEvidenceSourceSchema,
  path: z.string().nullable(),
  excerpt: z.string().nullable(),
  reason: z.string().min(1),
});
export type ReviewEvidenceCitation = z.infer<
  typeof ReviewEvidenceCitationSchema
>;

export const ReviewChangedFileSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "removed", "renamed", "copied"]),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  patch: z.string().nullable(),
  previousPath: z.string().nullable(),
});
export type ReviewChangedFile = z.infer<typeof ReviewChangedFileSchema>;

export const ReviewSkippedFileSchema = z.object({
  path: z.string().min(1),
  reason: z.enum([
    "filtered",
    "max_files",
    "max_file_bytes",
    "max_total_bytes",
    "not_file",
    "not_found",
    "binary",
    "unavailable",
  ]),
});
export type ReviewSkippedFile = z.infer<typeof ReviewSkippedFileSchema>;

export const ReviewCheckStatusSchema = z.object({
  name: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().nullable(),
  url: z.string().url().nullable(),
});
export type ReviewCheckStatus = z.infer<typeof ReviewCheckStatusSchema>;

export const ReviewIssueContextSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string(),
  acceptanceCriteria: z.array(z.string().min(1)),
  url: z.string().url().nullable(),
});
export type ReviewIssueContext = z.infer<typeof ReviewIssueContextSchema>;

export const ReviewExistingCommentSchema = z.object({
  id: z.number().int().positive(),
  kind: z.enum(["summary", "inline"]),
  body: z.string(),
  path: z.string().nullable(),
  line: z.number().int().positive().nullable(),
});
export type ReviewExistingComment = z.infer<typeof ReviewExistingCommentSchema>;

export const ReviewValidationExpectationSchema = z.object({
  command: z.string().min(1),
  reason: z.string().min(1),
  evidence: z.array(ReviewEvidenceCitationSchema).min(1),
});
export type ReviewValidationExpectation = z.infer<
  typeof ReviewValidationExpectationSchema
>;

export const ReviewDocsImpactSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
  required: z.boolean(),
  evidence: z.array(ReviewEvidenceCitationSchema).min(1),
});
export type ReviewDocsImpact = z.infer<typeof ReviewDocsImpactSchema>;

export const ReviewFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: ReviewSeveritySchema,
  body: z.string().min(1),
  path: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  citations: z.array(ReviewEvidenceCitationSchema).min(1),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewMergeReadinessSchema = z.object({
  status: z.enum(["ready", "needs_attention", "blocked", "unknown"]),
  reason: z.string().min(1),
  evidence: z.array(ReviewEvidenceCitationSchema).default([]),
});
export type ReviewMergeReadiness = z.infer<typeof ReviewMergeReadinessSchema>;

export const ReviewContributionTriageCategorySchema = z.enum([
  "ready_for_review",
  "needs_author_input",
  "needs_maintainer_design",
  "not_agent_ready",
  "possible_spam",
]);
export type ReviewContributionTriageCategory = z.infer<
  typeof ReviewContributionTriageCategorySchema
>;

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

export const ReviewContributionTriageSchema = z
  .object({
    status: z.enum(["evaluated", "not_evaluated"]),
    category: ReviewContributionTriageCategorySchema.nullable(),
    recommendation: z.string().min(1),
    evidence: z.array(ReviewEvidenceCitationSchema),
    missingInformation: z.array(z.string().min(1)),
    requiredActions: z.array(z.string().min(1)),
  })
  .superRefine((value, context) => {
    if (value.status === "evaluated") {
      if (!value.category) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["category"],
          message: "evaluated contribution triage requires a category",
        });
      }
      if (value.evidence.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence"],
          message: "evaluated contribution triage requires cited evidence",
        });
      }
    }
    if (value.status === "not_evaluated" && value.category !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["category"],
        message: "not_evaluated contribution triage cannot include a category",
      });
    }
  });
export type ReviewContributionTriage = z.infer<
  typeof ReviewContributionTriageSchema
>;

export const NotEvaluatedContributionTriage: ReviewContributionTriage = {
  status: "not_evaluated",
  category: null,
  recommendation: "Contribution triage was not evaluated.",
  evidence: [],
  missingInformation: [],
  requiredActions: [],
};

export const ReviewFeedbackSchema = z.object({
  findingId: z.string().min(1),
  verdict: z.enum([
    "false_positive",
    "accepted",
    "needs_more_context",
    "unclear",
  ]),
  reason: z.string().nullable(),
  actor: z.string().nullable(),
  createdAt: z.string(),
});
export type ReviewFeedback = z.infer<typeof ReviewFeedbackSchema>;

export const ReviewResultSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  prNumber: z.number().int().positive().nullable(),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  summary: z.string().min(1),
  walkthrough: z.array(z.string().min(1)),
  changedSurface: z.array(z.string().min(1)),
  riskAnalysis: z.array(z.string().min(1)),
  expectedValidation: z.array(ReviewValidationExpectationSchema),
  validationEvidence: z.array(z.string().min(1)),
  docsImpact: z.array(ReviewDocsImpactSchema),
  contributionTriage: ReviewContributionTriageSchema.default(
    NotEvaluatedContributionTriage,
  ),
  findings: z.array(ReviewFindingSchema),
  mergeReadiness: ReviewMergeReadinessSchema,
  residualRisk: z.array(z.string().min(1)),
  changedFiles: z.array(ReviewChangedFileSchema),
  feedback: z.array(ReviewFeedbackSchema).default([]),
  modelProvider: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: z.string(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const ReviewInputSchema = z.object({
  repoId: z.string(),
  owner: z.string(),
  repo: z.string(),
  prNumber: z.number().int().positive().nullable(),
  title: z.string().nullable(),
  body: z.string(),
  url: z.string().url().nullable(),
  author: z.string().nullable(),
  isDraft: z.boolean().nullable().default(null),
  mergeable: z.string().nullable().default(null),
  mergeStateStatus: z.string().nullable().default(null),
  reviewDecision: z.string().nullable().default(null),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  changedFiles: z.array(ReviewChangedFileSchema),
  commits: z.array(z.string().min(1)),
  checkStatuses: z.array(ReviewCheckStatusSchema),
  issueContext: z.array(ReviewIssueContextSchema),
  existingComments: z.array(ReviewExistingCommentSchema),
  skippedFiles: z.array(ReviewSkippedFileSchema),
  createdAt: z.string(),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

export const PullRequestAttentionSchema = z.enum([
  "none",
  "draft",
  "checks_failed",
  "changes_requested",
  "review_required",
  "conflicts",
]);
export type PullRequestAttention = z.infer<typeof PullRequestAttentionSchema>;

export const PullRequestCheckSummarySchema = z.object({
  total: z.number().int().min(0),
  passing: z.number().int().min(0),
  failing: z.number().int().min(0),
  pending: z.number().int().min(0),
  skipped: z.number().int().min(0),
});
export type PullRequestCheckSummary = z.infer<
  typeof PullRequestCheckSummarySchema
>;

export const PullRequestTriageTagIdSchema = z.enum([
  "llm_authored",
  "generated_context",
]);
export type PullRequestTriageTagId = z.infer<
  typeof PullRequestTriageTagIdSchema
>;

export const PullRequestTriageTagSchema = z.object({
  id: PullRequestTriageTagIdSchema,
  githubLabel: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
});
export type PullRequestTriageTag = z.infer<typeof PullRequestTriageTagSchema>;

export const PullRequestListItemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  bodyPreview: z.string(),
  url: z.string().url().nullable(),
  author: z.string().nullable(),
  state: z.enum(["open", "closed", "merged"]),
  isDraft: z.boolean().nullable(),
  labels: z.array(z.string().min(1)),
  reviewers: z.array(z.string().min(1)),
  assignees: z.array(z.string().min(1)),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  headSha: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  comments: z.number().int().min(0),
  reviewComments: z.number().int().min(0),
  commits: z.number().int().min(0),
  changedFiles: z.number().int().min(0),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  reviewDecision: z.string().nullable(),
  mergeable: z.string().nullable(),
  mergeStateStatus: z.string().nullable(),
  checksSummary: PullRequestCheckSummarySchema,
  attention: PullRequestAttentionSchema,
  unread: z.boolean(),
  triageTags: z.array(PullRequestTriageTagSchema).default([]),
});
export type PullRequestListItem = z.infer<typeof PullRequestListItemSchema>;

export function inferPullRequestTriageTags(input: {
  author?: string | null;
  body?: string | null;
  files?: Array<{ path: string }> | null;
  headRef?: string | null;
  labels?: readonly string[];
  title?: string | null;
}): PullRequestTriageTag[] {
  const labels = input.labels ?? [];
  const text = [
    input.author,
    input.title,
    input.body,
    input.headRef,
    labels.join(" "),
  ]
    .filter((item): item is string => Boolean(item))
    .join("\n")
    .toLowerCase();
  const generatedContext =
    isOpenMaintainerContextText(text) ||
    (input.files ?? []).some((file) =>
      isOpenMaintainerContextArtifactPath(file.path),
    );
  const llmAuthored = generatedContext || hasLlmAuthorshipSignal(text);
  const tags: PullRequestTriageTag[] = [];
  if (llmAuthored) {
    tags.push({
      id: "llm_authored",
      githubLabel: "open-maintainer/llm-authored",
      label: "LLM-authored",
      description:
        "Open Maintainer detected an AI or agent authorship signal on this PR.",
    });
  }
  if (generatedContext) {
    tags.push({
      id: "generated_context",
      githubLabel: "open-maintainer/context-update",
      label: "Context update",
      description:
        "This PR appears to update generated repository context artifacts.",
    });
  }
  return tags;
}

function hasLlmAuthorshipSignal(text: string): boolean {
  return [
    /\bllm\b/,
    /\bai[- ]generated\b/,
    /\bagent[- ]generated\b/,
    /\bcodex\b/,
    /\bclaude\b/,
    /\bcopilot\b/,
    /\bcursor\b/,
    /\bdevin\b/,
    /\bsweep\b/,
    /\baider\b/,
    /\bopenhands\b/,
    /\bopenai\b/,
    /\bgpt[-_ ]?\d*\b/,
    /generated by (openai|codex|claude|cursor|copilot)/,
    /co-authored-by:.*(codex|claude|copilot|cursor|openai)/,
  ].some((pattern) => pattern.test(text));
}

function isOpenMaintainerContextText(text: string): boolean {
  return (
    text.includes("open maintainer context update") ||
    text.includes("open maintainer context refresh") ||
    text.includes("generated open maintainer context artifacts") ||
    text.includes("open-maintainer/context-")
  );
}

function isOpenMaintainerContextArtifactPath(path: string): boolean {
  return (
    path === "AGENTS.md" ||
    path === "CLAUDE.md" ||
    path === ".open-maintainer.yml" ||
    path.startsWith(".agents/skills/") ||
    path.startsWith(".claude/skills/")
  );
}

export const PullRequestCommitSchema = z.object({
  sha: z.string().min(1),
  message: z.string().nullable(),
  author: z.string().nullable(),
  authoredAt: z.string().nullable(),
  url: z.string().url().nullable(),
});
export type PullRequestCommit = z.infer<typeof PullRequestCommitSchema>;

export const PullRequestTimelineItemSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["opened", "comment", "review", "review_comment"]),
  author: z.string().nullable(),
  body: z.string(),
  state: z.string().nullable(),
  path: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  url: z.string().url().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type PullRequestTimelineItem = z.infer<
  typeof PullRequestTimelineItemSchema
>;

export const PullRequestDetailSchema = z.object({
  summary: PullRequestListItemSchema,
  body: z.string(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  mergeable: z.string().nullable(),
  mergeStateStatus: z.string().nullable(),
  reviewDecision: z.string().nullable(),
  files: z.array(ReviewChangedFileSchema),
  skippedFiles: z.array(ReviewSkippedFileSchema),
  commits: z.array(PullRequestCommitSchema),
  timeline: z.array(PullRequestTimelineItemSchema),
  checks: z.array(ReviewCheckStatusSchema),
});
export type PullRequestDetail = z.infer<typeof PullRequestDetailSchema>;

export const IssueTriageClassificationSchema = z.enum([
  "ready_for_maintainer_review",
  "needs_author_input",
  "needs_human_design",
  "not_actionable",
  "possible_duplicate",
  "possibly_spam",
]);
export type IssueTriageClassification = z.infer<
  typeof IssueTriageClassificationSchema
>;

export const IssueTriageAgentReadinessSchema = z.enum([
  "agent_ready",
  "not_agent_ready",
  "needs_human_design",
]);
export type IssueTriageAgentReadiness = z.infer<
  typeof IssueTriageAgentReadinessSchema
>;

export const IssueTriageSignalSchema = z.enum([
  "needs_author_input",
  "missing_reproduction",
  "missing_expected_actual",
  "missing_environment",
  "possible_duplicate",
  "possibly_spam",
  "not_actionable",
  "needs_human_design",
  "ready_for_maintainer_review",
  "agent_ready",
  "not_agent_ready",
  "bug_report",
  "feature_request",
  "question",
  "documentation",
  "security_claim_needs_poc",
]);
export type IssueTriageSignal = z.infer<typeof IssueTriageSignalSchema>;

export const IssueTriageLabelIntentSchema = IssueTriageSignalSchema;
export type IssueTriageLabelIntent = IssueTriageSignal;

export const DefaultIssueTriageLabelMappings = {
  needs_author_input: "needs-author-input",
  missing_reproduction: "needs-reproduction",
  missing_expected_actual: "needs-expected-actual",
  missing_environment: "needs-environment",
  possible_duplicate: "possibly-duplicate",
  possibly_spam: "possibly-spam",
  not_actionable: "not-actionable",
  needs_human_design: "needs-human-design",
  ready_for_maintainer_review: "ready-for-maintainer-review",
  agent_ready: "open-maintainer/agent-ready",
  not_agent_ready: "open-maintainer/not-agent-ready",
  bug_report: "bug",
  feature_request: "enhancement",
  question: "question",
  documentation: "documentation",
  security_claim_needs_poc: "security-claim-needs-poc",
} as const satisfies Record<IssueTriageSignal, string>;

export const DefaultIssueTriageLabelDefinitions = {
  needs_author_input: {
    name: "needs-author-input",
    color: "D4C5F9",
    description:
      "Issue needs more information from the author before maintainers can act.",
  },
  missing_reproduction: {
    name: "needs-reproduction",
    color: "D4C5F9",
    description:
      "Bug report needs reproduction steps or a minimal reproduction.",
  },
  missing_expected_actual: {
    name: "needs-expected-actual",
    color: "D4C5F9",
    description: "Issue needs expected and actual behavior.",
  },
  missing_environment: {
    name: "needs-environment",
    color: "D4C5F9",
    description:
      "Issue needs environment, version, platform, or commit details.",
  },
  possible_duplicate: {
    name: "possibly-duplicate",
    color: "CFD3D7",
    description: "Issue may duplicate an existing issue.",
  },
  possibly_spam: {
    name: "possibly-spam",
    color: "B60205",
    description:
      "Issue appears promotional, irrelevant, bot-like, or non-actionable.",
  },
  not_actionable: {
    name: "not-actionable",
    color: "B60205",
    description:
      "Issue lacks enough actionable content for maintainers to proceed.",
  },
  needs_human_design: {
    name: "needs-human-design",
    color: "FBCA04",
    description:
      "Issue requires maintainer/product design before implementation.",
  },
  ready_for_maintainer_review: {
    name: "ready-for-maintainer-review",
    color: "0E8A16",
    description: "Issue appears sufficiently clear for maintainer review.",
  },
  agent_ready: {
    name: "agent-ready",
    color: "0E8A16",
    description:
      "Issue appears scoped and clear enough for an AI coding agent.",
  },
  not_agent_ready: {
    name: "not-agent-ready",
    color: "BFDADC",
    description:
      "Issue is not suitable for an AI coding agent without more context.",
  },
  bug_report: {
    name: "bug",
    color: "D73A4A",
    description: "Issue reports a bug.",
  },
  feature_request: {
    name: "enhancement",
    color: "A2EEEF",
    description: "Issue requests a feature or improvement.",
  },
  question: {
    name: "question",
    color: "D876E3",
    description: "Issue is primarily a question.",
  },
  documentation: {
    name: "documentation",
    color: "0075CA",
    description: "Issue relates to documentation.",
  },
  security_claim_needs_poc: {
    name: "security-claim-needs-poc",
    color: "B60205",
    description:
      "Security-like issue needs affected surface, proof of concept, or exploit path.",
  },
} as const satisfies Record<
  IssueTriageSignal,
  { name: string; color: string; description: string }
>;

export const IssueTriageEvidenceSourceSchema = z.enum([
  "github_issue",
  "github_comment",
  "issue_template",
  "repo_profile",
  "open_maintainer_config",
  "generated_context",
  "related_issue",
  "referenced_file",
  "maintainer_input",
]);
export type IssueTriageEvidenceSource = z.infer<
  typeof IssueTriageEvidenceSourceSchema
>;

export const IssueTriageEvidenceCitationSchema = z.object({
  source: IssueTriageEvidenceSourceSchema,
  path: z.string().min(1).nullable(),
  url: z.string().url().nullable(),
  excerpt: z.string().min(1).nullable(),
  reason: z.string().min(1),
});
export type IssueTriageEvidenceCitation = z.infer<
  typeof IssueTriageEvidenceCitationSchema
>;

export const IssueTriageSkippedEvidenceSchema = z.object({
  source: IssueTriageEvidenceSourceSchema,
  reason: z.string().min(1),
});
export type IssueTriageSkippedEvidence = z.infer<
  typeof IssueTriageSkippedEvidenceSchema
>;

export const IssueTriageIssueMetadataSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string(),
  author: z.string().nullable(),
  labels: z.array(z.string().min(1)),
  state: z.enum(["open", "closed"]),
  url: z.string().url().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IssueTriageIssueMetadata = z.infer<
  typeof IssueTriageIssueMetadataSchema
>;

export const IssueTriageRelatedIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().url().nullable(),
  reason: z.string().min(1),
});
export type IssueTriageRelatedIssue = z.infer<
  typeof IssueTriageRelatedIssueSchema
>;

export const IssueTriageEvidenceSchema = z.object({
  issue: IssueTriageIssueMetadataSchema,
  repoId: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  sourceProfileVersion: z.number().int().positive().nullable(),
  contextArtifactVersion: z.number().int().positive().nullable(),
  templateHints: z.array(z.string().min(1)),
  acceptanceCriteriaCandidates: z.array(z.string().min(1)),
  referencedSurfaces: z.array(z.string().min(1)),
  relatedIssues: z.array(IssueTriageRelatedIssueSchema),
  citations: z.array(IssueTriageEvidenceCitationSchema),
  skippedEvidence: z.array(IssueTriageSkippedEvidenceSchema),
});
export type IssueTriageEvidence = z.infer<typeof IssueTriageEvidenceSchema>;

export const IssueTriageInputSchema = z.object({
  repoId: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  issueNumber: z.number().int().positive(),
  evidence: IssueTriageEvidenceSchema,
  modelProvider: z.string().min(1),
  model: z.string().min(1),
  consentMode: z.literal("explicit_repository_content_transfer"),
  createdAt: z.string(),
});
export type IssueTriageInput = z.infer<typeof IssueTriageInputSchema>;

export const IssueTriageCommentPreviewSchema = z.object({
  marker: z.string().min(1),
  summary: z.string().min(1),
  body: z.string().min(1),
  artifactPath: z.string().min(1).nullable(),
});
export type IssueTriageCommentPreview = z.infer<
  typeof IssueTriageCommentPreviewSchema
>;

export const IssueTriageWriteActionSchema = z.object({
  type: z.enum([
    "apply_label",
    "create_label",
    "post_comment",
    "update_comment",
    "close_issue",
  ]),
  status: z.enum(["skipped", "planned", "applied", "failed"]),
  target: z.string().min(1).nullable(),
  reason: z.string().min(1),
});
export type IssueTriageWriteAction = z.infer<
  typeof IssueTriageWriteActionSchema
>;

export const IssueTriageTaskBriefSchema = z.object({
  status: z.enum(["not_generated", "generated", "skipped"]),
  goal: z.string().min(1).nullable(),
  userVisibleBehavior: z.array(z.string().min(1)),
  readFirst: z.array(z.string().min(1)),
  likelyFiles: z.array(z.string().min(1)),
  constraints: z.array(z.string().min(1)),
  safetyNotes: z.array(z.string().min(1)),
  validationCommands: z.array(DetectedCommandSchema),
  doneCriteria: z.array(z.string().min(1)),
  escalationRisks: z.array(z.string().min(1)),
  markdown: z.string().min(1).nullable(),
});
export type IssueTriageTaskBrief = z.infer<typeof IssueTriageTaskBriefSchema>;

export const IssueTriageMissingInfoSchema = z.enum([
  "reproduction_steps",
  "expected_behavior",
  "actual_behavior",
  "environment",
  "logs_or_error",
  "affected_version",
  "acceptance_criteria",
  "affected_files_or_commands",
  "proof_of_concept",
]);
export type IssueTriageMissingInfo = z.infer<
  typeof IssueTriageMissingInfoSchema
>;

export const IssueTriageModelEvidenceSchema = z
  .object({
    signal: IssueTriageSignalSchema,
    issueTextQuote: z.string().min(1).nullable().default(null),
    reason: z.string().min(1),
  })
  .strict();
export type IssueTriageModelEvidence = z.infer<
  typeof IssueTriageModelEvidenceSchema
>;

export const IssueTriagePossibleDuplicateSchema = z
  .object({
    issueNumber: z.number().int().positive(),
    reason: z.string().min(1),
  })
  .strict();
export type IssueTriagePossibleDuplicate = z.infer<
  typeof IssueTriagePossibleDuplicateSchema
>;

export const IssueTriageResolvedLabelSchema = z
  .object({
    signal: IssueTriageSignalSchema,
    label: z.string().min(1),
    source: z.enum([
      "config",
      "upstream_exact",
      "upstream_alias",
      "preset",
      "none",
    ]),
    shouldCreate: z.boolean(),
    color: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
  })
  .strict();
export type IssueTriageResolvedLabel = z.infer<
  typeof IssueTriageResolvedLabelSchema
>;

export const IssueTriageModelResultSchema = z
  .object({
    classification: IssueTriageClassificationSchema,
    qualityScore: z.number().int().min(0).max(100),
    spamRisk: z.enum(["low", "medium", "high"]),
    agentReadiness: IssueTriageAgentReadinessSchema,
    signals: z.array(IssueTriageSignalSchema),
    confidence: z.number().min(0).max(1),
    evidence: z.array(IssueTriageModelEvidenceSchema).min(1),
    missingInfo: z.array(IssueTriageMissingInfoSchema),
    possibleDuplicates: z.array(IssueTriagePossibleDuplicateSchema),
    maintainerSummary: z.string().min(1),
    suggestedAuthorRequest: z.string().min(1).nullable().default(null),
    taskBrief: IssueTriageTaskBriefSchema.default({
      status: "not_generated",
      goal: null,
      userVisibleBehavior: [],
      readFirst: [],
      likelyFiles: [],
      constraints: [],
      safetyNotes: [],
      validationCommands: [],
      doneCriteria: [],
      escalationRisks: [],
      markdown: null,
    }),
  })
  .strict();
export type IssueTriageModelResult = z.infer<
  typeof IssueTriageModelResultSchema
>;

export const IssueTriageResultSchema = IssueTriageModelResultSchema.extend({
  id: z.string().min(1),
  repoId: z.string().min(1),
  issueNumber: z.number().int().positive(),
  commentPreview: IssueTriageCommentPreviewSchema,
  resolvedLabels: z.array(IssueTriageResolvedLabelSchema).default([]),
  writeActions: z.array(IssueTriageWriteActionSchema),
  modelProvider: z.string().min(1),
  model: z.string().min(1),
  consentMode: z.literal("explicit_repository_content_transfer"),
  sourceProfileVersion: z.number().int().positive().nullable(),
  contextArtifactVersion: z.number().int().positive().nullable(),
  createdAt: z.string(),
});
export type IssueTriageResult = z.infer<typeof IssueTriageResultSchema>;

export const HealthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  api: z.literal("ok"),
  database: z.enum(["ok", "error"]),
  redis: z.enum(["ok", "error"]),
  worker: z.enum(["ok", "missing"]),
  workerHeartbeatAt: z.string().nullable(),
  checkedAt: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;

export const AuthToolStatusSchema = z.object({
  status: z.enum(["ok", "missing", "skipped"]),
  error: z.string().nullable(),
  checkedAt: z.string(),
});
export type AuthToolStatus = z.infer<typeof AuthToolStatusSchema>;

export const AuthReadinessSchema = z.object({
  ghAuth: AuthToolStatusSchema,
  codexAuth: AuthToolStatusSchema,
  claudeAuth: AuthToolStatusSchema,
  authReady: z.boolean(),
  checkedAt: z.string(),
});
export type AuthReadiness = z.infer<typeof AuthReadinessSchema>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
