import YAML from "yaml";
import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  API_PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  ENCRYPTION_KEY: z.string().min(8).optional(),
});
export type Env = z.infer<typeof EnvSchema>;

const IssueTriageClosureConfigSchema = z
  .object({
    allowPossibleSpam: z.boolean().default(false),
    allowStaleAuthorInput: z.boolean().default(false),
    staleAuthorInputDays: z.number().int().positive().default(14),
    maxClosuresPerRun: z.number().int().min(0).default(0),
    requireCommentBeforeClose: z.boolean().default(true),
  })
  .default({});

const IssueTriageLabelsConfigSchema = z
  .object({
    preferUpstream: z.boolean().default(true),
    createMissingPresetLabels: z.boolean().default(false),
    allowOnlyConfiguredOrPreset: z.boolean().default(true),
    mappings: z.record(z.string()).default({}),
  })
  .default({});

const IssueTriageBatchConfigSchema = z
  .object({
    defaultState: z.enum(["open", "closed", "all"]).default("open"),
    includeLabels: z.array(z.string()).default([]),
    excludeLabels: z
      .array(z.string())
      .default([
        "triaged",
        "duplicate",
        "wontfix",
        "invalid",
        "closed",
        "security",
      ]),
    maxIssues: z.number().int().positive().max(100).default(100),
  })
  .default({});

const IssueTriageCommentsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxOneCommentPerIssue: z.boolean().default(true),
    updateExistingComment: z.boolean().default(true),
  })
  .default({});

const IssueTriageConfigSchema = z.object({
  closure: IssueTriageClosureConfigSchema,
  labels: IssueTriageLabelsConfigSchema,
  batch: IssueTriageBatchConfigSchema,
  comments: IssueTriageCommentsConfigSchema,
  mode: z
    .enum(["advisory", "label_only", "comment_and_label"])
    .default("advisory"),
});

const RetentionConfigSchema = z.object({
  localArtifactsMaxAgeDays: z.number().int().positive().max(365),
});

export const OpenMaintainerConfigSchema = z.object({
  version: z.literal(1),
  repo: z.object({
    profileVersion: z.number().int().positive(),
    defaultBranch: z.string(),
  }),
  rules: z.array(z.string()).default([]),
  issueTriage: IssueTriageConfigSchema.optional(),
  retention: RetentionConfigSchema.optional(),
  generated: z.object({
    by: z.literal("open-maintainer"),
    artifactVersion: z.number().int().positive(),
    generatedAt: z.string(),
  }),
});
export type OpenMaintainerConfig = z.infer<typeof OpenMaintainerConfigSchema>;

export type OpenMaintainerConfigDiagnostic = {
  level: "warning";
  path: string;
  message: string;
};

export type OpenMaintainerConfigLoadResult = {
  config: OpenMaintainerConfig;
  diagnostics: OpenMaintainerConfigDiagnostic[];
};

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(env);
}

export function parseOpenMaintainerConfig(
  source: string,
): OpenMaintainerConfig {
  return OpenMaintainerConfigSchema.parse(YAML.parse(source));
}

export function parseOpenMaintainerConfigWithDiagnostics(
  source: string,
): OpenMaintainerConfigLoadResult {
  const parsed = YAML.parse(source) as unknown;
  const root = asRecord(parsed, ".open-maintainer.yml");
  const diagnostics: OpenMaintainerConfigDiagnostic[] = [];
  warnUnknownKeys(
    root,
    "",
    ["version", "repo", "rules", "issueTriage", "retention", "generated"],
    diagnostics,
  );

  const required = z
    .object({
      version: z.literal(1),
      repo: z.object({
        profileVersion: z.number().int().positive(),
        defaultBranch: z.string(),
      }),
      generated: z.object({
        by: z.literal("open-maintainer"),
        artifactVersion: z.number().int().positive(),
        generatedAt: z.string(),
      }),
    })
    .parse(root);

  const configInput: Record<string, unknown> = {
    ...required,
    rules: parseOptionalSection({
      root,
      key: "rules",
      schema: z.array(z.string()).default([]),
      fallback: [],
      diagnostics,
    }),
  };

  if (isRecord(root.repo)) {
    warnUnknownKeys(
      root.repo,
      "repo",
      ["profileVersion", "defaultBranch"],
      diagnostics,
    );
  }
  if (isRecord(root.generated)) {
    warnUnknownKeys(
      root.generated,
      "generated",
      ["by", "artifactVersion", "generatedAt"],
      diagnostics,
    );
  }

  const issueTriage = parseOptionalSection({
    root,
    key: "issueTriage",
    schema: IssueTriageConfigSchema.optional(),
    fallback: undefined,
    diagnostics,
  });
  if (issueTriage !== undefined) {
    configInput.issueTriage = issueTriage;
    warnIssueTriageUnknownKeys(root.issueTriage, diagnostics);
  }

  const retention = parseOptionalSection({
    root,
    key: "retention",
    schema: RetentionConfigSchema.optional(),
    fallback: undefined,
    diagnostics,
  });
  if (retention !== undefined) {
    configInput.retention = retention;
    if (isRecord(root.retention)) {
      warnUnknownKeys(
        root.retention,
        "retention",
        ["localArtifactsMaxAgeDays"],
        diagnostics,
      );
    }
  }

  return {
    config: OpenMaintainerConfigSchema.parse(configInput),
    diagnostics,
  };
}

export function stringifyOpenMaintainerConfig(
  config: OpenMaintainerConfig,
): string {
  return YAML.stringify(OpenMaintainerConfigSchema.parse(config));
}

function parseOptionalSection<T>(input: {
  root: Record<string, unknown>;
  key: string;
  schema: z.ZodType<T>;
  fallback: T;
  diagnostics: OpenMaintainerConfigDiagnostic[];
}): T {
  if (!(input.key in input.root)) {
    return input.fallback;
  }
  const parsed = input.schema.safeParse(input.root[input.key]);
  if (parsed.success) {
    return parsed.data;
  }
  input.diagnostics.push({
    level: "warning",
    path: input.key,
    message: `Ignoring invalid optional config section '${input.key}': ${formatZodIssues(parsed.error)}`,
  });
  return input.fallback;
}

function warnIssueTriageUnknownKeys(
  value: unknown,
  diagnostics: OpenMaintainerConfigDiagnostic[],
): void {
  if (!isRecord(value)) {
    return;
  }
  warnUnknownKeys(
    value,
    "issueTriage",
    ["closure", "labels", "batch", "comments", "mode"],
    diagnostics,
  );
  if (isRecord(value.closure)) {
    warnUnknownKeys(
      value.closure,
      "issueTriage.closure",
      [
        "allowPossibleSpam",
        "allowStaleAuthorInput",
        "staleAuthorInputDays",
        "maxClosuresPerRun",
        "requireCommentBeforeClose",
      ],
      diagnostics,
    );
  }
  if (isRecord(value.labels)) {
    warnUnknownKeys(
      value.labels,
      "issueTriage.labels",
      [
        "preferUpstream",
        "createMissingPresetLabels",
        "allowOnlyConfiguredOrPreset",
        "mappings",
      ],
      diagnostics,
    );
  }
  if (isRecord(value.batch)) {
    warnUnknownKeys(
      value.batch,
      "issueTriage.batch",
      ["defaultState", "includeLabels", "excludeLabels", "maxIssues"],
      diagnostics,
    );
  }
  if (isRecord(value.comments)) {
    warnUnknownKeys(
      value.comments,
      "issueTriage.comments",
      ["enabled", "maxOneCommentPerIssue", "updateExistingComment"],
      diagnostics,
    );
  }
}

function warnUnknownKeys(
  value: Record<string, unknown>,
  prefix: string,
  knownKeys: readonly string[],
  diagnostics: OpenMaintainerConfigDiagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (!knownKeys.includes(key)) {
      const path = prefix ? `${prefix}.${key}` : key;
      diagnostics.push({
        level: "warning",
        path,
        message: `Unknown config key '${path}' will be ignored.`,
      });
    }
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  throw new Error(`${path} must be a YAML mapping.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "value";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
