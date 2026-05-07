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

export const OpenMaintainerConfigSchema = z.object({
  version: z.literal(1),
  repo: z.object({
    profileVersion: z.number().int().positive(),
    defaultBranch: z.string(),
  }),
  rules: z.array(z.string()).default([]),
  issueTriage: z
    .object({
      closure: z
        .object({
          allowPossibleSpam: z.boolean().default(false),
          allowStaleAuthorInput: z.boolean().default(false),
          staleAuthorInputDays: z.number().int().positive().default(14),
          maxClosuresPerRun: z.number().int().min(0).default(0),
          requireCommentBeforeClose: z.boolean().default(true),
        })
        .default({}),
      labels: z
        .object({
          preferUpstream: z.boolean().default(true),
          createMissingPresetLabels: z.boolean().default(false),
          allowOnlyConfiguredOrPreset: z.boolean().default(true),
          mappings: z.record(z.string()).default({}),
        })
        .default({}),
      batch: z
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
          maxIssues: z.number().int().positive().max(100).default(50),
        })
        .default({}),
      comments: z
        .object({
          enabled: z.boolean().default(false),
          maxOneCommentPerIssue: z.boolean().default(true),
          updateExistingComment: z.boolean().default(true),
        })
        .default({}),
      mode: z
        .enum(["advisory", "label_only", "comment_and_label"])
        .default("advisory"),
    })
    .optional(),
  generated: z.object({
    by: z.literal("open-maintainer"),
    artifactVersion: z.number().int().positive(),
    generatedAt: z.string(),
  }),
});
export type OpenMaintainerConfig = z.infer<typeof OpenMaintainerConfigSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(env);
}

export function parseOpenMaintainerConfig(
  source: string,
): OpenMaintainerConfig {
  return OpenMaintainerConfigSchema.parse(YAML.parse(source));
}

export function stringifyOpenMaintainerConfig(
  config: OpenMaintainerConfig,
): string {
  return YAML.stringify(OpenMaintainerConfigSchema.parse(config));
}
