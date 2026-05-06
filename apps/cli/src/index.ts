#!/usr/bin/env bun
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildClaudeCliProvider,
  buildCodexCliProvider,
} from "@open-maintainer/ai";
import {
  type OpenMaintainerConfig,
  type OpenMaintainerConfigDiagnostic,
  parseOpenMaintainerConfigWithDiagnostics,
} from "@open-maintainer/config";
import {
  type ArtifactModel,
  type ContextGenerationStage,
  compareProfileDrift,
  contentHash,
  createContextGenerationOrchestrator,
  createFilesystemContextArtifactSink,
  defaultArtifactTargets,
  expectedArtifactTypes,
  isOpenMaintainerGeneratedContent,
  parseRepoProfileJson,
  profileFingerprint,
  renderReadinessReport,
} from "@open-maintainer/context";
import {
  type ContextPrPublishInput,
  type ContextPrPublisher,
  createContextPrWorkflow,
} from "@open-maintainer/github";
import { renderReviewAgentFeedback } from "@open-maintainer/review";
import type {
  PullRequestReviewRun,
  ReviewInlineCommentResult,
  ReviewPublishOptions,
  ReviewSummaryCommentResult,
  ReviewTriageLabelResult,
} from "@open-maintainer/review";
import type {
  GeneratedArtifact,
  IssueTriageEvidence,
  IssueTriageResult,
  RepoProfile,
} from "@open-maintainer/shared";
import { ArtifactTypeSchema, newId, nowIso } from "@open-maintainer/shared";
import {
  type IssueTriageBatchReport,
  renderIssueTriageBatchGroups,
  renderIssueTriageBatchSummary,
} from "@open-maintainer/triage";
import {
  createCliIssueTriageAdapters,
  createIssueTriageUseCases,
} from "./issue-triage-use-cases";
import {
  defaultLocalArtifactRetentionDays,
  findExpiredLocalArtifacts,
  removeLocalArtifacts,
} from "./local-artifacts";
import {
  type CliRepositoryReference,
  type PersistedRepositoryArtifacts,
  persistRepositoryReferenceArtifacts,
  resolveCliRepositoryReference,
} from "./repository-reference";
import { createCliRepositoryWorkspace } from "./repository-workspace";
import {
  type ReviewOperationModelProvider,
  type ReviewOperationRequest,
  createReviewOperationRuntime,
} from "./review-operation";

type CliOptions = {
  force: boolean;
  refreshGenerated: boolean;
  doctorFix: boolean;
  dryRun: boolean;
  createPr: boolean;
  failOnScoreBelow: number | null;
  reportPath: string | null;
  noProfileWrite: boolean;
  model: ArtifactModel | null;
  context: ArtifactSelection | null;
  skills: ArtifactSelection | null;
  allowWrite: boolean;
  llmModel: string | null;
  pr: number | null;
  baseRef: string | null;
  headRef: string | null;
  prNumber: number | null;
  outputPath: string | null;
  json: boolean;
  reviewProvider: ArtifactModel | null;
  reviewModel: string | null;
  allowModelContentTransfer: boolean;
  reviewPostSummary: boolean;
  reviewInlineComments: boolean;
  reviewInlineCap: number | null;
  reviewApplyTriageLabel: boolean;
  reviewCreateTriageLabels: boolean;
  issueNumber: number | null;
  triageState: "open" | "closed" | "all";
  triageLimit: number | null;
  triageLabel: string | null;
  triageIncludeLabels: string[];
  triageExcludeLabels: string[];
  triageOnlySignals: string[];
  triageMinConfidence: number | null;
  triageFormat: "table" | "json" | "markdown" | null;
  reviewFormat: "markdown" | "agent-feedback" | null;
  issueApplyLabels: boolean;
  issueCreateLabels: boolean;
  issuePostComment: boolean;
  issueCloseAllowed: boolean;
  issueBriefAllowNonAgentReady: boolean;
  refreshBranch: string | null;
  refreshTitle: string | null;
  auditSummaryPath: string | null;
};

type ArtifactSelection = "codex" | "claude" | "both";

const repositoryWorkspace = createCliRepositoryWorkspace();
const execFileAsync = promisify(execFile);

const rootUsage = `open-maintainer <command> <repo>

Commands:
  audit <repo>                         Analyze repo and write .open-maintainer/profile.json and report.md
  generate <repo> --model codex --context codex --skills codex
                                       Generate context artifacts safely
  init <repo>                           Run audit, then generate missing artifacts
  doctor <repo>                         Report missing or stale generated context
  review <repo>                         Produce or post a rule-grounded PR review
  triage issue <repo>                   Preview model-backed triage for one issue
  triage issues <repo>                  Preview model-backed triage for a bounded issue batch
  triage brief <repo>                   Generate an agent-safe task brief from a local triage artifact
  pr <repo> --create                    Print a dry-run PR summary for generated artifacts
  context-pr <repo> --create            Open or update a context refresh PR with git and gh

Help:
  open-maintainer --help
  open-maintainer help
  open-maintainer help <command>
  open-maintainer <command> --help
  open-maintainer <command> help

Repository arguments:
  <repo> is a local worktree path. audit, review, and triage issue/issues also accept https://github.com/OWNER/REPO URLs; URL-backed artifacts are copied under .open-maintainer/url-repos/OWNER/REPO before the temporary checkout is removed.
`;

const commandUsages = {
  audit: `open-maintainer audit <repo>

Analyze a repository and write an agent-readiness profile and markdown report.

Writes:
  .open-maintainer/profile.json
  .open-maintainer/report.md

Options:
  --fail-on-score-below <number>        Exit non-zero when audit score is below threshold
  --report-path <path>                  Write audit report to a custom path
  --no-profile-write                    Skip .open-maintainer/profile.json writes
  --dry-run                             Print planned audit outputs without writing files

Examples:
  open-maintainer audit .
  open-maintainer audit https://github.com/OWNER/REPO
  open-maintainer audit ./repo --fail-on-score-below 60
  open-maintainer audit ./repo --dry-run
  open-maintainer audit ./repo --report-path .open-maintainer/report.md --no-profile-write
`,
  generate: `open-maintainer generate <repo>

Generate repository context artifacts safely. Existing files are preserved unless --force is used.

Required artifact target:
  --context codex|claude|both           Generate AGENTS.md, CLAUDE.md, or both
  --skills codex|claude|both            Generate .agents skills, .claude skills, or both

Model options:
  --model codex|claude                  LLM CLI backend used to generate artifact bodies
  --llm-model <model>                   Optional backend model override
  --allow-write                         Required with --model; permits model-backed artifact writes

Write options:
  --force                               Overwrite existing generated artifact files
  --refresh-generated                   Overwrite only existing Open Maintainer generated files
  --dry-run                             Print planned writes without writing files

Examples:
  open-maintainer generate ./repo --model codex --context codex --skills codex --allow-write
  open-maintainer generate ./repo --model claude --context claude --skills claude --allow-write
  open-maintainer generate ./repo --model codex --context both --skills both --allow-write
`,
  init: `open-maintainer init <repo>

Run audit, then generate missing context artifacts.

Audit options:
  --fail-on-score-below <number>        Exit non-zero when audit score is below threshold
  --report-path <path>                  Write audit report to a custom path
  --no-profile-write                    Skip .open-maintainer/profile.json writes during audit

Generate options:
  --model codex|claude                  LLM CLI backend used to generate artifact bodies
  --context codex|claude|both           Generate AGENTS.md, CLAUDE.md, or both
  --skills codex|claude|both            Generate .agents skills, .claude skills, or both
  --llm-model <model>                   Optional backend model override
  --allow-write                         Required with --model; permits model-backed artifact writes
  --force                               Overwrite existing generated artifact files
  --refresh-generated                   Overwrite only existing Open Maintainer generated files
  --dry-run                             Print planned writes without writing files

Examples:
  open-maintainer init ./repo --model codex --context codex --skills codex --allow-write
`,
  doctor: `open-maintainer doctor <repo>

Check that required generated context artifacts are present and that the stored profile is not stale.

Options:
  --fix                                Remove obsolete context artifacts and expired local operational artifacts
  --dry-run                            With --fix, print planned fixes without writing files

Outputs:
  Agent readiness score
  Missing required artifacts, if any
  Profile drift, if detected
  Config diagnostics and expired local operational artifacts, if detected

Examples:
  open-maintainer doctor .
  open-maintainer doctor . --fix
  open-maintainer doctor . --fix --dry-run
  open-maintainer doctor ./repo
`,
  review: `open-maintainer review <repo>

Produce a rule-grounded PR review from local git refs or a GitHub pull request. Local ref review is non-mutating by default. PR review fetches pull request refs with gh and posts marked summary plus capped inline comments unless --dry-run is used.

Diff options:
  --pr <number>                          Fetch PR metadata/diff with gh and post review comments
  --base-ref <ref>                      Base ref or SHA for the review diff
  --head-ref <ref>                      Head ref or SHA for the review diff (default: HEAD)
  --pr-number <number>                  Optional PR number metadata

Output options:
  --output-path <path>                  Write markdown review output to a file
  --format markdown|agent-feedback      Choose rich markdown or compact numbered agent feedback
  --json                                Print the machine-readable ReviewResult JSON
  --dry-run                             Preview writes; with --pr, review without posting to GitHub

Model review options:
  --model codex|claude                  Required CLI backend for model-backed review
  --llm-model <model>                   Optional backend model override
  --allow-model-content-transfer        Required with --model; sends repo content to the backend
  --review-provider codex|claude        Alias for --model, kept for existing scripts
  --review-model <model>                Alias for --llm-model, kept for existing scripts

Posting options:
  --review-post-summary                 Post or update the marked PR summary comment
  --review-inline-comments              Post capped inline finding comments
  --review-inline-cap <number>          Maximum inline comments (default with --pr: 5)
  --review-apply-triage-label           Apply one filterable PR label from the contribution-triage category
  --review-create-triage-labels         Create missing Open Maintainer PR triage labels before applying

Examples:
  open-maintainer review . --base-ref main --head-ref HEAD
  open-maintainer review . --base-ref origin/main --head-ref HEAD --output-path .open-maintainer/review.md
  open-maintainer review . --base-ref main --head-ref HEAD --format agent-feedback
  open-maintainer review . --base-ref main --head-ref HEAD --json
  open-maintainer review . --base-ref main --head-ref HEAD --model codex --allow-model-content-transfer
  open-maintainer review . --pr 123 --model codex --allow-model-content-transfer
  open-maintainer review https://github.com/OWNER/REPO --pr 123 --model codex --allow-model-content-transfer --dry-run
  open-maintainer review . --pr 123 --model claude --allow-model-content-transfer --dry-run
`,
  triage: `open-maintainer triage issue <repo> --number <n>
open-maintainer triage issues <repo> --state open --limit <n>
open-maintainer triage brief <repo> --number <n>

Run local, non-mutating model-backed triage for one GitHub issue or a bounded issue batch.
Generate agent task briefs from existing local triage artifacts without refetching GitHub evidence.

Single-issue required:
  --number <n>                          GitHub issue number to triage

Batch options:
  --state open|closed|all                Issue state to list (default: open)
  --limit <n>                            Maximum issues to triage before model calls (default: 100, max: 100)
  --label <name>                         Optional label filter for the issue list
  --include-label <name>                 Additional label filter for the issue list
  --exclude-label <name>                 Skip issues with this label
                                         Without include filters, already-labelled issues are skipped
  --only <signals>                       Apply only comma-separated triage signals
  --min-confidence <n>                   Skip label application below confidence 0..1
  --format table|json|markdown           Choose batch console/output formatting
  --output <path>                        Write a batch report to a custom path
  --apply                                Apply deterministically resolved issue labels
  --apply-labels                         Alias for --apply
  --create-missing-preset-labels         Create missing preset labels; requires --apply
  --create-labels                        Alias for --create-missing-preset-labels
  --post-comment                         Post or update the marked Open Maintainer issue triage comment
  --close-allowed                        Allow config-gated selective issue closure
  --dry-run                              Preview local artifacts and GitHub writes without applying them

Brief options:
  --allow-non-agent-ready                Generate a task brief despite non-agent-ready triage
  --output-path <path>                   Write generated task brief markdown to a file

Model required:
  --model codex|claude                  CLI backend used for model-backed triage
  --allow-model-content-transfer        Required; sends issue evidence and repo context to the backend

Model options:
  --llm-model <model>                   Optional backend model override

Console options:
  --json                                Print the machine-readable triage result or batch report JSON

Output:
  .open-maintainer/triage/issues/<n>.json
  .open-maintainer/triage/runs/<run-id>.json
  .open-maintainer/triage/runs/<run-id>.md

Examples:
  open-maintainer triage issue . --number 82 --model codex --allow-model-content-transfer
  open-maintainer triage issues . --state open --limit 5 --model codex --allow-model-content-transfer
  open-maintainer triage issue https://github.com/OWNER/REPO --number 82 --model codex --allow-model-content-transfer --dry-run
  open-maintainer triage issues https://github.com/OWNER/REPO --limit 5 --model codex --allow-model-content-transfer --dry-run
  open-maintainer triage brief . --number 82
  open-maintainer triage issue . --number 82 --model claude --allow-model-content-transfer
`,
  pr: `open-maintainer pr <repo> --create

Print a dry-run context PR summary for generated artifacts.

Options:
  --create                              Required; print the dry-run PR summary
  --dry-run                             Accepted for consistency; this command is always non-mutating

Examples:
  open-maintainer pr ./repo --create
`,
  "context-pr": `open-maintainer context-pr <repo> --create

Open or update a context refresh pull request for already-generated artifacts.

Options:
  --create                              Required; open or update the PR
  --refresh-branch <branch>             Branch used for the context refresh PR
  --refresh-title <title>               Pull request title
  --base-ref <branch>                   Base branch for the pull request
  --audit-summary-path <path>           Markdown audit summary included in the PR body
  --force                               Overwrite maintainer-owned context files

Examples:
  open-maintainer context-pr . --create --refresh-branch open-maintainer/context-refresh
`,
} as const;

type CommandName = keyof typeof commandUsages;

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
} as const;

function color(value: string, ...codes: string[]): string {
  if (process.env["OPEN_MAINTAINER_FORCE_COLOR"] === "1") {
    return `${codes.join("")}${value}${ansi.reset}`;
  }
  if (
    process.env["NO_COLOR"] ||
    process.env["OPEN_MAINTAINER_NO_COLOR"] === "1" ||
    !process.stdout.isTTY
  ) {
    return value;
  }
  return `${codes.join("")}${value}${ansi.reset}`;
}

function visibleLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 27 && value[index + 1] === "[") {
      index += 2;
      while (index < value.length && value[index] !== "m") {
        index += 1;
      }
      continue;
    }
    length += 1;
  }
  return length;
}

function padVisible(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function printLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

function commandHeader(input: {
  title: string;
  repoRoot?: string;
  dryRun?: boolean;
}): string[] {
  const title = color(`Open Maintainer ${input.title}`, ansi.bold, ansi.cyan);
  const details = [
    ...(input.repoRoot ? [`Repository: ${input.repoRoot}`] : []),
    ...(input.dryRun
      ? ["Mode: dry-run (planned changes only; no files or GitHub writes)"]
      : []),
  ];
  const width = Math.max(
    visibleLength(title),
    ...details.map(visibleLength),
    32,
  );
  const border = color(`+${"=".repeat(width + 2)}+`, ansi.cyan);
  return [
    border,
    `| ${padVisible(title, width)} |`,
    ...details.map((detail) =>
      detail.startsWith("Mode:")
        ? `| ${padVisible(color(detail, ansi.yellow), width)} |`
        : `| ${padVisible(color(detail, ansi.dim), width)} |`,
    ),
    border,
    "",
  ];
}

function renderBox(title: string, lines: string[]): string[] {
  const styledTitle = color(title, ansi.bold, ansi.magenta);
  const width = Math.max(
    visibleLength(styledTitle),
    ...lines.map(visibleLength),
    20,
  );
  return [
    color(`+${"-".repeat(width + 2)}+`, ansi.dim),
    `| ${padVisible(styledTitle, width)} |`,
    color(`+${"-".repeat(width + 2)}+`, ansi.dim),
    ...lines.map((line) => `| ${padVisible(styleStatusLine(line), width)} |`),
    color(`+${"-".repeat(width + 2)}+`, ansi.dim),
  ];
}

function renderActionPlan(
  title: string,
  rows: Array<{ action: string; target: string; reason: string }>,
): string[] {
  if (rows.length === 0) {
    return renderBox(title, ["No actions planned."]);
  }
  const actionOrder = ["write", "overwrite", "remove", "skip", "failed"];
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.action, (counts.get(row.action) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort(
      ([left], [right]) =>
        actionOrder.indexOf(left) - actionOrder.indexOf(right),
    )
    .map(([action, count]) => `${styleAction(action)} ${count}`)
    .join(", ");
  const lines = [
    color(title, ansi.bold, ansi.magenta),
    `${color(`${rows.length} planned actions:`, ansi.dim)} ${summary}`,
  ];
  for (const action of actionOrder) {
    const group = rows.filter((row) => row.action === action);
    if (group.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(`${styleAction(action)} (${group.length})`);
    for (const row of group) {
      lines.push(`  - ${styleAction(row.action)}: ${row.target}`);
      lines.push(`    ${color(row.reason, ansi.dim)}`);
    }
  }
  return lines;
}

function styleAction(action: string): string {
  if (action === "write" || action === "overwrite" || action === "applied") {
    return color(action, ansi.green);
  }
  if (action === "remove" || action === "failed") {
    return color(action, ansi.red);
  }
  if (action === "skip" || action === "skipped") {
    return color(action, ansi.yellow);
  }
  return color(action, ansi.cyan);
}

function styleStatusLine(line: string): string {
  if (
    line.includes("failed") ||
    line.startsWith("missing:") ||
    line.startsWith("drift:") ||
    line.startsWith("obsolete:") ||
    line.startsWith("retention:")
  ) {
    return color(line, ansi.red);
  }
  if (
    line.includes("Dry run:") ||
    line.includes("(planned)") ||
    line.startsWith("Mode:") ||
    line.startsWith("config warning:")
  ) {
    return color(line, ansi.yellow);
  }
  if (
    line.includes("all required artifacts are present") ||
    line.includes("applied") ||
    line.includes("Agent Readiness: 100/")
  ) {
    return color(line, ansi.green);
  }
  return line;
}

function renderAuditSummary(input: {
  repoRoot: string;
  profile: RepoProfile;
  reportPath: string;
  options: CliOptions;
  configDiagnostics: string[];
}): string[] {
  const profilePath = ".open-maintainer/profile.json";
  const reportPath = path.relative(input.repoRoot, input.reportPath);
  return [
    ...commandHeader({
      title: "audit",
      repoRoot: input.repoRoot,
      dryRun: input.options.dryRun,
    }),
    ...renderBox("Readiness", [
      `Agent Readiness: ${input.profile.agentReadiness.score}/100`,
      input.options.noProfileWrite
        ? "Profile: skipped (--no-profile-write)"
        : `Profile: ${profilePath}${input.options.dryRun ? " (planned)" : ""}`,
      `Report: ${reportPath}${input.options.dryRun ? " (planned)" : ""}`,
      ...(input.options.dryRun ? ["Dry run: no audit files written."] : []),
    ]),
    ...(input.configDiagnostics.length > 0
      ? ["", ...renderBox("Config diagnostics", input.configDiagnostics)]
      : []),
    ...formatReadinessSuggestions(input.profile),
  ];
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    printLines(commandHeader({ title: "help" }));
    console.log(rootUsage);
    return 0;
  }
  if (command === "help") {
    const helpCommand = rest[0];
    if (isCommandName(helpCommand)) {
      printLines(commandHeader({ title: `${helpCommand} help` }));
      console.log(commandUsages[helpCommand]);
      return 0;
    }
    printLines(commandHeader({ title: "help" }));
    console.log(rootUsage);
    return 0;
  }
  if (!isCommandName(command)) {
    console.error(`Unknown command: ${command}\n`);
    console.error(rootUsage);
    return 2;
  }
  if (rest.some(isHelpToken)) {
    printLines(commandHeader({ title: `${command} help` }));
    console.log(commandUsages[command]);
    return 0;
  }

  if (command === "triage") {
    const [subcommand, repoArg, ...rawOptions] = rest;
    if (
      subcommand !== "issue" &&
      subcommand !== "issues" &&
      subcommand !== "brief"
    ) {
      console.error(
        "Unknown triage command. Expected: triage issue, triage issues, or triage brief\n",
      );
      console.error(commandUsages.triage);
      return 2;
    }
    if (!repoArg) {
      console.error("Missing repository path.\n");
      console.error(commandUsages.triage);
      return 2;
    }
    try {
      const options = parseOptions(rawOptions);
      assertTriageOptionsBeforeRepository(subcommand, options);
      return await runWithRepositoryReference({
        repoArg,
        command: "triage",
        options,
        async run(repoRoot) {
          if (subcommand === "issue") {
            await triageIssue(repoRoot, options);
          } else if (subcommand === "issues") {
            await triageIssues(repoRoot, options);
          } else {
            await triageBrief(repoRoot, options);
          }
          return 0;
        },
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  const [repoArg, ...rawOptions] = rest;
  if (!repoArg) {
    console.error("Missing repository path.\n");
    console.error(commandUsages[command]);
    return 2;
  }

  try {
    const options = parseOptions(rawOptions);
    if (command === "audit") {
      return await runWithRepositoryReference({
        repoArg,
        command: "audit",
        options,
        async run(repoRoot) {
          const { profile, reportPath } = await audit(repoRoot, options);
          printLines(
            renderAuditSummary({
              repoRoot,
              profile,
              reportPath,
              options,
              configDiagnostics: await configDiagnosticMessages(repoRoot),
            }),
          );
          return thresholdExit(profile.agentReadiness.score, options);
        },
      });
    }
    if (command === "review") {
      assertReviewOptions(options);
      return await runWithRepositoryReference({
        repoArg,
        command: "review",
        options,
        async run(repoRoot) {
          await review(repoRoot, options);
          return 0;
        },
      });
    }

    const repoRoot = path.resolve(repoArg);
    switch (command) {
      case "generate":
        await generate(repoRoot, options);
        return 0;
      case "init": {
        printLines(
          commandHeader({
            title: "init",
            repoRoot,
            dryRun: options.dryRun,
          }),
        );
        await audit(repoRoot, options);
        await generate(repoRoot, options);
        const { profile } = await audit(repoRoot, options);
        console.log(
          `Initialized Open Maintainer context at score ${profile.agentReadiness.score}/100.`,
        );
        if (options.dryRun) {
          console.log("Dry run: no init files written.");
        }
        return thresholdExit(profile.agentReadiness.score, options);
      }
      case "doctor": {
        printLines(
          commandHeader({
            title: "doctor",
            repoRoot,
            dryRun: options.dryRun,
          }),
        );
        let result = await doctor(repoRoot, repoArg);
        printLines(renderBox("Context health", result.messages));
        if (!result.ok && options.doctorFix) {
          const fixActions: Array<{
            action: string;
            target: string;
            reason: string;
          }> = [];
          if (result.fixablePaths.length > 0) {
            fixActions.push(
              ...result.fixablePaths.map((item) => ({
                action: "remove",
                target: item,
                reason: "obsolete generated artifact",
              })),
            );
            await removeDoctorFixableArtifacts(
              repoRoot,
              result.fixablePaths,
              options,
            );
          }
          if (result.retentionFixablePaths.length > 0) {
            fixActions.push(
              ...result.retentionFixablePaths.map((item) => ({
                action: "remove",
                target: item,
                reason: "expired local operational artifact",
              })),
            );
            await removeLocalArtifacts({
              repoRoot,
              paths: result.retentionFixablePaths,
              dryRun: options.dryRun,
            });
          }
          if (result.profileNeedsRefresh) {
            await audit(repoRoot, {
              ...options,
              noProfileWrite: false,
              reportPath: null,
            });
            console.log(
              options.dryRun
                ? "fix: would refresh .open-maintainer/profile.json and .open-maintainer/report.md"
                : "fix: refreshed .open-maintainer/profile.json and .open-maintainer/report.md",
            );
            fixActions.push({
              action: options.dryRun ? "skip" : "overwrite",
              target:
                ".open-maintainer/profile.json, .open-maintainer/report.md",
              reason: options.dryRun
                ? "profile/report refresh planned"
                : "profile/report refreshed",
            });
          }
          if (fixActions.length > 0) {
            printLines(renderActionPlan("Doctor fix plan", fixActions));
          }
          if (options.dryRun) {
            console.log("Dry run: no doctor fixes applied.");
            return 1;
          }
          result = await doctor(repoRoot, repoArg);
          printLines(renderBox("Context health after fix", result.messages));
        }
        return result.ok ? 0 : 1;
      }
      case "pr":
        await pr(repoRoot, options);
        return 0;
      case "context-pr":
        await contextPr(repoRoot, options);
        return 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runWithRepositoryReference(input: {
  repoArg: string;
  command: "audit" | "review" | "triage";
  options: CliOptions;
  run(repoRoot: string, reference: CliRepositoryReference): Promise<number>;
}): Promise<number> {
  const reference = await resolveCliRepositoryReference(input.repoArg);
  let artifactNotice: PersistedRepositoryArtifacts | null = null;
  let completed = false;
  try {
    const exitCode = await input.run(reference.repoRoot, reference);
    artifactNotice = input.options.dryRun
      ? null
      : await persistRepositoryReferenceArtifacts(
          reference,
          artifactPathsForRepositoryReference(input.command, input.options),
        );
    completed = true;
    return exitCode;
  } finally {
    await reference.cleanup();
    if (completed) {
      printRepositoryReferenceNotice(reference, artifactNotice, input.options);
    }
  }
}

function artifactPathsForRepositoryReference(
  command: "audit" | "review" | "triage",
  options: CliOptions,
): string[] {
  const paths = new Set([".open-maintainer"]);
  if (command === "audit" && options.reportPath) {
    paths.add(options.reportPath);
  }
  if ((command === "review" || command === "triage") && options.outputPath) {
    paths.add(options.outputPath);
  }
  return [...paths];
}

function printRepositoryReferenceNotice(
  reference: CliRepositoryReference,
  artifacts: PersistedRepositoryArtifacts | null,
  options: CliOptions,
): void {
  if (reference.kind !== "github-url") {
    return;
  }
  const lines = [
    `Source: ${reference.url}`,
    `Temporary checkout: ${reference.repoRoot} (removed)`,
    ...(options.dryRun
      ? ["Artifacts: none written because this was a dry run"]
      : artifacts && artifacts.copiedPaths.length > 0
        ? [
            `Artifacts copied to: ${formatDisplayPath(artifacts.artifactRoot)}`,
            ...artifacts.copiedPaths.map((artifactPath) => `- ${artifactPath}`),
          ]
        : [
            "Artifacts copied: none; no relative artifacts were written by this command",
          ]),
  ];
  const output = renderBox("GitHub URL workspace", lines).join("\n");
  if (options.json) {
    console.error(output);
    return;
  }
  console.log(output);
}

function formatDisplayPath(value: string): string {
  const relative = path.relative(process.cwd(), value);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : value;
}

function assertTriageOptionsBeforeRepository(
  subcommand: "issue" | "issues" | "brief",
  options: CliOptions,
): void {
  if (options.reviewFormat === "agent-feedback") {
    throw new Error("--format agent-feedback is only supported by review.");
  }
  if (subcommand === "brief") {
    return;
  }
  if (options.issueCreateLabels && !options.issueApplyLabels) {
    throw new Error("--create-labels requires --apply-labels.");
  }
  if (!options.model) {
    throw new Error(
      "triage issue requires --model codex or --model claude because issue triage is LLM-backed only.",
    );
  }
  if (!options.allowModelContentTransfer) {
    throw new Error(
      "--model requires --allow-model-content-transfer because issue triage sends repository context and issue content to the selected CLI backend.",
    );
  }
}

async function audit(
  repoRoot: string,
  options: CliOptions,
): Promise<{ profile: RepoProfile; reportPath: string }> {
  await loadOpenMaintainerConfigState(repoRoot);
  const profile = await repositoryWorkspace.profile(repoRoot);
  const openMaintainerDir = path.join(repoRoot, ".open-maintainer");
  const storedProfile = await readFile(
    path.join(openMaintainerDir, "profile.json"),
    "utf8",
  )
    .then(parseRepoProfileJson)
    .catch(() => null);
  const driftFindings = storedProfile
    ? compareProfileDrift({ stored: storedProfile, current: profile })
    : [];
  if (!options.noProfileWrite && !options.dryRun) {
    await mkdir(openMaintainerDir, { recursive: true });
    await writeFile(
      path.join(openMaintainerDir, "profile.json"),
      `${JSON.stringify(
        {
          ...profile,
          openMaintainerProfileHash: profileFingerprint(profile),
        },
        null,
        2,
      )}\n`,
    );
  }
  const reportPath = options.reportPath
    ? path.resolve(repoRoot, options.reportPath)
    : path.join(openMaintainerDir, "report.md");
  if (!options.dryRun) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      renderReadinessReport(profile, { driftFindings }),
    );
  }
  return { profile, reportPath };
}

async function generate(repoRoot: string, options: CliOptions): Promise<void> {
  printLines(
    commandHeader({
      title: "generate",
      repoRoot,
      dryRun: options.dryRun,
    }),
  );
  assertGenerationTargetsSelected(options);
  if (!options.model) {
    throw new Error(
      "generate requires --model codex or --model claude for LLM-backed artifact content.",
    );
  }
  const orchestrator = createContextGenerationOrchestrator({
    repository: {
      scan: (scanRepoRoot, options) =>
        repositoryWorkspace.scan(scanRepoRoot, options),
      profile: (profileRepoRoot, files) =>
        repositoryWorkspace.profile({ repoRoot: profileRepoRoot, files }),
    },
    defaultSink: createFilesystemContextArtifactSink(),
  });
  const result = await orchestrator.generateForWorktree({
    repoRoot,
    model: createCliContextGenerationModelPort({
      repoRoot,
      model: options.model,
      llmModel: options.llmModel,
      allowWrite: options.allowWrite,
    }),
    selection: {
      ...(options.context ? { context: options.context } : {}),
      ...(options.skills ? { skills: options.skills } : {}),
    },
    writeMode: {
      kind: options.dryRun ? "preview" : "write",
      force: options.force,
      refreshGenerated: options.refreshGenerated,
      removeObsoleteGenerated: options.force,
    },
  });
  printLines(renderActionPlan("Artifact write plan", result.plan.rows));
  if (options.dryRun) {
    console.log("Dry run: no context artifacts written.");
  }
}

function createCliContextGenerationModelPort(input: {
  repoRoot: string;
  model: ArtifactModel;
  llmModel: string | null;
  allowWrite: boolean;
}) {
  if (!input.allowWrite) {
    throw new Error(
      "--model requires --allow-write because repository content will be sent to the selected CLI backend.",
    );
  }
  const model =
    input.llmModel ??
    (input.model === "codex"
      ? process.env["OPEN_MAINTAINER_CODEX_MODEL"]
      : process.env["OPEN_MAINTAINER_CLAUDE_MODEL"]) ??
    null;
  const providerLabel = input.model === "codex" ? "Codex CLI" : "Claude CLI";
  const label = input.model;
  return {
    providerLabel,
    model,
    async complete(
      prompt: { system: string; user: string },
      options: { outputSchema: unknown; stage: ContextGenerationStage },
    ) {
      const stageLabel =
        options.stage === "repo-facts"
          ? "analyzing repo evidence"
          : options.stage === "artifact-content"
            ? "generating artifact content"
            : "generating workflow skills";
      console.log(`${label}: ${stageLabel}${model ? ` with ${model}` : ""}`);
      const provider =
        input.model === "codex"
          ? buildCodexCliProvider({
              cwd: input.repoRoot,
              ...(model ? { model } : {}),
              outputSchema: options.outputSchema,
            })
          : buildClaudeCliProvider({
              cwd: input.repoRoot,
              ...(model ? { model } : {}),
              outputSchema: options.outputSchema,
            });
      return provider.complete(prompt);
    },
  };
}

async function doctor(
  repoRoot: string,
  repoDisplayPath = repoRoot,
): Promise<{
  ok: boolean;
  messages: string[];
  fixablePaths: string[];
  retentionFixablePaths: string[];
  profileNeedsRefresh: boolean;
}> {
  const configState = await loadOpenMaintainerConfigState(repoRoot);
  const retentionDays =
    configState.config?.retention?.localArtifactsMaxAgeDays ??
    defaultLocalArtifactRetentionDays;
  const files = await repositoryWorkspace.scan(repoRoot);
  const profile = await repositoryWorkspace.profile({ repoRoot, files });
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const paths = new Set(filesByPath.keys());
  const currentProfileHash = profileFingerprint(profile);
  const storedProfile = filesByPath.get(".open-maintainer/profile.json");
  const driftFindings = storedProfile
    ? compareProfileDrift({
        stored: parseRepoProfileJson(storedProfile.content) ?? profile,
        current: profile,
      })
    : [];
  const parsedStoredProfile = storedProfile
    ? (parseRepoProfileJson(storedProfile.content) ?? null)
    : null;
  const storedContextHashes = new Map(
    parsedStoredProfile?.contextArtifactHashes.map((item) => [
      item.path,
      item.hash,
    ]) ?? [],
  );
  const required = doctorRequiredArtifacts(profile, storedContextHashes);
  const requiredPaths = new Set(required);
  const missing = required.filter(
    (artifactPath) => !requiredArtifactPresent(artifactPath, paths),
  );
  const stale = required.filter((artifactPath) => {
    const file = filesByPath.get(artifactPath);
    if (!file) {
      return false;
    }
    if (artifactPath === ".open-maintainer/profile.json") {
      return !file.content.includes(currentProfileHash);
    }
    const storedHash = storedContextHashes.get(artifactPath);
    if (storedHash) {
      return contentHash(file.content) !== storedHash;
    }
    return (
      file.content.includes("generated by open-maintainer") &&
      !file.content.includes(`profileHash=${currentProfileHash}`)
    );
  });
  const obsolete = doctorObsoleteGeneratedArtifacts({
    files,
    expectedPaths: requiredPaths,
    storedContextHashes,
  });
  const expiredArtifacts = await findExpiredLocalArtifacts({
    repoRoot,
    maxAgeDays: retentionDays,
  });
  const fixablePaths = obsolete;
  const retentionFixablePaths = expiredArtifacts.map(
    (artifact) => artifact.path,
  );
  const profileNeedsRefresh =
    stale.includes(".open-maintainer/profile.json") || driftFindings.length > 0;
  const fixCommand =
    fixablePaths.length > 0 ||
    retentionFixablePaths.length > 0 ||
    profileNeedsRefresh
      ? formatDoctorFixCommand({
          repoPath: repoDisplayPath,
        })
      : null;
  return {
    ok:
      missing.length === 0 &&
      stale.length === 0 &&
      obsolete.length === 0 &&
      driftFindings.length === 0 &&
      expiredArtifacts.length === 0,
    messages: [
      `Agent Readiness: ${profile.agentReadiness.score}/100`,
      ...configState.diagnostics.map(
        (diagnostic) => `config warning: ${diagnostic.message}`,
      ),
      ...(missing.length > 0
        ? missing.map((item) => `missing: ${item}`)
        : ["all required artifacts are present"]),
      ...driftFindings.map(formatDriftFinding),
      ...stale.map(
        (item) =>
          `drift: ${item} was generated from a different repository profile`,
      ),
      ...obsolete.map(
        (item) =>
          `obsolete: ${item} is a generated context artifact no longer tracked by .open-maintainer/profile.json`,
      ),
      ...expiredArtifacts.map(
        (artifact) =>
          `retention: ${artifact.path} is ${artifact.ageDays} days old, exceeding local artifact retention of ${retentionDays} days`,
      ),
      ...(fixCommand ? [`fix: ${fixCommand}`] : []),
    ],
    fixablePaths,
    retentionFixablePaths,
    profileNeedsRefresh,
  };
}

function doctorRequiredArtifacts(
  profile: RepoProfile,
  storedContextHashes: Map<string, string>,
): string[] {
  if (storedContextHashes.size === 0) {
    return expectedArtifactTypes({
      profile,
      targets: defaultArtifactTargets,
    });
  }
  return [
    ...storedContextHashes.keys(),
    ".open-maintainer/profile.json",
    ".open-maintainer/report.md",
  ];
}

function doctorObsoleteGeneratedArtifacts(input: {
  files: Awaited<ReturnType<typeof repositoryWorkspace.scan>>;
  expectedPaths: Set<string>;
  storedContextHashes: Map<string, string>;
}): string[] {
  if (input.storedContextHashes.size === 0) {
    return [];
  }
  return input.files
    .filter((file) => isGeneratedContextArtifactPath(file.path))
    .filter((file) => isOpenMaintainerGeneratedContent(file.content))
    .map((file) => file.path)
    .filter((filePath) => !input.expectedPaths.has(filePath))
    .sort();
}

function isGeneratedContextArtifactPath(repoPath: string): boolean {
  return (
    repoPath === "AGENTS.md" ||
    repoPath === "CLAUDE.md" ||
    repoPath === ".open-maintainer.yml" ||
    repoPath === ".github/copilot-instructions.md" ||
    repoPath === ".cursor/rules/open-maintainer.md" ||
    repoPath.startsWith(".agents/skills/") ||
    repoPath.startsWith(".claude/skills/")
  );
}

async function removeDoctorFixableArtifacts(
  repoRoot: string,
  fixablePaths: string[],
  options: CliOptions,
): Promise<void> {
  if (fixablePaths.length === 0) {
    console.log(
      "fix: no obsolete generated artifacts can be removed automatically",
    );
    return;
  }
  for (const item of fixablePaths) {
    if (!options.dryRun) {
      await rm(path.join(repoRoot, item), { force: true });
    }
  }
}

function formatDoctorFixCommand({ repoPath }: { repoPath: string }): string {
  return ["bun run cli doctor", shellQuote(repoPath), "--fix"].join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatDriftFinding(
  finding: ReturnType<typeof compareProfileDrift>[number],
): string {
  if (finding.group === "ci") {
    return `drift: CI workflow ${finding.subject} was ${finding.changeType}`;
  }
  if (finding.group === "docs") {
    return `drift: docs ${finding.subject} was ${finding.changeType}; review generated context against updated docs`;
  }
  if (finding.group === "templates") {
    return `drift: template ${finding.subject} was ${finding.changeType}; review issue and PR guidance`;
  }
  if (finding.group === "context") {
    return `drift: context artifact ${finding.subject} was ${finding.changeType}; rerun generation or review the artifact`;
  }
  if (finding.group === "lock_config") {
    return `drift: lockfile/config ${finding.subject} was ${finding.changeType}; review setup and validation context`;
  }
  if (finding.group === "boundaries") {
    return `drift: package boundary ${finding.subject} was ${finding.changeType}; review package/app context`;
  }
  if (finding.group === "risk") {
    return `drift: risk path ${finding.subject} was ${finding.changeType}; review high-risk area guidance`;
  }
  if (finding.changeType === "added") {
    return `drift: command ${finding.subject} was added: ${JSON.stringify(
      finding.currentValue,
    )}`;
  }
  if (finding.changeType === "removed") {
    return `drift: command ${finding.subject} was removed: ${JSON.stringify(
      finding.previousValue,
    )}`;
  }
  return `drift: command ${finding.subject} changed from ${JSON.stringify(
    finding.previousValue,
  )} to ${JSON.stringify(finding.currentValue)}`;
}

function requiredArtifactPresent(
  artifactPath: string,
  paths: Set<string>,
): boolean {
  if (paths.has(artifactPath)) {
    return true;
  }
  if (!artifactPath.endsWith("/SKILL.md")) {
    return false;
  }
  const requiredRole = skillRoleFromPath(artifactPath);
  if (!requiredRole) {
    return false;
  }
  return [...paths].some(
    (repoPath) =>
      repoPath.endsWith("/SKILL.md") &&
      (repoPath.startsWith(".agents/skills/") ||
        repoPath.startsWith(".claude/skills/")) &&
      skillRoleFromPath(repoPath) === requiredRole,
  );
}

function skillRoleFromPath(
  repoPath: string,
): "start" | "testing" | "review" | null {
  if (repoPath.includes("start-task") || repoPath.includes("repo-overview")) {
    return "start";
  }
  if (
    repoPath.includes("testing-workflow") ||
    repoPath.includes("validation-testing") ||
    repoPath.includes("test-workflow")
  ) {
    return "testing";
  }
  if (repoPath.includes("pr-review")) {
    return "review";
  }
  return null;
}

async function pr(repoRoot: string, options: CliOptions): Promise<void> {
  if (!options.createPr) {
    throw new Error("PR command requires --create.");
  }
  const profile = await repositoryWorkspace.profile(repoRoot);
  printLines(
    commandHeader({
      title: "context PR",
      repoRoot,
      dryRun: true,
    }),
  );
  printLines(
    renderBox("Dry-run context PR summary", [
      `Branch: open-maintainer/context-${profile.version}`,
      `Agent Readiness: ${profile.agentReadiness.score}/100`,
      "Use the GitHub App API flow to create a real remote PR with installation credentials.",
    ]),
  );
}

async function contextPr(repoRoot: string, options: CliOptions): Promise<void> {
  if (!options.createPr) {
    throw new Error("context-pr command requires --create.");
  }
  const profile = await repositoryWorkspace.profile(repoRoot);
  const summaryMarkdown = options.auditSummaryPath
    ? await readFile(path.resolve(repoRoot, options.auditSummaryPath), "utf8")
    : undefined;
  const publisher: ContextPrPublisher = {
    publish: publishWorkspaceContextPr,
  };
  const defaultBranch = options.baseRef ?? profile.defaultBranch;
  const workflow = createContextPrWorkflow({
    state: {
      runs: {
        start: () => null,
        succeed: () => null,
        fail: () => null,
      },
      contextPrs: {
        save: () => undefined,
      },
    },
    repositorySources: {
      async prepareRegisteredRepo() {
        throw new Error("The CLI context-pr command only supports workspaces.");
      },
      async prepareWorkspace(input) {
        return {
          repoId: "local",
          owner: input.repository.owner,
          name: input.repository.name,
          defaultBranch,
          profileVersion: profile.version,
          profile,
          worktreeRoot: input.root,
        };
      },
    },
    artifactCatalog: {
      collect: collectWorkspaceContextPrArtifacts,
    },
    publishers: {
      localGh: publisher,
      githubApp: publisher,
      actionGh: publisher,
    },
  });
  const result = await workflow.open({
    target: {
      kind: "workspace",
      root: repoRoot,
      repository: {
        owner: profile.owner,
        name: profile.name,
        defaultBranch,
      },
    },
    origin: {
      kind: "github-action",
      branchName: options.refreshBranch ?? "open-maintainer/context-refresh",
      title: options.refreshTitle ?? "Update Open Maintainer context",
      ...(summaryMarkdown ? { summaryMarkdown } : {}),
    },
    writePolicy: options.force ? "force" : "preserve-maintainer-owned",
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  console.log(`Refresh PR: ${result.contextPr.prUrl ?? ""}`);
}

async function collectWorkspaceContextPrArtifacts(input: {
  repoId: string;
  profileVersion: number;
  worktreeRoot: string | null;
}): Promise<GeneratedArtifact[]> {
  if (!input.worktreeRoot) {
    return [];
  }
  const files = await repositoryWorkspace.scan(input.worktreeRoot);
  const timestamp = nowIso();
  const artifacts: GeneratedArtifact[] = [];
  for (const file of files) {
    const parsed = ArtifactTypeSchema.safeParse(file.path);
    if (!parsed.success || parsed.data === "repo_profile") {
      continue;
    }
    artifacts.push({
      id: newId("artifact"),
      repoId: input.repoId,
      type: parsed.data,
      version: artifacts.length + 1,
      content: file.content,
      sourceProfileVersion: input.profileVersion,
      modelProvider: null,
      model: null,
      createdAt: timestamp,
    });
  }
  return artifacts;
}

async function publishWorkspaceContextPr(
  input: ContextPrPublishInput,
): Promise<{
  id: string;
  repoId: string;
  branchName: string;
  commitSha: string | null;
  prNumber: number | null;
  prUrl: string | null;
  artifactVersions: number[];
  status: "succeeded";
  createdAt: string;
}> {
  if (!input.repo.worktreeRoot) {
    throw new Error("A writable workspace is required.");
  }
  const cwd = input.repo.worktreeRoot;
  await runCliGit(cwd, ["checkout", "-B", input.branchName]);
  const written = await writeWorkspaceContextArtifacts(input);
  await runCliGit(cwd, ["add", "--", ...written.map((item) => item.path)]);
  if (!(await cliGitHasStagedChanges(cwd))) {
    throw new Error("No writable Open Maintainer context artifacts changed.");
  }
  await runCliGit(cwd, [
    "commit",
    "-m",
    "chore: refresh Open Maintainer context",
  ]);
  const commitSha = (await runCliGit(cwd, ["rev-parse", "HEAD"])).trim();
  await runCliGit(cwd, [
    "push",
    "--force-with-lease",
    "origin",
    input.branchName,
  ]);
  const prUrl = await openOrUpdateCliPullRequest(cwd, input);
  return {
    id: newId("context_pr"),
    repoId: input.repo.repoId,
    branchName: input.branchName,
    commitSha,
    prNumber: pullRequestNumber(prUrl),
    prUrl,
    artifactVersions: written.map(({ artifact }) => artifact.version),
    status: "succeeded",
    createdAt: nowIso(),
  };
}

async function writeWorkspaceContextArtifacts(
  input: ContextPrPublishInput,
): Promise<Array<{ path: string; artifact: GeneratedArtifact }>> {
  if (!input.repo.worktreeRoot) {
    return [];
  }
  const written: Array<{ path: string; artifact: GeneratedArtifact }> = [];
  for (const { artifact, path: artifactPath } of input.writableArtifacts) {
    const destination = path.join(input.repo.worktreeRoot, artifactPath);
    const relativePath = path.relative(input.repo.worktreeRoot, destination);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(
        `Refusing to write artifact outside repository: ${artifactPath}`,
      );
    }
    const existingContent = await readFile(destination, "utf8").catch(
      () => null,
    );
    if (
      existingContent &&
      !input.shouldOverwriteExistingFile(existingContent)
    ) {
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, artifact.content, "utf8");
    written.push({ path: relativePath, artifact });
  }
  if (written.length === 0) {
    throw new Error(
      "No context artifact files were written because existing files are preserved by default.",
    );
  }
  return written;
}

async function openOrUpdateCliPullRequest(
  cwd: string,
  input: ContextPrPublishInput,
): Promise<string> {
  const existingUrl = findFirstUrl(
    await runCliGh(cwd, [
      "pr",
      "list",
      "--head",
      input.branchName,
      "--base",
      input.repo.defaultBranch,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      ".[0].url // empty",
    ]),
  );
  if (existingUrl) {
    await runCliGh(cwd, [
      "pr",
      "edit",
      existingUrl,
      "--title",
      input.title,
      "--body",
      input.body,
    ]);
    return existingUrl;
  }
  const prUrl = findFirstUrl(
    await runCliGh(cwd, [
      "pr",
      "create",
      "--base",
      input.repo.defaultBranch,
      "--head",
      input.branchName,
      "--title",
      input.title,
      "--body",
      input.body,
    ]),
  );
  if (!prUrl) {
    throw new Error("gh did not return a pull request URL.");
  }
  return prUrl;
}

async function cliGitHasStagedChanges(cwd: string): Promise<boolean> {
  try {
    await runCliGit(cwd, ["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    return true;
  }
}

async function runCliGit(cwd: string, args: string[]): Promise<string> {
  return runCliCommand(
    process.env["OPEN_MAINTAINER_GIT_COMMAND"] ?? "git",
    args,
    cwd,
    gitCommitIdentityEnv(),
  );
}

async function runCliGh(cwd: string, args: string[]): Promise<string> {
  return runCliCommand(
    process.env["OPEN_MAINTAINER_GH_COMMAND"] ?? "gh",
    args,
    cwd,
  );
}

async function runCliCommand(
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      ...(env ? { env: { ...process.env, ...env } } : {}),
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    });
    return stdout;
  } catch (error) {
    if (error instanceof Error) {
      const details = [
        "stderr" in error && typeof error.stderr === "string"
          ? error.stderr
          : "",
        "stdout" in error && typeof error.stdout === "string"
          ? error.stdout
          : "",
        error.message,
      ]
        .filter((part) => part.trim().length > 0)
        .join("\n");
      throw new Error(`${command} ${args.join(" ")} failed: ${details}`);
    }
    throw error;
  }
}

function gitCommitIdentityEnv(): Record<string, string> {
  const name =
    process.env["OPEN_MAINTAINER_GIT_AUTHOR_NAME"] ??
    process.env["GIT_AUTHOR_NAME"] ??
    "open-maintainer";
  const email =
    process.env["OPEN_MAINTAINER_GIT_AUTHOR_EMAIL"] ??
    process.env["GIT_AUTHOR_EMAIL"] ??
    "open-maintainer@users.noreply.github.com";
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

function findFirstUrl(output: string): string | null {
  return output.match(/https?:\/\/\S+/)?.[0] ?? null;
}

function pullRequestNumber(prUrl: string): number {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}

async function triageIssue(
  repoRoot: string,
  options: CliOptions,
): Promise<void> {
  if (options.issueNumber === null) {
    throw new Error("triage issue requires --number <n>.");
  }
  const useCases = createIssueTriageUseCases(createCliIssueTriageAdapters());
  const { evidence, result, artifactPath } = await useCases.triageOne({
    repoRoot,
    issueNumber: options.issueNumber,
    model: {
      provider: options.model,
      model: options.llmModel,
      consent: {
        repositoryContentTransfer: options.allowModelContentTransfer,
      },
    },
    writeIntent: buildIssueTriageWriteIntent(options),
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printLines(
    commandHeader({
      title: "issue triage",
      repoRoot,
      dryRun: options.dryRun,
    }),
  );
  printLines(
    renderBox(
      "Issue summary",
      formatIssueTriageSummary(result, evidence, artifactPath, options.dryRun),
    ),
  );
}

async function triageBrief(
  repoRoot: string,
  options: CliOptions,
): Promise<void> {
  if (options.issueNumber === null) {
    throw new Error("triage brief requires --number <n>.");
  }
  const useCases = createIssueTriageUseCases(createCliIssueTriageAdapters());
  const briefResult = await useCases.briefIssue({
    repoRoot,
    issueNumber: options.issueNumber,
    allowNonAgentReady: options.issueBriefAllowNonAgentReady,
    dryRun: options.dryRun,
    outputPath: options.outputPath,
  });
  const { brief } = briefResult;
  if (options.json) {
    console.log(JSON.stringify(brief, null, 2));
    return;
  }
  printLines(
    commandHeader({
      title: "triage brief",
      repoRoot,
      dryRun: options.dryRun,
    }),
  );
  printLines(
    renderBox("Task brief", [
      `Task brief: ${brief.status}`,
      `Artifact: ${briefResult.artifactPath}${options.dryRun ? " (unchanged)" : ""}`,
      ...(options.outputPath
        ? [
            `Markdown: ${options.outputPath}${options.dryRun ? " (planned)" : ""}`,
          ]
        : []),
      ...(options.dryRun
        ? ["Dry run: no task brief artifact or markdown file written."]
        : []),
    ]),
  );
  if (brief.markdown) {
    console.log(brief.markdown);
  }
}

async function triageIssues(
  repoRoot: string,
  options: CliOptions,
): Promise<void> {
  const useCases = createIssueTriageUseCases(createCliIssueTriageAdapters());
  const batch = await useCases.triageBatch({
    repoRoot,
    model: {
      provider: options.model,
      model: options.llmModel,
      consent: {
        repositoryContentTransfer: options.allowModelContentTransfer,
      },
    },
    state: options.triageState,
    limit: options.triageLimit,
    label: options.triageLabel,
    includeLabels: options.triageIncludeLabels,
    excludeLabels: options.triageExcludeLabels,
    format: options.triageFormat,
    outputPath: options.outputPath,
    writeIntent: buildIssueTriageWriteIntent(options),
  });
  const { report, jsonPath, markdownPath, markdown } = batch;
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printLines(
    commandHeader({
      title: "issue triage batch",
      repoRoot,
      dryRun: options.dryRun,
    }),
  );
  console.log(
    options.triageFormat === "markdown"
      ? markdown
      : renderTriageBatchConsole(report, {
          jsonPath,
          markdownPath,
          dryRun: options.dryRun,
        }),
  );
  if (options.outputPath && options.dryRun) {
    console.log(`Output: ${options.outputPath} (planned)`);
  }
  if (options.dryRun) {
    console.log(
      "Dry run: no triage artifacts, reports, or GitHub writes applied.",
    );
  }
}

function renderTriageBatchConsole(
  report: IssueTriageBatchReport,
  paths: { jsonPath: string; markdownPath: string; dryRun?: boolean },
): string {
  return [
    ...renderBox("Batch summary", [
      `Issue triage run: ${report.runId}`,
      `Scanned ${report.issueCount} ${report.state} issues`,
      ...renderIssueTriageBatchSummary(report).split("\n"),
    ]),
    "",
    renderIssueTriageBatchGroups(report),
    `JSON report: ${paths.jsonPath}${paths.dryRun ? " (planned)" : ""}`,
    `Markdown report: ${paths.markdownPath}${paths.dryRun ? " (planned)" : ""}`,
    `GitHub writes: ${formatBatchGitHubWritesSummary(report)}`,
  ].join("\n");
}

function buildIssueTriageWriteIntent(options: CliOptions) {
  return {
    dryRun: options.dryRun,
    labels: options.issueApplyLabels,
    createMissingLabels: options.issueCreateLabels,
    comment: options.issuePostComment,
    close: options.issueCloseAllowed,
    onlySignals: options.triageOnlySignals,
    minConfidence: options.triageMinConfidence,
  };
}

function formatIssueTriageSummary(
  result: IssueTriageResult,
  evidence: IssueTriageEvidence,
  artifactPath: string,
  dryRun: boolean,
): string[] {
  const missing =
    result.missingInfo.length > 0 ? result.missingInfo.join("; ") : "none";
  const signals =
    result.signals.length > 0 ? result.signals.join(", ") : "none";
  const labels =
    result.resolvedLabels.length > 0
      ? result.resolvedLabels
          .map((label) => `${label.label} (${label.source})`)
          .join(", ")
      : "none";
  return [
    `Issue #${result.issueNumber}: ${evidence.issue.title}`,
    `Classification: ${result.classification}`,
    `Quality score: ${result.qualityScore}`,
    `Spam risk: ${result.spamRisk}`,
    `Agent readiness: ${result.agentReadiness}`,
    `Confidence: ${result.confidence}`,
    `Missing information: ${missing}`,
    `Signals: ${signals}`,
    `Resolved labels: ${labels}`,
    `Label actions: ${formatWriteActionSummary(result.writeActions, "apply_label")}`,
    `Next action: ${result.maintainerSummary}`,
    `Comment preview: ${result.commentPreview.summary}`,
    `Comment action: ${formatCommentActionSummary(result.writeActions)}`,
    `Closure action: ${formatWriteActionSummary(result.writeActions, "close_issue")}`,
    `Artifact: ${artifactPath}${dryRun ? " (planned)" : ""}`,
    `GitHub writes: ${formatGitHubWritesSummary(result.writeActions)}`,
    ...(dryRun
      ? ["Dry run: no triage artifact or GitHub writes applied."]
      : []),
  ];
}

function formatWriteActionSummary(
  actions: IssueTriageResult["writeActions"],
  type: IssueTriageResult["writeActions"][number]["type"],
): string {
  const matching = actions.filter((action) => action.type === type);
  if (matching.length === 0) {
    return "none";
  }
  return matching
    .map(
      (action) =>
        `${action.status} ${action.target ?? "target"} (${action.reason})`,
    )
    .join("; ");
}

function formatGitHubWritesSummary(
  actions: IssueTriageResult["writeActions"],
): string {
  const applied = actions.filter((action) => action.status === "applied");
  const failed = actions.filter((action) => action.status === "failed");
  if (failed.length > 0) {
    return `failed (${failed
      .map((action) => `${action.type}:${action.target ?? "target"}`)
      .join(", ")})`;
  }
  if (applied.length === 0) {
    return "skipped (preview-only default)";
  }
  return `applied (${applied
    .map((action) => `${action.type}:${action.target ?? "target"}`)
    .join(", ")})`;
}

function formatBatchGitHubWritesSummary(
  report: IssueTriageBatchReport,
): string {
  const actions = report.issues
    .filter((record) => record.status === "succeeded")
    .flatMap((record) => record.writeActions);
  const appliedCount = actions.filter(
    (action) => action.status === "applied",
  ).length;
  const failedCount = actions.filter(
    (action) => action.status === "failed",
  ).length;
  if (failedCount > 0) {
    return `failed (${failedCount} action${failedCount === 1 ? "" : "s"}${appliedCount > 0 ? `, ${appliedCount} applied` : ""})`;
  }
  if (appliedCount === 0) {
    return "skipped (preview-only default)";
  }
  return `applied (${appliedCount} action${appliedCount === 1 ? "" : "s"})`;
}

function formatCommentActionSummary(
  actions: IssueTriageResult["writeActions"],
): string {
  const matching = actions.filter(
    (action) =>
      action.type === "post_comment" || action.type === "update_comment",
  );
  if (matching.length === 0) {
    return "none";
  }
  return matching
    .map(
      (action) =>
        `${action.status} ${action.target ?? "target"} (${action.reason})`,
    )
    .join("; ");
}

async function review(repoRoot: string, options: CliOptions): Promise<void> {
  assertReviewOptions(options);

  const provider = resolveRequiredReviewProvider(options);
  const reviewModel = resolveReviewModel(options);
  const operation = createReviewOperationRuntime();
  const operationMarkdownPath =
    options.outputPath && options.reviewFormat !== "agent-feedback"
      ? options.outputPath
      : null;
  const request: ReviewOperationRequest = {
    repoRoot,
    target:
      options.pr !== null
        ? { kind: "pullRequest", number: options.pr }
        : {
            kind: "diff",
            ...(options.baseRef ? { baseRef: options.baseRef } : {}),
            ...(options.headRef ? { headRef: options.headRef } : {}),
            ...(options.prNumber !== null
              ? { prNumber: options.prNumber }
              : {}),
          },
    model: {
      provider,
      ...(reviewModel ? { model: reviewModel } : {}),
      consent: { repositoryContentTransfer: true },
    },
    intent: options.dryRun ? "preview" : "apply",
    ...(options.pr !== null
      ? {
          publication: {
            mode: options.dryRun ? "plan" : "publish",
            ...buildReviewPublishOptions(options),
          },
        }
      : {}),
    output: {
      ...(operationMarkdownPath ? { markdownPath: operationMarkdownPath } : {}),
      json: options.json,
    },
  };
  const run = await operation.review(request);
  const renderedReview =
    options.reviewFormat === "agent-feedback"
      ? renderReviewAgentFeedback(run.review)
      : run.markdown;
  const agentFeedbackOutputPath =
    options.outputPath && options.reviewFormat === "agent-feedback"
      ? path.resolve(repoRoot, options.outputPath)
      : null;
  if (agentFeedbackOutputPath && !options.dryRun) {
    await mkdir(path.dirname(agentFeedbackOutputPath), { recursive: true });
    await writeFile(agentFeedbackOutputPath, renderedReview, "utf8");
  }
  if (!options.json && (options.outputPath || options.pr !== null)) {
    printLines(
      commandHeader({
        title: "review",
        repoRoot,
        dryRun: options.dryRun,
      }),
    );
  }
  if (options.outputPath) {
    const outputPath = path.resolve(
      repoRoot,
      run.output?.markdownPath ?? agentFeedbackOutputPath ?? options.outputPath,
    );
    if (!options.json) {
      printLines(
        renderBox("Review output", [
          `Review: ${path.relative(repoRoot, outputPath)}${run.output?.written === false || (agentFeedbackOutputPath && options.dryRun) ? " (planned)" : ""}`,
          ...(run.output?.written === false ||
          (agentFeedbackOutputPath && options.dryRun)
            ? ["Dry run: no review file written."]
            : []),
        ]),
      );
    }
  }
  if (options.json) {
    console.log(JSON.stringify(run.review, null, 2));
    return;
  }
  if (options.pr === null) {
    if (!options.outputPath) {
      console.log(renderedReview);
    }
    return;
  }
  printLines(
    renderBox("Pull request review", [
      `Review generated for pull request #${options.pr}.`,
      formatPullRequestPublicationStatus(run.publication),
    ]),
  );
}

function assertReviewOptions(options: CliOptions): void {
  if (options.triageFormat && options.triageFormat !== "markdown") {
    throw new Error(
      "Invalid value for --format with review. Expected markdown or agent-feedback.",
    );
  }
  if (
    (options.reviewPostSummary ||
      options.reviewInlineComments ||
      options.reviewApplyTriageLabel ||
      options.reviewCreateTriageLabels) &&
    options.pr === null
  ) {
    throw new Error(
      "Review GitHub write flags require --pr <number> so the CLI can target a GitHub pull request with gh.",
    );
  }
  if (options.reviewCreateTriageLabels && !options.reviewApplyTriageLabel) {
    throw new Error(
      "--review-create-triage-labels requires --review-apply-triage-label.",
    );
  }
  if (
    options.reviewInlineCap !== null &&
    !options.reviewInlineComments &&
    options.pr === null
  ) {
    throw new Error(
      "--review-inline-cap requires --review-inline-comments or --pr.",
    );
  }
  assertReviewModelOptions(options);
}

function buildReviewPublishOptions(options: CliOptions): ReviewPublishOptions {
  const explicitPosting =
    options.reviewPostSummary || options.reviewInlineComments;
  return {
    summary: explicitPosting ? options.reviewPostSummary : true,
    inline: explicitPosting
      ? options.reviewInlineComments
        ? { cap: options.reviewInlineCap ?? 5 }
        : false
      : { cap: options.reviewInlineCap ?? 5 },
    triageLabel: options.reviewApplyTriageLabel
      ? {
          apply: true,
          createMissingLabels: options.reviewCreateTriageLabels,
        }
      : false,
  };
}

function assertReviewModelOptions(options: CliOptions): void {
  resolveRequiredReviewProvider(options);
  resolveReviewModel(options);
  if (!options.allowModelContentTransfer) {
    throw new Error(
      "--model requires --allow-model-content-transfer because PR review sends repository content to the selected CLI backend.",
    );
  }
}

function resolveRequiredReviewProvider(
  options: CliOptions,
): ReviewOperationModelProvider {
  const provider = resolveReviewProvider(options);
  if (!provider) {
    throw new Error(
      "review requires --model codex or --model claude because reviews are LLM-backed.",
    );
  }
  return provider;
}

function formatPullRequestPublicationStatus(
  publication: PullRequestReviewRun["publication"],
): string {
  if (publication.mode === "skipped") {
    return "PR comments posted: none.";
  }
  if (publication.mode === "planned") {
    return "Dry run: no PR comments posted.";
  }
  return formatPublishedReviewStatus(publication);
}

function formatPublishedReviewStatus(input: {
  summary: ReviewSummaryCommentResult | null;
  inline: ReviewInlineCommentResult | null;
  triageLabel: ReviewTriageLabelResult | null;
}): string {
  const parts = [];
  if (input.summary) {
    parts.push("summary comment");
  }
  const inlineCount = input.inline?.comments.length ?? 0;
  if (inlineCount > 0) {
    parts.push(
      `${inlineCount} inline ${inlineCount === 1 ? "comment" : "comments"}`,
    );
  }
  if (input.triageLabel) {
    parts.push(`triage label ${input.triageLabel.label}`);
  }
  if (parts.length === 0) {
    return "PR comments posted: none.";
  }
  const labelNote =
    (input.triageLabel?.created ?? 0) > 0
      ? ` Created ${input.triageLabel?.created} triage labels.`
      : "";
  return `PR comments posted: ${parts.join(", ")}.${labelNote}`;
}

function resolveReviewProvider(options: CliOptions): ArtifactModel | null {
  if (
    options.model &&
    options.reviewProvider &&
    options.model !== options.reviewProvider
  ) {
    throw new Error(
      "--model and --review-provider disagree. Use one review provider flag.",
    );
  }
  return options.model ?? options.reviewProvider;
}

function resolveReviewModel(options: CliOptions): string | null {
  if (
    options.llmModel &&
    options.reviewModel &&
    options.llmModel !== options.reviewModel
  ) {
    throw new Error(
      "--llm-model and --review-model disagree. Use one model override flag.",
    );
  }
  return options.llmModel ?? options.reviewModel;
}

async function readOptionalRepoFile(
  repoRoot: string,
  repoPath: string,
): Promise<string | undefined> {
  return readFile(path.join(repoRoot, repoPath), "utf8").catch(() => undefined);
}

type CliConfigState = {
  config: OpenMaintainerConfig | null;
  diagnostics: OpenMaintainerConfigDiagnostic[];
};

async function loadOpenMaintainerConfigState(
  repoRoot: string,
): Promise<CliConfigState> {
  const source = await readOptionalRepoFile(repoRoot, ".open-maintainer.yml");
  if (!source) {
    return { config: null, diagnostics: [] };
  }
  return parseOpenMaintainerConfigWithDiagnostics(source);
}

async function configDiagnosticMessages(repoRoot: string): Promise<string[]> {
  const state = await loadOpenMaintainerConfigState(repoRoot);
  return state.diagnostics.map((diagnostic) => diagnostic.message);
}

function parseOptions(rawOptions: string[]): CliOptions {
  const options: CliOptions = {
    force: false,
    refreshGenerated: false,
    doctorFix: false,
    dryRun: false,
    createPr: false,
    failOnScoreBelow: null,
    reportPath: null,
    noProfileWrite: false,
    model: null,
    context: null,
    skills: null,
    allowWrite: false,
    llmModel: null,
    pr: null,
    baseRef: null,
    headRef: null,
    prNumber: null,
    outputPath: null,
    json: false,
    reviewProvider: null,
    reviewModel: null,
    allowModelContentTransfer: false,
    reviewPostSummary: false,
    reviewInlineComments: false,
    reviewInlineCap: null,
    reviewApplyTriageLabel: false,
    reviewCreateTriageLabels: false,
    issueNumber: null,
    triageState: "open",
    triageLimit: null,
    triageLabel: null,
    triageIncludeLabels: [],
    triageExcludeLabels: [],
    triageOnlySignals: [],
    triageMinConfidence: null,
    triageFormat: null,
    reviewFormat: null,
    issueApplyLabels: false,
    issueCreateLabels: false,
    issuePostComment: false,
    issueCloseAllowed: false,
    issueBriefAllowNonAgentReady: false,
    refreshBranch: null,
    refreshTitle: null,
    auditSummaryPath: null,
  };
  for (let index = 0; index < rawOptions.length; index += 1) {
    const option = rawOptions[index];
    if (option === "--force") {
      options.force = true;
    } else if (option === "--fix") {
      options.doctorFix = true;
    } else if (option === "--refresh-generated") {
      options.refreshGenerated = true;
    } else if (option === "--dry-run") {
      options.dryRun = true;
    } else if (option === "--create") {
      options.createPr = true;
    } else if (option === "--fail-on-score-below") {
      const value = requireOptionValue(rawOptions, index, option);
      const threshold = Number(value);
      if (!Number.isFinite(threshold)) {
        throw new Error(
          "Invalid value for --fail-on-score-below. Expected a number.",
        );
      }
      options.failOnScoreBelow = threshold;
      index += 1;
    } else if (option === "--report-path") {
      options.reportPath = requireOptionValue(rawOptions, index, option);
      index += 1;
    } else if (option === "--refresh-branch") {
      options.refreshBranch = requireOptionValue(rawOptions, index, option);
      index += 1;
    } else if (option === "--refresh-title") {
      options.refreshTitle = requireOptionValue(rawOptions, index, option);
      index += 1;
    } else if (option === "--audit-summary-path") {
      options.auditSummaryPath = requireOptionValue(rawOptions, index, option);
      index += 1;
    } else if (option === "--no-profile-write") {
      options.noProfileWrite = true;
    } else if (option === "--model") {
      options.model = parseArtifactModel(
        requireOptionValue(rawOptions, index, option),
      );
      index += 1;
    } else if (option === "--context") {
      options.context = parseArtifactSelection(
        requireOptionValue(rawOptions, index, option),
        "--context",
      );
      index += 1;
    } else if (option === "--skills") {
      options.skills = parseArtifactSelection(
        requireOptionValue(rawOptions, index, option),
        "--skills",
      );
      index += 1;
    } else if (option === "--llm-model") {
      options.llmModel = requireOptionValue(rawOptions, index, option);
      index += 1;
    } else if (option === "--allow-write") {
      options.allowWrite = true;
    } else if (option === "--pr") {
      const value = requireOptionValue(rawOptions, index, option);
      const pr = Number(value);
      if (!Number.isInteger(pr) || pr <= 0) {
        throw new Error("Invalid value for --pr. Expected a positive integer.");
      }
      options.pr = pr;
      index += 1;
    } else if (option === "--base-ref") {
      options.baseRef = requireOptionValue(rawOptions, index, option);
      index += 1;
    } else if (option === "--head-ref") {
      options.headRef = requireOptionValue(rawOptions, index, option);
      index += 1;
    } else if (option === "--pr-number") {
      const value = requireOptionValue(rawOptions, index, option);
      const prNumber = Number(value);
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        throw new Error(
          "Invalid value for --pr-number. Expected a positive integer.",
        );
      }
      options.prNumber = prNumber;
      index += 1;
    } else if (option === "--number") {
      const value = requireOptionValue(rawOptions, index, option);
      const issueNumber = Number(value);
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new Error(
          "Invalid value for --number. Expected a positive integer.",
        );
      }
      options.issueNumber = issueNumber;
      index += 1;
    } else if (option === "--state") {
      const value = requireOptionValue(rawOptions, index, option);
      if (value !== "open" && value !== "closed" && value !== "all") {
        throw new Error(
          "Invalid value for --state. Expected open, closed, or all.",
        );
      }
      options.triageState = value;
      index += 1;
    } else if (option === "--limit") {
      const value = requireOptionValue(rawOptions, index, option);
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
        throw new Error(
          "Invalid value for --limit. Expected a positive integer up to 100.",
        );
      }
      options.triageLimit = limit;
      index += 1;
    } else if (option === "--label") {
      options.triageLabel = requireOptionValue(rawOptions, index, option);
      index += 1;
    } else if (option === "--include-label") {
      options.triageIncludeLabels.push(
        requireOptionValue(rawOptions, index, option),
      );
      index += 1;
    } else if (option === "--exclude-label") {
      options.triageExcludeLabels.push(
        requireOptionValue(rawOptions, index, option),
      );
      index += 1;
    } else if (option === "--only") {
      options.triageOnlySignals = requireOptionValue(rawOptions, index, option)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
    } else if (option === "--min-confidence") {
      const value = Number(requireOptionValue(rawOptions, index, option));
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(
          "Invalid value for --min-confidence. Expected a number from 0 to 1.",
        );
      }
      options.triageMinConfidence = value;
      index += 1;
    } else if (option === "--format") {
      const value = requireOptionValue(rawOptions, index, option);
      if (
        value !== "table" &&
        value !== "json" &&
        value !== "markdown" &&
        value !== "agent-feedback"
      ) {
        throw new Error(
          "Invalid value for --format. Expected table, json, markdown, or agent-feedback.",
        );
      }
      if (value === "agent-feedback") {
        options.reviewFormat = value;
      } else {
        options.triageFormat = value;
        if (value === "markdown") {
          options.reviewFormat = value;
        }
      }
      index += 1;
    } else if (option === "--output") {
      options.outputPath = requireOptionValue(rawOptions, index, option);
      index += 1;
    } else if (option === "--apply" || option === "--apply-labels") {
      options.issueApplyLabels = true;
    } else if (
      option === "--create-labels" ||
      option === "--create-missing-preset-labels"
    ) {
      options.issueCreateLabels = true;
    } else if (option === "--post-comment") {
      options.issuePostComment = true;
    } else if (option === "--no-comments") {
      options.issuePostComment = false;
    } else if (option === "--close-allowed") {
      options.issueCloseAllowed = true;
    } else if (option === "--allow-non-agent-ready") {
      options.issueBriefAllowNonAgentReady = true;
    } else if (option === "--output-path") {
      options.outputPath = requireOptionValue(rawOptions, index, option);
      index += 1;
    } else if (option === "--json") {
      options.json = true;
    } else if (option === "--review-provider") {
      options.reviewProvider = parseArtifactModel(
        requireOptionValue(rawOptions, index, option),
      );
      index += 1;
    } else if (option === "--review-model") {
      options.reviewModel = requireOptionValue(rawOptions, index, option);
      index += 1;
    } else if (option === "--allow-model-content-transfer") {
      options.allowModelContentTransfer = true;
    } else if (option === "--review-post-summary") {
      options.reviewPostSummary = true;
    } else if (option === "--review-inline-comments") {
      options.reviewInlineComments = true;
    } else if (option === "--review-inline-cap") {
      const value = requireOptionValue(rawOptions, index, option);
      const cap = Number(value);
      if (!Number.isInteger(cap) || cap < 0) {
        throw new Error(
          "Invalid value for --review-inline-cap. Expected a non-negative integer.",
        );
      }
      options.reviewInlineCap = cap;
      index += 1;
    } else if (option === "--review-apply-triage-label") {
      options.reviewApplyTriageLabel = true;
    } else if (option === "--review-create-triage-labels") {
      options.reviewCreateTriageLabels = true;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return options;
}

function requireOptionValue(
  rawOptions: string[],
  index: number,
  flag: string,
): string {
  const value = rawOptions[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function isHelpToken(value: string | undefined): boolean {
  return value === "--help" || value === "-h" || value === "help";
}

function isCommandName(value: string | undefined): value is CommandName {
  return (
    value === "audit" ||
    value === "generate" ||
    value === "init" ||
    value === "doctor" ||
    value === "review" ||
    value === "triage" ||
    value === "pr" ||
    value === "context-pr"
  );
}

function assertGenerationTargetsSelected(options: CliOptions): void {
  if (!options.context && !options.skills) {
    throw new Error(
      "generate requires --context codex|claude|both, --skills codex|claude|both, or both.",
    );
  }
}

function parseArtifactSelection(
  value: string,
  flag: "--context" | "--skills",
): ArtifactSelection {
  if (value === "codex" || value === "claude" || value === "both") {
    return value;
  }
  throw new Error(
    `Unknown value for ${flag}. Expected codex, claude, or both.`,
  );
}

function parseArtifactModel(value: string): ArtifactModel {
  if (value === "codex" || value === "claude") {
    return value;
  }
  throw new Error("Unknown model. Expected --model codex or --model claude.");
}

function formatReadinessSuggestions(profile: RepoProfile): string[] {
  const suggestions = readinessSuggestions(profile);
  if (suggestions.length === 0) {
    return [];
  }
  return ["Next steps:", ...suggestions.map((suggestion) => `- ${suggestion}`)];
}

function readinessSuggestions(profile: RepoProfile): string[] {
  const suggestions = new Map<string, string>();
  for (const category of profile.agentReadiness.categories) {
    for (const missing of category.missing) {
      const suggestion = suggestionForMissingItem(
        category.name,
        missing,
        profile,
      );
      suggestions.set(suggestion, suggestion);
    }
  }
  return [...suggestions.values()];
}

function suggestionForMissingItem(
  categoryName: string,
  missing: string,
  profile: RepoProfile,
): string {
  switch (missing) {
    case "README is missing.":
      return "Add `README.md` with setup steps, core commands, architecture notes, and validation expectations.";
    case "No runnable scripts or Make targets detected.":
      return "Add runnable scripts in `package.json` or Make targets for common workflows such as test, build, lint, and typecheck.";
    case "No lockfile or dependency lock evidence detected.":
      return "Commit a dependency lockfile such as `bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, `Cargo.lock`, `Scarb.lock`, or `go.sum`.";
    case "Environment variables are referenced without example or setup documentation.":
      return "Add `.env.example` or setup documentation covering the detected environment variables.";
    case "No major source directories detected.":
      return "Organize code under detectable source directories such as `src/`, `apps/`, `packages/`, `contracts/`, or `cmd/`.";
    case "No workspace or package boundary evidence detected.":
      return "Document package boundaries or add workspace metadata when the repository has multiple app or package areas.";
    case "No docs directory detected.":
      return "Add a `docs/` directory with architecture, operations, or runbook notes.";
    case "No toolchain config files detected.":
      return "Add toolchain config such as `tsconfig.json`, `biome.json`, `pyproject.toml`, `go.mod`, `Scarb.toml`, or `docker-compose.yml`.";
    case "No test command detected.":
      return "Add a `test` script in `package.json`, a `test` Make target, or an equivalent workspace test command.";
    case "No test files detected.":
      return "Add deterministic tests under `tests/`, `test/`, `__tests__/`, or `*.test.*` files.";
    case "No lint/check command detected.":
      return "Add a `lint` or `check` script in `package.json`, a Make target, or an equivalent quality command.";
    case "No GitHub Actions workflow detected.":
      return "Add `.github/workflows/ci.yml` running the repository's install and validation commands.";
    case "No review or quality gate rules inferred.":
      return "Add documented review or quality-gate rules through scripts, Make targets, CONTRIBUTING.md, or repo-local context.";
    case "Risk-sensitive paths are present without repo-local guidance.":
      return "Document review expectations for auth, security, secret, payment, or billing paths.";
    case "No ownership or maintainer guidance detected.":
      return "Add CODEOWNERS, OWNERS, MAINTAINERS, or maintainer guidance in README, CONTRIBUTING, or docs.";
    case "No ignore file detected.":
      return "Add `.gitignore` or `.dockerignore` entries for generated outputs, dependency directories, and build artifacts.";
    case "Generated files are present without documented handling.":
      return "Document generated-file handling in README, CONTRIBUTING, AGENTS.md, or `.open-maintainer.yml`.";
    case "AGENTS.md or CLAUDE.md is missing.":
      return "Add `AGENTS.md` or `CLAUDE.md` with repo-specific agent instructions.";
    case "Repo-local skills are missing.":
      return `Add repo-local skills such as ${joinInlineList(defaultSkillPaths(profile))}.`;
    case ".open-maintainer.yml policy file is missing.":
      return "Add `.open-maintainer.yml` with repository policy and generated-context metadata.";
    case "CONTRIBUTING.md is missing.":
      return "Add `CONTRIBUTING.md` with PR workflow, review rules, and validation commands.";
    default:
      return `Address ${categoryName}: ${missing}`;
  }
}

function defaultSkillPaths(profile: RepoProfile): string[] {
  const repoSlug = slugify(profile.name);
  const hints = profile.generatedFileHints
    .filter((hint) => hint.startsWith(".agents/skills/"))
    .map((hint) => hint.replace("<repo>", repoSlug));
  return hints.length > 0
    ? hints
    : [
        `.agents/skills/${repoSlug}-start-task/SKILL.md`,
        `.agents/skills/${repoSlug}-testing-workflow/SKILL.md`,
        `.agents/skills/${repoSlug}-pr-review/SKILL.md`,
      ];
}

function joinInlineList(items: string[]): string {
  const formatted = items.map((item) => `\`${item}\``);
  if (formatted.length <= 1) {
    return formatted[0] ?? "";
  }
  return `${formatted.slice(0, -1).join(", ")}, and ${formatted.at(-1)}`;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "repo";
}

function thresholdExit(score: number, options: CliOptions): number {
  if (options.failOnScoreBelow !== null && score < options.failOnScoreBelow) {
    console.error(
      `Agent readiness ${score}/100 is below threshold ${options.failOnScoreBelow}.`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
