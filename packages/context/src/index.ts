import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringifyOpenMaintainerConfig } from "@open-maintainer/config";
import type {
  ArtifactType,
  ContextArtifactPreset,
  ContextArtifactTarget,
  GeneratedArtifact,
  RepoProfile,
} from "@open-maintainer/shared";
import {
  ArtifactTypeSchema,
  RepoProfileSchema,
  availableContextArtifactTargets,
  contextArtifactSlug,
  contextArtifactTargetsForSelection,
  defaultContextArtifactPresetForProviderKind,
  defaultContextArtifactTargets,
  expectedContextArtifactTypes,
  isContextArtifactPath,
  isOpenMaintainerGeneratedContent,
  newId,
  nowIso,
  obsoleteGeneratedContextArtifactPaths,
} from "@open-maintainer/shared";
import { z } from "zod";

export const StructuredContextOutputSchema = z.object({
  summary: z.string().min(1),
  qualityRules: z.array(z.string().min(1)),
  commands: z.array(z.string().min(1)),
  notes: z.array(z.string().min(1)),
});
export type StructuredContextOutput = z.infer<
  typeof StructuredContextOutputSchema
>;

const EvidenceLevelSchema = z.enum(["observed", "inferred", "not_detected"]);
const EvidenceClaimSchema = z.object({
  claim: z.string().min(1),
  evidence: z.array(z.string().min(1)),
  confidence: EvidenceLevelSchema,
});
const CommandFactSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  scope: z.string().min(1),
  source: z.string().min(1),
  purpose: z.string().min(1),
  confidence: EvidenceLevelSchema,
});

export const StructuredRepoFactsSchema = z.object({
  summary: z.string().min(1),
  evidenceMap: z.array(EvidenceClaimSchema),
  repositoryMap: z.array(
    z.object({
      path: z.string().min(1),
      purpose: z.string().min(1),
      evidence: z.array(z.string().min(1)),
      confidence: EvidenceLevelSchema,
    }),
  ),
  commands: z.array(CommandFactSchema),
  setup: z.object({
    requirements: z.array(EvidenceClaimSchema),
    unknowns: z.array(z.string().min(1)),
  }),
  architecture: z.object({
    observed: z.array(EvidenceClaimSchema),
    inferred: z.array(EvidenceClaimSchema),
    unknowns: z.array(z.string().min(1)),
  }),
  changeRules: z.object({
    safeEditZones: z.array(EvidenceClaimSchema),
    carefulEditZones: z.array(EvidenceClaimSchema),
    doNotEditWithoutExplicitInstruction: z.array(EvidenceClaimSchema),
    unknowns: z.array(z.string().min(1)),
  }),
  testingStrategy: z.object({
    locations: z.array(EvidenceClaimSchema),
    commands: z.array(CommandFactSchema),
    namingConventions: z.array(EvidenceClaimSchema),
    regressionExpectations: z.array(z.string().min(1)),
    unknowns: z.array(z.string().min(1)),
  }),
  validation: z.object({
    canonicalCommand: CommandFactSchema.nullable(),
    scopedCommands: z.array(CommandFactSchema),
    unknowns: z.array(z.string().min(1)),
  }),
  prRules: z.array(z.string().min(1)),
  knownPitfalls: z.array(EvidenceClaimSchema),
  generatedFiles: z.array(EvidenceClaimSchema),
  highRiskAreas: z.array(EvidenceClaimSchema),
  documentationAlignment: z.array(EvidenceClaimSchema),
  unknowns: z.array(z.string().min(1)),
});
export type StructuredRepoFacts = z.infer<typeof StructuredRepoFactsSchema>;

export const ModelArtifactContentSchema = z.object({
  agentsMd: z.string().min(80),
  claudeMd: z.string().min(80),
  copilotInstructions: z.string().min(80),
  cursorRule: z.string().min(80),
});
export type ModelArtifactContent = z.infer<typeof ModelArtifactContentSchema>;

const ModelSkillSchema = z.object({
  path: z
    .string()
    .regex(/^\.(agents|claude)\/skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md$/),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(20),
  markdown: z.string().min(120),
});
export const ModelSkillContentSchema = z.object({
  skills: z.array(ModelSkillSchema).min(1).max(8),
});
export type ModelSkillContent = z.infer<typeof ModelSkillContentSchema>;

const evidenceClaimJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["claim", "evidence", "confidence"],
  properties: {
    claim: { type: "string", minLength: 1 },
    evidence: { type: "array", items: { type: "string", minLength: 1 } },
    confidence: {
      type: "string",
      enum: ["observed", "inferred", "not_detected"],
    },
  },
} as const;

const commandFactJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "command", "scope", "source", "purpose", "confidence"],
  properties: {
    name: { type: "string", minLength: 1 },
    command: { type: "string", minLength: 1 },
    scope: { type: "string", minLength: 1 },
    source: { type: "string", minLength: 1 },
    purpose: { type: "string", minLength: 1 },
    confidence: {
      type: "string",
      enum: ["observed", "inferred", "not_detected"],
    },
  },
} as const;

export const structuredRepoFactsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "evidenceMap",
    "repositoryMap",
    "commands",
    "setup",
    "architecture",
    "changeRules",
    "testingStrategy",
    "validation",
    "prRules",
    "knownPitfalls",
    "generatedFiles",
    "highRiskAreas",
    "documentationAlignment",
    "unknowns",
  ],
  properties: {
    summary: { type: "string", minLength: 1 },
    evidenceMap: { type: "array", items: evidenceClaimJsonSchema },
    repositoryMap: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "purpose", "evidence", "confidence"],
        properties: {
          path: { type: "string", minLength: 1 },
          purpose: { type: "string", minLength: 1 },
          evidence: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
          confidence: {
            type: "string",
            enum: ["observed", "inferred", "not_detected"],
          },
        },
      },
    },
    commands: { type: "array", items: commandFactJsonSchema },
    setup: {
      type: "object",
      additionalProperties: false,
      required: ["requirements", "unknowns"],
      properties: {
        requirements: { type: "array", items: evidenceClaimJsonSchema },
        unknowns: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    architecture: {
      type: "object",
      additionalProperties: false,
      required: ["observed", "inferred", "unknowns"],
      properties: {
        observed: { type: "array", items: evidenceClaimJsonSchema },
        inferred: { type: "array", items: evidenceClaimJsonSchema },
        unknowns: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    changeRules: {
      type: "object",
      additionalProperties: false,
      required: [
        "safeEditZones",
        "carefulEditZones",
        "doNotEditWithoutExplicitInstruction",
        "unknowns",
      ],
      properties: {
        safeEditZones: { type: "array", items: evidenceClaimJsonSchema },
        carefulEditZones: { type: "array", items: evidenceClaimJsonSchema },
        doNotEditWithoutExplicitInstruction: {
          type: "array",
          items: evidenceClaimJsonSchema,
        },
        unknowns: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    testingStrategy: {
      type: "object",
      additionalProperties: false,
      required: [
        "locations",
        "commands",
        "namingConventions",
        "regressionExpectations",
        "unknowns",
      ],
      properties: {
        locations: { type: "array", items: evidenceClaimJsonSchema },
        commands: { type: "array", items: commandFactJsonSchema },
        namingConventions: { type: "array", items: evidenceClaimJsonSchema },
        regressionExpectations: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        unknowns: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    validation: {
      type: "object",
      additionalProperties: false,
      required: ["canonicalCommand", "scopedCommands", "unknowns"],
      properties: {
        canonicalCommand: {
          anyOf: [commandFactJsonSchema, { type: "null" }],
        },
        scopedCommands: { type: "array", items: commandFactJsonSchema },
        unknowns: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    prRules: { type: "array", items: { type: "string", minLength: 1 } },
    knownPitfalls: { type: "array", items: evidenceClaimJsonSchema },
    generatedFiles: { type: "array", items: evidenceClaimJsonSchema },
    highRiskAreas: { type: "array", items: evidenceClaimJsonSchema },
    documentationAlignment: { type: "array", items: evidenceClaimJsonSchema },
    unknowns: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

export const modelArtifactContentJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentsMd", "claudeMd", "copilotInstructions", "cursorRule"],
  properties: {
    agentsMd: { type: "string", minLength: 80 },
    claudeMd: { type: "string", minLength: 80 },
    copilotInstructions: { type: "string", minLength: 80 },
    cursorRule: { type: "string", minLength: 80 },
  },
} as const;

export const modelSkillContentJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skills"],
  properties: {
    skills: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "name", "description", "markdown"],
        properties: {
          path: {
            type: "string",
            pattern:
              "^\\.(agents|claude)/skills/[a-z0-9][a-z0-9-]*/SKILL\\.md$",
          },
          name: {
            type: "string",
            pattern: "^[a-z0-9][a-z0-9-]*$",
          },
          description: { type: "string", minLength: 20 },
          markdown: { type: "string", minLength: 120 },
        },
      },
    },
  },
} as const;

export type ContextSourceFile = {
  path: string;
  content: string;
};

export type { ContextArtifactPreset, ContextArtifactTarget };

export const availableArtifactTargets = [...availableContextArtifactTargets];

export const defaultArtifactTargets = [...defaultContextArtifactTargets];
export {
  contextArtifactTargetsForSelection,
  defaultContextArtifactPresetForProviderKind,
  isOpenMaintainerGeneratedContent,
};

export function expectedArtifactTypes(input: {
  profile: RepoProfile;
  targets?: ContextArtifactTarget[];
}): ArtifactType[] {
  return expectedContextArtifactTypes({
    repoName: input.profile.name,
    ...(input.targets ? { targets: input.targets } : {}),
  });
}

export type ArtifactModel = "codex" | "claude";

export type ArtifactWritePlanItem = {
  artifact: GeneratedArtifact;
  path: string;
  action: "write" | "skip" | "overwrite";
  reason: string;
};

export type ContextGenerationStage =
  | "repo-facts"
  | "artifact-content"
  | "skill-content";

export type ContextGenerationModelPort = {
  providerLabel: string;
  model: string | null;
  complete(
    prompt: { system: string; user: string },
    options: { outputSchema: unknown; stage: ContextGenerationStage },
  ): Promise<{ text: string; model?: string | null }>;
};

export type ContextGenerationInventoryPort = {
  nextArtifactVersion(repoId: string): Promise<number>;
  existingPaths(repoId: string): Promise<Set<string>>;
  existingGeneratedPaths(repoId: string): Promise<Set<string>>;
};

export type ContextGenerationWritePolicy = {
  force?: boolean;
  refreshGenerated?: boolean;
  removeObsoleteGenerated?: boolean;
};

export type ContextGenerationRequest = {
  repoId: string;
  profile: RepoProfile;
  files: ContextSourceFile[];
  targets: ContextArtifactTarget[];
  writePolicy?: ContextGenerationWritePolicy;
};

export type ContextGenerationWritePlan = {
  writes: ArtifactWritePlanItem[];
  obsoleteGeneratedPaths: Array<{ path: string; reason: string }>;
  rows: Array<{ action: string; target: string; reason: string }>;
};

export type ContextArtifactSinkPort = {
  apply(plan: ContextGenerationWritePlan): Promise<string[]>;
};

export type ContextGenerationPreview = {
  repoFacts: StructuredRepoFacts;
  output: StructuredContextOutput;
  artifacts: GeneratedArtifact[];
  plan: ContextGenerationWritePlan;
  modelProvider: string;
  model: string | null;
};

export type ContextGenerationWorkflow = {
  preview(request: ContextGenerationRequest): Promise<ContextGenerationPreview>;
  execute(
    request: ContextGenerationRequest,
    sink: ContextArtifactSinkPort,
  ): Promise<ContextGenerationPreview & { appliedPaths: string[] }>;
};

export type ContextGenerationTargetSelection = {
  context?: ContextArtifactPreset;
  skills?: ContextArtifactPreset;
};

export type ContextGenerationWriteMode =
  | { kind: "preview" }
  | ({ kind: "write" } & ContextGenerationWritePolicy);

export type ContextGenerationRepositoryPort = {
  scan(
    repoRoot: string,
    options?: { maxFiles?: number },
  ): Promise<ContextSourceFile[]>;
  profile(repoRoot: string, files: ContextSourceFile[]): Promise<RepoProfile>;
};

export type ContextGenerationArtifactSinkPort = {
  apply(repoRoot: string, plan: ContextGenerationWritePlan): Promise<string[]>;
};

export function createFilesystemContextArtifactSink(): ContextGenerationArtifactSinkPort {
  return {
    async apply(repoRoot, plan) {
      const appliedPaths: string[] = [];
      for (const item of plan.obsoleteGeneratedPaths) {
        await rm(path.join(repoRoot, item.path), { force: true });
        appliedPaths.push(item.path);
      }
      for (const item of plan.writes) {
        if (item.action === "skip") {
          continue;
        }
        const absolutePath = path.join(repoRoot, item.path);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, item.artifact.content);
        appliedPaths.push(item.path);
      }
      return appliedPaths;
    },
  };
}

export type ContextGenerationRunResult = ContextGenerationPreview & {
  targets: ContextArtifactTarget[];
  appliedPaths: string[];
  wrote: boolean;
};

export type LocalContextGenerationInput = {
  repoRoot: string;
  repoId?: string;
  model: ContextGenerationModelPort;
  selection: ContextGenerationTargetSelection;
  writeMode?: ContextGenerationWriteMode;
};

export type ProfileContextGenerationInput = {
  repoId: string;
  profile: RepoProfile;
  files: ContextSourceFile[];
  model: ContextGenerationModelPort;
  selection?: ContextGenerationTargetSelection;
  providerKind?: string;
  nextArtifactVersion: number;
  writeMode?: ContextGenerationWriteMode;
  sink?: ContextGenerationArtifactSinkPort;
  repoRoot?: string;
};

export type ContextGenerationOrchestrator = {
  generateForWorktree(
    input: LocalContextGenerationInput,
  ): Promise<ContextGenerationRunResult>;
  generateFromProfile(
    input: ProfileContextGenerationInput,
  ): Promise<ContextGenerationRunResult>;
};

export function createContextGenerationOrchestrator(deps: {
  repository?: ContextGenerationRepositoryPort;
  defaultSink?: ContextGenerationArtifactSinkPort;
  events?: ContextGenerationEvents;
  maxFiles?: number;
}): ContextGenerationOrchestrator {
  const maxFiles = deps.maxFiles ?? 800;

  return {
    async generateForWorktree(input) {
      if (!deps.repository) {
        throw new Error(
          "Worktree context generation requires a repository port.",
        );
      }
      const files = await deps.repository.scan(input.repoRoot, { maxFiles });
      const profile = await deps.repository.profile(input.repoRoot, files);
      return generateFromProfileWithPorts({
        repoId: input.repoId ?? "local",
        profile,
        files,
        model: input.model,
        selection: input.selection,
        nextArtifactVersion: 1,
        repoRoot: input.repoRoot,
        ...(input.writeMode ? { writeMode: input.writeMode } : {}),
        ...(deps.defaultSink ? { sink: deps.defaultSink } : {}),
        ...(deps.events ? { events: deps.events } : {}),
      });
    },
    async generateFromProfile(input) {
      return generateFromProfileWithPorts({
        ...input,
        ...((input.sink ?? deps.defaultSink)
          ? { sink: input.sink ?? deps.defaultSink }
          : {}),
        ...(deps.events ? { events: deps.events } : {}),
      });
    },
  };
}

export type ContextGenerationEvents = {
  stageStarted?(stage: ContextGenerationStage): void | Promise<void>;
  stageCompleted?(stage: ContextGenerationStage): void | Promise<void>;
  failed?(error: unknown): void | Promise<void>;
};

export function createContextGenerationWorkflow(ports: {
  model: ContextGenerationModelPort;
  inventory: ContextGenerationInventoryPort;
  events?: ContextGenerationEvents;
}): ContextGenerationWorkflow {
  const runStage = async (
    stage: ContextGenerationStage,
    prompt: { system: string; user: string },
    outputSchema: unknown,
  ) => {
    await ports.events?.stageStarted?.(stage);
    try {
      const completion = await ports.model.complete(prompt, {
        outputSchema,
        stage,
      });
      await ports.events?.stageCompleted?.(stage);
      return completion;
    } catch (error) {
      throw new Error(
        `Context generation ${stage} failed: ${errorMessage(error)}`,
      );
    }
  };

  const preview = async (
    request: ContextGenerationRequest,
  ): Promise<ContextGenerationPreview> => {
    try {
      const factsCompletion = await runStage(
        "repo-facts",
        buildRepoFactsSynthesisPrompt({
          profile: request.profile,
          files: request.files,
        }),
        structuredRepoFactsJsonSchema,
      );
      const repoFacts = parseStageOutput(
        "repo-facts",
        factsCompletion.text,
        parseStructuredRepoFacts,
      );
      const output = structuredContextOutputFromRepoFacts(
        request.profile,
        repoFacts,
      );

      const artifactCompletion = await runStage(
        "artifact-content",
        buildArtifactSynthesisPrompt({
          profile: request.profile,
          repoFacts,
        }),
        modelArtifactContentJsonSchema,
      );
      const modelArtifacts = parseStageOutput(
        "artifact-content",
        artifactCompletion.text,
        parseModelArtifactContent,
      );

      const needsSkills = request.targets.some(
        (target) => target === "skills" || target === "claude-skills",
      );
      const modelSkills = needsSkills
        ? parseStageOutput(
            "skill-content",
            (
              await runStage(
                "skill-content",
                buildSkillSynthesisPrompt({
                  profile: request.profile,
                  repoFacts,
                  agentsMd: modelArtifacts.agentsMd,
                  files: request.files,
                }),
                modelSkillContentJsonSchema,
              )
            ).text,
            parseModelSkillContent,
          )
        : undefined;

      const nextVersion = await ports.inventory.nextArtifactVersion(
        request.repoId,
      );
      const artifacts = createContextArtifacts({
        repoId: request.repoId,
        profile: request.profile,
        output,
        modelArtifacts,
        ...(modelSkills ? { modelSkills } : {}),
        modelProvider: ports.model.providerLabel,
        model: artifactCompletion.model ?? ports.model.model,
        nextVersion,
        targets: request.targets,
      });
      const plan = await buildContextGenerationWritePlan({
        repoId: request.repoId,
        artifacts,
        targets: request.targets,
        writePolicy: request.writePolicy ?? {},
        inventory: ports.inventory,
      });

      return {
        repoFacts,
        output,
        artifacts,
        plan,
        modelProvider: ports.model.providerLabel,
        model: artifactCompletion.model ?? ports.model.model,
      };
    } catch (error) {
      await ports.events?.failed?.(error);
      throw error;
    }
  };

  return {
    preview,
    async execute(request, sink) {
      const generated = await preview(request);
      const appliedPaths = await sink.apply(generated.plan);
      return { ...generated, appliedPaths };
    },
  };
}

async function generateFromProfileWithPorts(
  input: ProfileContextGenerationInput & {
    sink?: ContextGenerationArtifactSinkPort;
    events?: ContextGenerationEvents;
  },
): Promise<ContextGenerationRunResult> {
  const targets = resolveContextGenerationTargets({
    ...(input.selection ? { selection: input.selection } : {}),
    ...(input.providerKind ? { providerKind: input.providerKind } : {}),
  });
  const workflow = createContextGenerationWorkflow({
    model: input.model,
    inventory: contextArtifactInventoryFromFiles({
      files: input.files,
      nextArtifactVersion: input.nextArtifactVersion,
    }),
    ...(input.events ? { events: input.events } : {}),
  });
  const writeMode = input.writeMode ?? { kind: "preview" };
  const writePolicy = writePolicyFromMode(writeMode);
  const preview = await workflow.preview({
    repoId: input.repoId,
    profile: input.profile,
    files: input.files,
    targets,
    ...(writePolicy ? { writePolicy } : {}),
  });

  if (writeMode.kind === "preview") {
    return {
      ...preview,
      targets,
      appliedPaths: [],
      wrote: false,
    };
  }
  if (!input.sink) {
    throw new Error("Context generation write mode requires an artifact sink.");
  }
  if (!input.repoRoot) {
    throw new Error(
      "Context generation write mode requires a repository root.",
    );
  }
  return {
    ...preview,
    targets,
    appliedPaths: await input.sink.apply(input.repoRoot, preview.plan),
    wrote: true,
  };
}

function writePolicyFromMode(
  mode: ContextGenerationWriteMode,
): ContextGenerationWritePolicy | undefined {
  if (mode.kind === "preview") {
    return undefined;
  }
  const policy: ContextGenerationWritePolicy = {};
  if (mode.force !== undefined) {
    policy.force = mode.force;
  }
  if (mode.refreshGenerated !== undefined) {
    policy.refreshGenerated = mode.refreshGenerated;
  }
  if (mode.removeObsoleteGenerated !== undefined) {
    policy.removeObsoleteGenerated = mode.removeObsoleteGenerated;
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

function resolveContextGenerationTargets(input: {
  selection?: ContextGenerationTargetSelection;
  providerKind?: string;
}): ContextArtifactTarget[] {
  const hasContext = input.selection?.context !== undefined;
  const hasSkills = input.selection?.skills !== undefined;
  const providerDefault = input.providerKind
    ? defaultContextArtifactPresetForProviderKind(input.providerKind)
    : null;
  if (!hasContext && !hasSkills) {
    if (!providerDefault) {
      throw new Error(
        "context generation requires context or skills target selection.",
      );
    }
    return contextArtifactTargetsForSelection({
      context: providerDefault,
      skills: providerDefault,
    });
  }

  return contextArtifactTargetsForSelection({
    context: input.selection?.context ?? providerDefault ?? "codex",
    skills: input.selection?.skills ?? providerDefault ?? "codex",
  }).filter((target) => {
    if (
      !hasContext &&
      !providerDefault &&
      (target === "agents" || target === "claude")
    ) {
      return false;
    }
    if (
      !hasSkills &&
      !providerDefault &&
      (target === "skills" || target === "claude-skills")
    ) {
      return false;
    }
    return true;
  });
}

export function renderOpenMaintainerYaml(
  profile: RepoProfile,
  artifactVersion: number,
  rules: string[],
): string {
  return stringifyOpenMaintainerConfig({
    version: 1,
    repo: {
      profileVersion: profile.version,
      defaultBranch: profile.defaultBranch,
    },
    rules,
    generated: {
      by: "open-maintainer",
      artifactVersion,
      generatedAt: nowIso(),
    },
  });
}

export function renderReadinessReport(
  profile: RepoProfile,
  options: { driftFindings?: DriftFinding[] } = {},
): string {
  return [
    `# Open Maintainer Report: ${profile.owner}/${profile.name}`,
    "",
    `Agent Readiness: ${profile.agentReadiness.score}/100`,
    "",
    "## Category Scores",
    "",
    ...profile.agentReadiness.categories.flatMap((category) => [
      `### ${category.name}: ${category.score}/${category.maxScore}`,
      "",
      ...(category.missing.length > 0
        ? category.missing.map((item) => `- Missing: ${item}`)
        : ["- No missing items detected."]),
      ...category.evidence.map(
        (item) => `- Evidence: ${item.path} (${item.reason})`,
      ),
      "",
    ]),
    ...renderDriftReportSection(options.driftFindings ?? []),
    "## Commands",
    "",
    ...listOrFallback(commandLines(profile), "No commands detected."),
    "",
    "## Architecture",
    "",
    ...listOrFallback(
      profile.architecturePathGroups,
      "No architecture paths detected.",
    ),
    "",
    "## Risk Hints",
    "",
    ...listOrFallback(profile.detectedRiskAreas, "No risk hints detected."),
  ].join("\n");
}

function renderDriftReportSection(findings: DriftFinding[]): string[] {
  if (findings.length === 0) {
    return [];
  }
  return [
    "## Drift",
    "",
    ...findings.map((finding) => `- ${formatReportDriftFinding(finding)}`),
    "",
  ];
}

function formatReportDriftFinding(finding: DriftFinding): string {
  const action = reportDriftAction(finding.group);
  return `${reportDriftLabel(finding.group)}: ${finding.subject} was ${finding.changeType}. Evidence: ${finding.path}. Next action: ${action}`;
}

function reportDriftLabel(group: DriftFinding["group"]): string {
  switch (group) {
    case "commands":
      return "Commands";
    case "ci":
      return "CI workflows";
    case "docs":
      return "Documentation";
    case "templates":
      return "Issue and PR templates";
    case "context":
      return "Context artifacts";
    case "lock_config":
      return "Lockfiles and config";
    case "boundaries":
      return "Package boundaries";
    case "risk":
      return "Risk paths";
  }
}

function reportDriftAction(group: DriftFinding["group"]): string {
  switch (group) {
    case "commands":
      return "review the changed command and refresh generated context if validation expectations changed.";
    case "ci":
      return "review workflow validation and refresh generated context if CI expectations changed.";
    case "docs":
      return "review generated context against the changed docs.";
    case "templates":
      return "review issue and PR guidance reflected in generated context.";
    case "context":
      return "rerun generation or review the edited context artifact.";
    case "lock_config":
      return "review setup and validation context for the changed file.";
    case "boundaries":
      return "review package/app context for the changed boundary.";
    case "risk":
      return "inspect the changed risk path and update high-risk guidance if needed.";
  }
}

export function createContextArtifacts(input: {
  repoId: string;
  profile: RepoProfile;
  output: StructuredContextOutput;
  modelArtifacts?: ModelArtifactContent;
  modelSkills?: ModelSkillContent;
  modelProvider: string | null;
  model: string | null;
  nextVersion: number;
  targets?: ContextArtifactTarget[];
}): GeneratedArtifact[] {
  const createdAt = nowIso();
  const targets = new Set(input.targets ?? defaultContextArtifactTargets);
  const definitions: Array<{ type: ArtifactType; content: string }> = [];
  if (targets.has("agents")) {
    if (!input.modelArtifacts) {
      throw new Error("AGENTS.md generation requires model artifact content.");
    }
    definitions.push({
      type: "AGENTS.md",
      content: appendContributionQualityRequirements(
        input.modelArtifacts.agentsMd,
      ),
    });
  }
  if (targets.has("claude")) {
    if (!input.modelArtifacts) {
      throw new Error("CLAUDE.md generation requires model artifact content.");
    }
    definitions.push({
      type: "CLAUDE.md",
      content: appendContributionQualityRequirements(
        input.modelArtifacts.claudeMd,
      ),
    });
  }
  if (targets.has("config")) {
    definitions.push({
      type: ".open-maintainer.yml",
      content: renderOpenMaintainerYaml(
        input.profile,
        input.nextVersion + definitions.length,
        input.output.qualityRules,
      ),
    });
  }
  if (targets.has("copilot")) {
    if (!input.modelArtifacts) {
      throw new Error(
        "Copilot instruction generation requires model artifact content.",
      );
    }
    definitions.push({
      type: ".github/copilot-instructions.md",
      content: input.modelArtifacts.copilotInstructions,
    });
  }
  if (targets.has("cursor")) {
    if (!input.modelArtifacts) {
      throw new Error(
        "Cursor rule generation requires model artifact content.",
      );
    }
    definitions.push({
      type: ".cursor/rules/open-maintainer.md",
      content: input.modelArtifacts.cursorRule,
    });
  }
  if (targets.has("skills")) {
    definitions.push(
      ...skillDefinitionsForTarget(
        ".agents",
        input.profile.name,
        input.modelSkills,
      ),
    );
  }
  if (targets.has("claude-skills")) {
    definitions.push(
      ...skillDefinitionsForTarget(
        ".claude",
        input.profile.name,
        input.modelSkills,
      ),
    );
  }
  if (targets.has("profile")) {
    const contextArtifactHashes = definitions
      .filter((definition) => isContextArtifactPath(definition.type))
      .map((definition) => ({
        path: definition.type,
        hash: contentHash(definition.content),
      }));
    definitions.push({
      type: ".open-maintainer/profile.json",
      content: `${JSON.stringify(
        {
          ...input.profile,
          contextArtifactHashes,
          openMaintainerProfileHash: profileFingerprint(input.profile),
        },
        null,
        2,
      )}\n`,
    });
  }
  if (targets.has("report")) {
    definitions.push({
      type: ".open-maintainer/report.md",
      content: renderReadinessReport(input.profile),
    });
  }

  return definitions.map((definition, index) => ({
    id: newId("artifact"),
    repoId: input.repoId,
    type: definition.type,
    version: input.nextVersion + index,
    content: definition.content,
    sourceProfileVersion: input.profile.version,
    modelProvider: input.modelProvider,
    model: input.model,
    createdAt,
  }));
}

export const contributionQualityRequirementsSection = [
  "## Contribution Quality Requirements",
  "",
  "- Bug issues should include reproduction steps, expected behavior, actual behavior, affected environment or version when known, and logs or failing commands when available.",
  "- Feature requests should describe the user problem, affected surface, and concrete acceptance criteria.",
  "- Security reports should name the affected surface and include a proof of concept or credible exploit path when possible; ask for clarification rather than dismissing reports that lack proof.",
  "- Pull requests should include clear intent, a linked issue or acceptance criteria when available, a scoped diff, validation evidence, and documentation updates for public behavior changes.",
  "- High-risk pull requests touching auth, secrets, CI or release workflows, deploy paths, dependencies, lockfiles, generated files, or migrations should include rationale and targeted validation.",
  "- Open Maintainer evaluates reviewability, scope, evidence, validation, and repository alignment; it does not evaluate whether the author used AI.",
].join("\n");

function appendContributionQualityRequirements(markdown: string): string {
  if (markdown.includes(contributionQualityRequirementsSection)) {
    return markdown;
  }
  return `${markdown.trimEnd()}\n\n${contributionQualityRequirementsSection}\n`;
}

function skillDefinitionsForTarget(
  targetRoot: ".agents" | ".claude",
  repoName: string,
  modelSkills?: ModelSkillContent,
): Array<{ type: ArtifactType; content: string }> {
  if (!modelSkills || modelSkills.skills.length === 0) {
    throw new Error("Skill generation requires model skill content.");
  }
  const repoSlug = contextArtifactSlug(repoName);
  const seen = new Set<string>();
  return modelSkills.skills.flatMap((skill) => {
    const rawSlug =
      skillSlugFromPath(skill.path) ?? contextArtifactSlug(skill.name);
    const slug = canonicalSkillSlug(rawSlug, repoSlug);
    const path = ArtifactTypeSchema.parse(
      `${targetRoot}/skills/${slug}/SKILL.md`,
    );
    if (seen.has(path)) {
      return [];
    }
    seen.add(path);
    return [{ type: path, content: normalizeSkillName(skill.markdown, slug) }];
  });
}

function canonicalSkillSlug(slug: string, repoSlug: string): string {
  const suffix = slug.startsWith(`${repoSlug}-`)
    ? slug.slice(repoSlug.length + 1)
    : slug;
  if (suffix === "start-task" || suffix === "orientation") {
    return `${repoSlug}-start-task`;
  }
  if (
    suffix === "testing-workflow" ||
    suffix === "validation-testing" ||
    suffix === "validation-workflow" ||
    suffix === "testing" ||
    suffix === "validation"
  ) {
    return `${repoSlug}-testing-workflow`;
  }
  if (
    suffix === "pr-review" ||
    suffix === "pull-request-review" ||
    suffix === "review-pr"
  ) {
    return `${repoSlug}-pr-review`;
  }
  return slug;
}

function normalizeSkillName(markdown: string, name: string): string {
  if (!markdown.startsWith("---\n")) {
    return markdown;
  }
  return markdown.replace(/^name: .+$/m, `name: ${name}`);
}

export function buildRepoFactsSynthesisPrompt(input: {
  profile: RepoProfile;
  files: ContextSourceFile[];
}): {
  system: string;
  user: string;
} {
  return {
    system: [
      "You analyze repository evidence for an AI-agent context generator.",
      "This is pass 1 of a two-pass pipeline. Do not write AGENTS.md or any Markdown artifact.",
      "Return only normalized repository facts, evidence references, cautious inferences, risk areas, and unknowns.",
      "",
      "Use only the repository profile and selected file excerpts provided by the user.",
      "Do not invent commands, services, deployment processes, package managers, policies, owners, audit requirements, environments, release flows, or architectural facts.",
      "",
      "Evidence policy:",
      "- Mark directly observed facts with confidence 'observed'.",
      "- Mark cautious conclusions from paths, configs, package manifests, or CI workflows with confidence 'inferred'.",
      "- Use confidence 'not_detected' only for explicit unknown/missing evidence claims.",
      "- Every observed or inferred claim must include at least one evidence path or profile field name.",
      "- Never present an inference as a confirmed fact.",
      "- Do not mention that generated target files such as AGENTS.md, Claude instructions, Cursor rules, Copilot instructions, or generated skills are missing; this task is creating them.",
      "",
      "Analyze for:",
      "- project overview and runtime",
      "- repository map",
      "- architecture and data flow",
      "- setup requirements",
      "- commands and validation gates",
      "- coding conventions",
      "- safe, careful, and do-not-edit zones",
      "- testing strategy",
      "- PR and review rules",
      "- known pitfalls",
      "- generated files",
      "- security and high-risk areas",
      "- documentation alignment requirements",
      "- unknowns and missing evidence",
      "",
      "Return only valid JSON matching the requested schema.",
      "Do not include markdown fences around the JSON.",
      "Do not include comments or trailing commas.",
      "",
      "Quality bar:",
      "- Evidence beats speculation.",
      "- Unknowns beat hallucinated confidence.",
      "- Specific paths and commands beat broad labels.",
    ].join("\n"),
    user: JSON.stringify({
      task: "Analyze repository evidence into normalized facts for AI-agent-ready context generation.",
      repo: {
        owner: input.profile.owner,
        name: input.profile.name,
        defaultBranch: input.profile.defaultBranch,
        languages: input.profile.primaryLanguages,
        frameworks: input.profile.frameworks,
        packageManager: input.profile.packageManager,
        commands: input.profile.commands,
        ciWorkflows: input.profile.ciWorkflows,
        docs: input.profile.importantDocs,
        architecturePathGroups: input.profile.architecturePathGroups,
        generatedFileHints: input.profile.generatedFileHints,
        generatedFilePaths: input.profile.generatedFilePaths,
        existingContextFiles: input.profile.existingContextFiles,
        riskAreas: input.profile.detectedRiskAreas,
        riskHintPaths: input.profile.riskHintPaths,
        ownershipHints: input.profile.ownershipHints,
        environmentFiles: input.profile.environmentFiles,
        environmentVariables: input.profile.environmentVariables,
        ignoreFiles: input.profile.ignoreFiles,
        testFilePaths: input.profile.testFilePaths,
        reviewRules: input.profile.reviewRuleCandidates,
        evidence: input.profile.evidence,
        workspaceManifests: input.profile.workspaceManifests,
        lockfiles: input.profile.lockfiles,
        configFiles: input.profile.configFiles,
        readiness: input.profile.agentReadiness,
      },
      selectedFiles: selectPromptFileExcerpts(input.files),
      outputRules: {
        evidenceOnly: true,
        labelInferences: true,
        includeUnknowns: true,
        noGeneratedTargetMissingClaims: true,
      },
    }),
  };
}

export function buildArtifactSynthesisPrompt(input: {
  profile: RepoProfile;
  repoFacts: StructuredRepoFacts;
}): {
  system: string;
  user: string;
} {
  return {
    system: [
      "You generate repository-specific operating instructions for AI coding agents.",
      "",
      "Your primary artifact is AGENTS.md. It must help an autonomous or semi-autonomous coding agent understand the repository, make a bounded change, run the right checks, and prepare a reviewable PR without relying on tribal context.",
      "",
      "Use only the repository profile and normalized repo facts provided by the user.",
      "Do not invent commands, services, deployment processes, package managers, policies, owners, audit requirements, environments, release flows, or architectural facts.",
      "",
      "Evidence policy:",
      "- Prefer facts directly observed in provided files.",
      "- You may make cautious inferences from filenames, directory structure, package manifests, config files, and CI workflows, but label them as apparent or inferred.",
      "- If evidence is missing, say 'Not detected' and provide the safest practical fallback.",
      "- Never present an inference as a confirmed fact.",
      "- Do not mention that generated target files such as AGENTS.md, Claude instructions, Cursor rules, Copilot instructions, or generated skills are missing; this task is creating them.",
      "",
      "AGENTS.md requirements:",
      "- Optimize AGENTS.md for coding-agent execution, not audit-style completeness.",
      "- Put the most important operational rules in the first 40 lines.",
      "- Keep AGENTS.md to 180-250 lines unless the repository is unusually complex.",
      "Include these sections in this order:",
      "1. Project overview",
      "2. Agent workflow",
      "3. Scope control",
      "4. Repository map",
      "5. Architecture",
      "6. Setup",
      "7. Common commands",
      "8. Coding conventions",
      "9. Change rules",
      "10. Testing strategy",
      "11. Validation checklist",
      "12. PR rules",
      "13. Known pitfalls",
      "14. Generated files",
      "15. Security and high-risk areas",
      "16. Documentation alignment",
      "17. Unknowns and missing evidence",
      "",
      "For each section:",
      "- Use exact paths and exact commands when available.",
      "- Avoid generic advice that could apply to any repository.",
      "- Keep wording concise and operational.",
      "- Prefer bullets, checklists, and commands over prose.",
      "- If the section lacks evidence, write a short 'Not detected' note and the safest fallback behavior for an agent.",
      "- Do not repeat the same command list across multiple sections.",
      "",
      "Agent workflow must be near the top and describe the default coding-agent loop: read target and related files, make a bounded change, run scoped validation, report evidence.",
      "",
      "Scope control must explicitly prevent broad refactors, unrelated formatting, dependency churn, lockfile churn, and public API or behavior changes without matching docs and tests.",
      "",
      "Command rules:",
      "- Identify a canonical full validation command if one exists.",
      "- If no canonical full validation command exists, say so.",
      "- List scoped commands by changed surface when possible, such as frontend, backend, contracts, tests, lint, typecheck, build, or docs.",
      "- Do not fabricate a combined command such as 'make check' or 'npm run check' unless it appears in evidence.",
      "- Prefer a validation routing table with columns like changed surface, command, when to run, and evidence/source.",
      "",
      "Change rules must separate:",
      "- Safe edit zones",
      "- Careful edit zones",
      "- Do-not-edit-without-explicit-instruction zones",
      "",
      "Testing strategy must state:",
      "- Where tests appear to live",
      "- Which commands run them",
      "- When regression tests are expected",
      "- Any observed test naming conventions",
      "",
      "PR rules must require:",
      "- Test evidence",
      "- No unrelated formatting",
      "- No secrets or credentials",
      "- Documentation updates for public behavior changes",
      "- Explicit notes for risky areas touched",
      "",
      "Generated files and high-risk areas:",
      "- Mark generated files, lockfiles, migrations, schemas, vendored code, compiled artifacts, and deployment files carefully when detected.",
      "- If unsure whether a path is generated or high-risk, say it is not confirmed and recommend caution.",
      "",
      "Architecture and documentation alignment:",
      "- Compress architecture details into high-signal module responsibilities and risk notes.",
      "- Prefer a documentation routing table with columns like change type, docs to update, and evidence/source.",
      "",
      "Tool-specific outputs:",
      "- Generate Claude, Copilot, and Cursor files from the same facts as AGENTS.md.",
      "- AGENTS.md is the source of truth.",
      "- Tool-specific files should be shorter mirrors, not independent reinterpretations.",
      "",
      "Return only valid JSON.",
      "Do not include markdown fences around the JSON.",
      "Do not include comments or trailing commas.",
      "",
      "The JSON object must have exactly these keys:",
      "agentsMd",
      "claudeMd",
      "copilotInstructions",
      "cursorRule",
      "",
      "Each value must be complete Markdown content for that file. Include Cursor frontmatter for cursorRule.",
      "",
      "Quality bar:",
      "- Specific beats complete.",
      "- Evidence beats speculation.",
      "- Operational beats explanatory.",
      "- Short and accurate beats long and generic.",
    ].join("\n"),
    user: JSON.stringify({
      task: "Generate AI-agent-ready repository context artifacts.",
      aiReadyDefinition: {
        goal: "Make project context, engineering rules, validation commands, and task workflows explicit enough that an AI agent can make a safe, reviewable change without guessing.",
        sourceOfTruth: "AGENTS.md",
        minimumAgentsMdSections: [
          "Project overview",
          "Agent workflow",
          "Scope control",
          "Repository map",
          "Architecture",
          "Setup",
          "Common commands",
          "Coding conventions",
          "Change rules",
          "Testing strategy",
          "Validation checklist",
          "PR rules",
          "Known pitfalls",
          "Generated files",
          "Security and high-risk areas",
          "Documentation alignment",
          "Unknowns and missing evidence",
        ],
      },
      repo: {
        owner: input.profile.owner,
        name: input.profile.name,
        defaultBranch: input.profile.defaultBranch,
        languages: input.profile.primaryLanguages,
        frameworks: input.profile.frameworks,
        packageManager: input.profile.packageManager,
        commands: input.profile.commands,
        ciWorkflows: input.profile.ciWorkflows,
        docs: input.profile.importantDocs,
        architecturePathGroups: input.profile.architecturePathGroups,
        generatedFilePaths: input.profile.generatedFilePaths,
        riskAreas: input.profile.detectedRiskAreas,
        riskHintPaths: input.profile.riskHintPaths,
        ownershipHints: input.profile.ownershipHints,
        environmentFiles: input.profile.environmentFiles,
        environmentVariables: input.profile.environmentVariables,
        ignoreFiles: input.profile.ignoreFiles,
        testFilePaths: input.profile.testFilePaths,
        reviewRules: input.profile.reviewRuleCandidates,
        readiness: input.profile.agentReadiness,
      },
      repoFacts: input.repoFacts,
      outputRules: {
        evidenceOnly: true,
        noBoilerplate: true,
        noGenericAdvice: true,
        noSelfContradictoryMissingFileClaims: true,
        preferExactPathsAndCommands: true,
        labelInferences: true,
        includeUnknowns: true,
        agentsMdIsSourceOfTruth: true,
        optimizeForCodingAgentExecution: true,
        putOperationalRulesInFirstFortyLines: true,
        preferRoutingTables: true,
        avoidRepeatedCommandLists: true,
        targetAgentsMdLineCount: "180-250 unless unusually complex",
        includeScopeControl: true,
      },
    }),
  };
}

export function buildSkillSynthesisPrompt(input: {
  profile: RepoProfile;
  repoFacts: StructuredRepoFacts;
  agentsMd: string;
  files: ContextSourceFile[];
}): {
  system: string;
  user: string;
} {
  return {
    system: [
      "You generate repository-specific Agent Skills for AI coding agents.",
      "",
      "A skill is not a general documentation summary.",
      "A skill is a compact, task-specific operating procedure for a repeated workflow in this repository.",
      "",
      "Use only the provided repository facts, evidence map, selected file excerpts, and AGENTS.md.",
      "Do not invent commands, paths, services, owners, policies, release processes, deployment behavior, or test locations.",
      "",
      "AGENTS.md is the source of truth.",
      "Skills must be consistent with AGENTS.md and may only compress, specialize, or route its instructions.",
      "",
      "Evidence policy:",
      "- Prefer directly observed paths, commands, manifests, docs, and workflows.",
      "- Label cautious inferences as apparent or inferred.",
      "- If evidence is missing, say 'Not detected' and give the safest fallback.",
      "- Never present guessed repo behavior as fact.",
      "",
      "Generate skills that improve real agent execution.",
      "Prefer workflow-specific skills over generic summaries.",
      "",
      "Skill selection rules:",
      "- Always generate a start-task/orientation skill.",
      "- Always generate a validation/testing skill.",
      "- Always generate a PR-review skill.",
      "- Additionally generate up to 5 repo-specific workflow skills when the evidence supports them.",
      "- Repo-specific skills should target repeated, high-value, or high-risk workflows in this repository.",
      "",
      "Examples of repo-specific workflow skills:",
      "- add-cli-command",
      "- update-api-route",
      "- update-github-webhook",
      "- update-contract",
      "- update-indexer-event-handler",
      "- update-frontend-page",
      "- update-database-schema",
      "- update-docker-compose-stack",
      "- update-release-workflow",
      "- update-generated-context-artifacts",
      "",
      "Do not generate a repo-specific skill unless there is enough evidence to make it operational.",
      "If evidence is insufficient, prefer fewer better skills.",
      "",
      "Each skill must include YAML frontmatter:",
      "---",
      "name: <kebab-case repo-specific name>",
      "description: <one sentence saying when to use the skill>",
      "---",
      "",
      "Each skill body must include these sections:",
      "# <Title>",
      "",
      "## Use when",
      "- Specific conditions for using this skill.",
      "",
      "## Do not use when",
      "- Cases where another skill or human instruction is more appropriate.",
      "",
      "## Read first",
      "- Exact files, directories, docs, manifests, tests, or configs to inspect before editing.",
      "",
      "## Workflow",
      "- Step-by-step procedure for the task.",
      "",
      "## Validation",
      "- Exact commands to run, routed by changed surface when needed.",
      "- If no exact command is detected, say 'Not detected' and give the safest fallback.",
      "",
      "## Documentation",
      "- Docs that must be checked or updated when behavior changes.",
      "",
      "## Risk checks",
      "- Repo-specific risks, sharp edges, security concerns, generated files, lockfiles, migrations, deployment behavior, or public API concerns.",
      "",
      "## Done when",
      "- Concrete completion criteria.",
      "",
      "Style rules:",
      "- Be concise and operational.",
      "- Prefer bullets and small tables over prose.",
      "- Avoid generic advice that would apply to any repo.",
      "- Avoid copying large sections of AGENTS.md.",
      "- Do not include motivational text.",
      "- Do not include markdown fences.",
      "",
      "Return only valid JSON.",
      "Do not include comments or trailing commas.",
      "",
      "Return shape:",
      "{",
      '  "skills": [',
      "    {",
      '      "path": ".agents/skills/<skill-slug>/SKILL.md",',
      '      "name": "<frontmatter name>",',
      '      "description": "<frontmatter description>",',
      '      "markdown": "<complete SKILL.md content>"',
      "    }",
      "  ]",
      "}",
      "",
      "Path rules:",
      "- Use .agents/skills/<skill-slug>/SKILL.md for every path.",
      "- Use kebab-case skill slugs.",
      "- The caller will map paths to .claude/skills when Claude project skills are requested.",
      "",
      "Quality bar:",
      "- Specific beats comprehensive.",
      "- Workflow beats summary.",
      "- Evidence beats speculation.",
      "- Fewer high-quality skills beat many generic skills.",
    ].join("\n"),
    user: JSON.stringify({
      task: "Generate repository-specific Agent Skills.",
      repo: {
        owner: input.profile.owner,
        name: input.profile.name,
        defaultBranch: input.profile.defaultBranch,
        languages: input.profile.primaryLanguages,
        frameworks: input.profile.frameworks,
        packageManager: input.profile.packageManager,
        commands: input.profile.commands,
        ciWorkflows: input.profile.ciWorkflows,
        docs: input.profile.importantDocs,
        architecturePathGroups: input.profile.architecturePathGroups,
        generatedFilePaths: input.profile.generatedFilePaths,
        riskAreas: input.profile.detectedRiskAreas,
        riskHintPaths: input.profile.riskHintPaths,
        ownershipHints: input.profile.ownershipHints,
        environmentFiles: input.profile.environmentFiles,
        environmentVariables: input.profile.environmentVariables,
        ignoreFiles: input.profile.ignoreFiles,
        testFilePaths: input.profile.testFilePaths,
        reviewRules: input.profile.reviewRuleCandidates,
        readiness: input.profile.agentReadiness,
      },
      agentsMd: input.agentsMd,
      selectedFiles: selectPromptFileExcerpts(input.files),
      repoFacts: input.repoFacts,
      outputRules: {
        evidenceOnly: true,
        agentsMdIsSourceOfTruth: true,
        noGenericAdvice: true,
        preferExactPathsAndCommands: true,
        labelInferences: true,
        includeUnknowns: true,
        preferFewerBetterSkills: true,
        maxSkills: 8,
      },
    }),
  };
}

export function parseStructuredRepoFacts(text: string): StructuredRepoFacts {
  const parsed = JSON.parse(stripJsonFence(text)) as unknown;
  return StructuredRepoFactsSchema.parse(parsed);
}

export function structuredContextOutputFromRepoFacts(
  profile: RepoProfile,
  repoFacts: StructuredRepoFacts,
): StructuredContextOutput {
  const factCommands = [
    ...repoFacts.commands,
    ...repoFacts.testingStrategy.commands,
    ...(repoFacts.validation.canonicalCommand
      ? [repoFacts.validation.canonicalCommand]
      : []),
    ...repoFacts.validation.scopedCommands,
  ];
  const commands =
    factCommands.length > 0
      ? uniqueStrings(factCommands.map(formatCommandFact))
      : commandLines(profile);
  const qualityRules = uniqueStrings([
    ...profile.reviewRuleCandidates,
    ...repoFacts.prRules,
    ...repoFacts.changeRules.safeEditZones.map(
      (item) => `Safe edit zone: ${item.claim}`,
    ),
    ...repoFacts.changeRules.carefulEditZones.map(
      (item) => `Use caution: ${item.claim}`,
    ),
    ...repoFacts.changeRules.doNotEditWithoutExplicitInstruction.map(
      (item) => `Do not edit without explicit instruction: ${item.claim}`,
    ),
  ]);
  const notes = uniqueStrings([
    ...repoFacts.highRiskAreas.map((item) => item.claim),
    ...repoFacts.knownPitfalls.map((item) => item.claim),
    ...repoFacts.unknowns.map((item) => `Unknown: ${item}`),
  ]);
  return {
    summary: repoFacts.summary,
    qualityRules:
      qualityRules.length > 0
        ? qualityRules
        : [
            ...profile.reviewRuleCandidates,
            "Read target files before editing.",
            "Run the documented quality gates before finishing.",
          ],
    commands,
    notes: notes.length > 0 ? notes : profile.detectedRiskAreas,
  };
}

export function parseModelArtifactContent(text: string): ModelArtifactContent {
  const parsed = JSON.parse(stripJsonFence(text)) as unknown;
  return ModelArtifactContentSchema.parse(parsed);
}

export function parseModelSkillContent(text: string): ModelSkillContent {
  const parsed = JSON.parse(stripJsonFence(text)) as unknown;
  return ModelSkillContentSchema.parse(parsed);
}

export function profileFingerprint(profile: RepoProfile): string {
  return contentHash(JSON.stringify(fingerprintableProfile(profile)));
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export type DriftFinding = {
  group:
    | "commands"
    | "ci"
    | "docs"
    | "templates"
    | "context"
    | "lock_config"
    | "boundaries"
    | "risk";
  changeType: "added" | "removed" | "changed";
  path: string;
  subject: string;
  previousValue: string | null;
  currentValue: string | null;
};

export function parseRepoProfileJson(content: string): RepoProfile | null {
  try {
    const parsed = RepoProfileSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function compareProfileDrift(input: {
  stored: RepoProfile;
  current: RepoProfile;
}): DriftFinding[] {
  return [
    ...compareCommandDrift(input.stored, input.current),
    ...compareCiWorkflowDrift(input.stored, input.current),
    ...compareDocsDrift(input.stored, input.current),
    ...compareTemplateDrift(input.stored, input.current),
    ...compareContextArtifactDrift(input.stored, input.current),
    ...compareLockConfigDrift(input.stored, input.current),
    ...compareBoundaryDrift(input.stored, input.current),
    ...compareRiskHintDrift(input.stored, input.current),
  ].sort(
    (left, right) =>
      left.group.localeCompare(right.group) ||
      left.path.localeCompare(right.path) ||
      left.subject.localeCompare(right.subject) ||
      left.changeType.localeCompare(right.changeType),
  );
}

function compareCommandDrift(
  stored: RepoProfile,
  current: RepoProfile,
): DriftFinding[] {
  const previousCommands = new Map(
    stored.commands.map((command) => [commandKey(command), command]),
  );
  const currentCommands = new Map(
    current.commands.map((command) => [commandKey(command), command]),
  );
  const findings: DriftFinding[] = [];

  for (const [key, command] of currentCommands) {
    const previous = previousCommands.get(key);
    if (!previous) {
      findings.push({
        group: "commands",
        changeType: "added",
        path: command.source,
        subject: commandSubject(command),
        previousValue: null,
        currentValue: command.command,
      });
      continue;
    }
    if (previous.command !== command.command) {
      findings.push({
        group: "commands",
        changeType: "changed",
        path: command.source,
        subject: commandSubject(command),
        previousValue: previous.command,
        currentValue: command.command,
      });
    }
  }

  for (const [key, command] of previousCommands) {
    if (currentCommands.has(key)) {
      continue;
    }
    findings.push({
      group: "commands",
      changeType: "removed",
      path: command.source,
      subject: commandSubject(command),
      previousValue: command.command,
      currentValue: null,
    });
  }

  return findings;
}

function commandKey(command: RepoProfile["commands"][number]): string {
  return `${command.source}:${command.name}`;
}

function commandSubject(command: RepoProfile["commands"][number]): string {
  const sourceKind = command.source.endsWith("package.json")
    ? "script"
    : "command";
  return `${command.source} ${sourceKind} ${command.name}`;
}

function compareCiWorkflowDrift(
  stored: RepoProfile,
  current: RepoProfile,
): DriftFinding[] {
  return comparePathListDrift({
    group: "ci",
    storedPaths: stored.ciWorkflows,
    currentPaths: current.ciWorkflows,
    storedHashes: stored.trackedFileHashes,
    currentHashes: current.trackedFileHashes,
  });
}

function compareDocsDrift(
  stored: RepoProfile,
  current: RepoProfile,
): DriftFinding[] {
  return comparePathListDrift({
    group: "docs",
    storedPaths: stored.importantDocs,
    currentPaths: current.importantDocs,
    storedHashes: stored.trackedFileHashes,
    currentHashes: current.trackedFileHashes,
  });
}

function compareTemplateDrift(
  stored: RepoProfile,
  current: RepoProfile,
): DriftFinding[] {
  return comparePathListDrift({
    group: "templates",
    storedPaths: stored.repoTemplates,
    currentPaths: current.repoTemplates,
    storedHashes: stored.trackedFileHashes,
    currentHashes: current.trackedFileHashes,
  });
}

function compareContextArtifactDrift(
  stored: RepoProfile,
  current: RepoProfile,
): DriftFinding[] {
  if (stored.contextArtifactHashes.length === 0) {
    return [];
  }
  const storedPaths = stored.contextArtifactHashes.map((item) => item.path);
  const storedPathSet = new Set(storedPaths);
  return comparePathListDrift({
    group: "context",
    storedPaths,
    currentPaths: current.existingContextFiles.filter((path) =>
      storedPathSet.has(path),
    ),
    storedHashes: stored.contextArtifactHashes,
    currentHashes: current.trackedFileHashes,
  });
}

function compareLockConfigDrift(
  stored: RepoProfile,
  current: RepoProfile,
): DriftFinding[] {
  return comparePathListDrift({
    group: "lock_config",
    storedPaths: [...stored.lockfiles, ...stored.configFiles],
    currentPaths: [...current.lockfiles, ...current.configFiles],
    storedHashes: stored.trackedFileHashes,
    currentHashes: current.trackedFileHashes,
  });
}

function compareBoundaryDrift(
  stored: RepoProfile,
  current: RepoProfile,
): DriftFinding[] {
  return comparePathListDrift({
    group: "boundaries",
    storedPaths: stored.architecturePathGroups,
    currentPaths: current.architecturePathGroups,
    storedHashes: [],
    currentHashes: [],
  });
}

function compareRiskHintDrift(
  stored: RepoProfile,
  current: RepoProfile,
): DriftFinding[] {
  return comparePathListDrift({
    group: "risk",
    storedPaths: stored.riskHintPaths,
    currentPaths: current.riskHintPaths,
    storedHashes: stored.trackedFileHashes,
    currentHashes: current.trackedFileHashes,
  });
}

function comparePathListDrift(input: {
  group: DriftFinding["group"];
  storedPaths: string[];
  currentPaths: string[];
  storedHashes: RepoProfile["trackedFileHashes"];
  currentHashes: RepoProfile["trackedFileHashes"];
}): DriftFinding[] {
  const storedPaths = new Set(input.storedPaths);
  const currentPaths = new Set(input.currentPaths);
  const storedHashes = new Map(
    input.storedHashes.map((item) => [item.path, item.hash]),
  );
  const currentHashes = new Map(
    input.currentHashes.map((item) => [item.path, item.hash]),
  );
  const allPaths = [...new Set([...input.storedPaths, ...input.currentPaths])]
    .filter(
      (repoPath) => storedPaths.has(repoPath) || currentPaths.has(repoPath),
    )
    .sort();
  const findings: DriftFinding[] = [];

  for (const repoPath of allPaths) {
    if (!storedPaths.has(repoPath)) {
      findings.push({
        group: input.group,
        changeType: "added",
        path: repoPath,
        subject: repoPath,
        previousValue: null,
        currentValue: currentHashes.get(repoPath) ?? null,
      });
      continue;
    }
    if (!currentPaths.has(repoPath)) {
      findings.push({
        group: input.group,
        changeType: "removed",
        path: repoPath,
        subject: repoPath,
        previousValue: storedHashes.get(repoPath) ?? null,
        currentValue: null,
      });
      continue;
    }
    const previousHash = storedHashes.get(repoPath);
    const currentHash = currentHashes.get(repoPath);
    if (previousHash && currentHash && previousHash !== currentHash) {
      findings.push({
        group: input.group,
        changeType: "changed",
        path: repoPath,
        subject: repoPath,
        previousValue: previousHash,
        currentValue: currentHash,
      });
    }
  }

  return findings;
}

function fingerprintableProfile(profile: RepoProfile) {
  return {
    repoId: profile.repoId,
    owner: profile.owner,
    name: profile.name,
    defaultBranch: profile.defaultBranch,
    primaryLanguages: profile.primaryLanguages,
    frameworks: profile.frameworks,
    packageManager: profile.packageManager,
    commands: profile.commands,
    ciWorkflows: profile.ciWorkflows,
    importantDocs: profile.importantDocs,
    repoTemplates: profile.repoTemplates,
    architecturePathGroups: profile.architecturePathGroups,
    generatedFileHints: profile.generatedFileHints,
    generatedFilePaths: profile.generatedFilePaths.filter(
      (repoPath) => !isContextArtifactPath(repoPath),
    ),
    detectedRiskAreas: profile.detectedRiskAreas.filter(
      (area) => area !== "No repo-local agent context files detected.",
    ),
    riskHintPaths: profile.riskHintPaths,
    ownershipHints: profile.ownershipHints,
    environmentFiles: profile.environmentFiles,
    environmentVariables: profile.environmentVariables,
    ignoreFiles: profile.ignoreFiles,
    testFilePaths: profile.testFilePaths,
    reviewRuleCandidates: profile.reviewRuleCandidates,
    evidence: profile.evidence.filter(
      (item) => !isContextArtifactPath(item.path),
    ),
    workspaceManifests: profile.workspaceManifests,
    lockfiles: profile.lockfiles,
    configFiles: profile.configFiles,
    trackedFileHashes: profile.trackedFileHashes.filter(
      (item) => !isContextArtifactPath(item.path),
    ),
    contextArtifactHashes: profile.contextArtifactHashes,
    agentReadiness: {
      categories: profile.agentReadiness.categories.filter((category) =>
        [
          "setup clarity",
          "architecture clarity",
          "testing",
          "CI",
          "docs",
          "risk handling",
        ].includes(category.name),
      ),
      missingItems: profile.agentReadiness.missingItems.filter(
        (item) =>
          !item.startsWith("agent instructions:") &&
          !item.startsWith("generated-file handling:"),
      ),
    },
  };
}

export function planArtifactWrites(input: {
  artifacts: GeneratedArtifact[];
  existingPaths: Set<string>;
  existingGeneratedPaths?: Set<string>;
  force?: boolean;
}): ArtifactWritePlanItem[] {
  return input.artifacts.map((artifact) => {
    const exists = input.existingPaths.has(artifact.type);
    const generated = input.existingGeneratedPaths?.has(artifact.type) ?? false;
    if (!exists) {
      return {
        artifact,
        path: artifact.type,
        action: "write",
        reason: "file is absent",
      };
    }
    if (input.force) {
      return {
        artifact,
        path: artifact.type,
        action: "overwrite",
        reason: "force enabled",
      };
    }
    if (generated) {
      return {
        artifact,
        path: artifact.type,
        action: "overwrite",
        reason: "existing generated file",
      };
    }
    return {
      artifact,
      path: artifact.type,
      action: "skip",
      reason:
        "existing maintainer-owned file preserved; rerun with --force to overwrite",
    };
  });
}

async function buildContextGenerationWritePlan(input: {
  repoId: string;
  artifacts: GeneratedArtifact[];
  targets: ContextArtifactTarget[];
  writePolicy: ContextGenerationWritePolicy;
  inventory: ContextGenerationInventoryPort;
}): Promise<ContextGenerationWritePlan> {
  const existingPaths = await input.inventory.existingPaths(input.repoId);
  const existingGeneratedPaths =
    input.writePolicy.refreshGenerated ||
    input.writePolicy.removeObsoleteGenerated
      ? await input.inventory.existingGeneratedPaths(input.repoId)
      : new Set<string>();
  const writes = planArtifactWrites({
    artifacts: input.artifacts,
    existingPaths,
    ...(input.writePolicy.refreshGenerated ? { existingGeneratedPaths } : {}),
    ...(input.writePolicy.force !== undefined
      ? { force: input.writePolicy.force }
      : {}),
  });
  const artifactPaths = new Set(
    input.artifacts.map((artifact) => artifact.type),
  );
  const obsoleteGeneratedPaths = input.writePolicy.removeObsoleteGenerated
    ? obsoleteGeneratedContextArtifactPaths({
        generatedPaths: existingGeneratedPaths,
        artifactPaths,
        targets: input.targets,
      }).map((repoPath) => ({
        path: repoPath,
        reason: "obsolete generated artifact",
      }))
    : [];

  return {
    writes,
    obsoleteGeneratedPaths,
    rows: [
      ...obsoleteGeneratedPaths.map((item) => ({
        action: "remove",
        target: item.path,
        reason: item.reason,
      })),
      ...writes.map((item) => ({
        action: item.action,
        target: item.path,
        reason: item.reason,
      })),
    ],
  };
}

export function contextArtifactInventoryFromFiles(input: {
  files: ContextSourceFile[];
  nextArtifactVersion: number;
}): ContextGenerationInventoryPort {
  const existingPaths = new Set(input.files.map((file) => file.path));
  const existingGeneratedPaths = new Set(
    input.files
      .filter((file) => isOpenMaintainerGeneratedContent(file.content))
      .map((file) => file.path),
  );
  return {
    async nextArtifactVersion() {
      return input.nextArtifactVersion;
    },
    async existingPaths() {
      return existingPaths;
    },
    async existingGeneratedPaths() {
      return existingGeneratedPaths;
    },
  };
}

function parseStageOutput<T>(
  stage: ContextGenerationStage,
  text: string,
  parse: (text: string) => T,
): T {
  try {
    return parse(text);
  } catch (error) {
    throw new Error(
      `Context generation ${stage} failed: ${errorMessage(error)}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandLines(profile: RepoProfile): string[] {
  return profile.commands.map(
    (command) => `${command.name}: ${command.command} (${command.source})`,
  );
}

function formatCommandFact(command: z.infer<typeof CommandFactSchema>): string {
  return `${command.scope} ${command.name}: ${command.command} (${command.source}; ${command.confidence})`;
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}

function skillSlugFromPath(path: string): string | null {
  return (
    /^\.(?:agents|claude)\/skills\/(?<slug>[a-z0-9][a-z0-9-]*)\/SKILL\.md$/.exec(
      path,
    )?.groups?.["slug"] ?? null
  );
}

function listOrFallback(items: string[], fallback: string): string[] {
  return items.length > 0
    ? items.map((item) => `- ${item}`)
    : [`- ${fallback}`];
}

function stripJsonFence(text: string): string {
  const fence = "```";
  let stripped = text.trim();
  const lower = stripped.toLowerCase();
  if (lower.startsWith(`${fence}json`)) {
    stripped = stripped.slice(`${fence}json`.length).trimStart();
  } else if (stripped.startsWith(fence)) {
    stripped = stripped.slice(fence.length).trimStart();
  }
  if (stripped.endsWith(fence)) {
    stripped = stripped.slice(0, -fence.length).trimEnd();
  }
  return stripped.trim();
}

function selectPromptFileExcerpts(
  files: ContextSourceFile[],
): ContextSourceFile[] {
  const preferredPatterns = [
    /^README\.md$/,
    /^AGENTS\.md$/,
    /^Makefile$/,
    /^contracts\/Scarb\.toml$/,
    /^contracts\/src\/.*\.cairo$/,
    /^contracts\/tests\/.*\.cairo$/,
    /^packages\/frontend\/package\.json$/,
    /^packages\/frontend\/README\.md$/,
    /^packages\/frontend\/src\/.*\.(ts|tsx)$/,
    /^packages\/indexer\/package\.json$/,
    /^packages\/indexer\/README\.md$/,
    /^packages\/indexer\/src\/.*\.ts$/,
    /^docs\/(spec|TEST_QUALITY_AUDIT|INDEXER_FRONTEND_INTEGRATION|EVENTS|SENTRY|HORIZON-SPEC-COMPRESSED)\.md$/,
    /^\.github\/workflows\/.*\.ya?ml$/,
  ];
  const sorted = [...files].sort((left, right) => {
    const leftRank = preferredPatterns.findIndex((pattern) =>
      pattern.test(left.path),
    );
    const rightRank = preferredPatterns.findIndex((pattern) =>
      pattern.test(right.path),
    );
    return (
      rank(leftRank) - rank(rightRank) || left.path.localeCompare(right.path)
    );
  });
  const excerpts: ContextSourceFile[] = [];
  let totalCharacters = 0;
  for (const file of sorted) {
    if (totalCharacters >= 80_000) {
      break;
    }
    const content = file.content.slice(0, 6_000);
    excerpts.push({ path: file.path, content });
    totalCharacters += content.length;
  }
  return excerpts;
}

function rank(value: number): number {
  return value === -1 ? 999 : value;
}
