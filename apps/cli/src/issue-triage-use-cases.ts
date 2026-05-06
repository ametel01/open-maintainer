import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_CODEX_CLI_MODEL,
  type ModelProvider,
  buildClaudeCliProvider,
  buildCodexCliProvider,
} from "@open-maintainer/ai";
import { parseOpenMaintainerConfig } from "@open-maintainer/config";
import {
  type GitHubRepositoryClient,
  createGitHubCliApi,
  createGitHubIssueTriageEvidencePort,
} from "@open-maintainer/github";
import type {
  IssueTriageEvidence,
  IssueTriageInput,
  IssueTriageResolvedLabel,
  IssueTriageResult,
  IssueTriageSignal,
  ModelProviderConfig,
  RepoProfile,
} from "@open-maintainer/shared";
import {
  IssueTriageInputSchema,
  IssueTriageResultSchema,
} from "@open-maintainer/shared";
import {
  type IssueTriageArtifactPort,
  type IssueTriageBatchReport,
  type IssueTriageGitHubPort,
  type IssueTriageModelPort,
  type IssueTriageRepoContextPort,
  type IssueTriageBatchResult as WorkflowIssueTriageBatchResult,
  type IssueTriageBriefResult as WorkflowIssueTriageBriefResult,
  createIssueTriageWorkflow,
} from "@open-maintainer/triage";
import { createCliRepositoryWorkspace } from "./repository-workspace";

export type IssueTriageModelProviderName = "codex" | "claude";

export type IssueTriageUseCases = {
  triageOne(input: TriageOneIssueInput): Promise<TriageOneIssueResult>;
  triageBatch(input: TriageIssueBatchInput): Promise<TriageIssueBatchResult>;
  briefIssue(input: BriefIssueInput): Promise<BriefIssueResult>;
};

export type IssueTriageSession = {
  triageOne(
    input: Omit<TriageOneIssueInput, "repoRoot" | "model">,
  ): Promise<TriageOneIssueResult>;
  triageBatch(
    input: Omit<TriageIssueBatchInput, "repoRoot" | "model">,
  ): Promise<TriageIssueBatchResult>;
};

export type IssueTriageBriefSession = {
  briefIssue(
    input: Omit<BriefIssueInput, "repoRoot">,
  ): Promise<BriefIssueResult>;
};

export type IssueTriageUseCaseDeps = {
  repository: IssueTriageRepositoryPort;
  modelProviders: IssueTriageModelProviderPort;
  github: IssueTriageGitHubAdapterFactory;
  artifacts: IssueTriageArtifactPortFactory;
  output?: IssueTriageOutputPort;
};

export type IssueTriageRepositoryPort = {
  prepare(repoRoot: string): Promise<IssueTriageRepositoryContext>;
  prepareBrief(repoRoot: string): Promise<IssueTriageRepoContextPort>;
};

export type IssueTriageRepositoryContext = {
  profile: CliIssueTriageProfile;
  repo: IssueTriageRepoContextPort;
};

export type IssueTriageModelProviderPort = {
  create(input: {
    repoRoot: string;
    model: IssueTriageModelSelection;
  }): Promise<IssueTriageModelPort> | IssueTriageModelPort;
};

export type IssueTriageGitHubAdapterFactory = {
  create(input: {
    repoRoot: string;
    context: IssueTriageRepositoryContext;
  }): Promise<IssueTriageGitHubPort> | IssueTriageGitHubPort;
};

export type IssueTriageArtifactPortFactory = {
  create(
    repoRoot: string,
  ): Promise<IssueTriageArtifactPort> | IssueTriageArtifactPort;
};

export type IssueTriageOutputPort = {
  write(repoRoot: string, outputPath: string, content: string): Promise<void>;
};

export type IssueTriageModelSelection = {
  provider: IssueTriageModelProviderName | null;
  model: string | null;
  consent: {
    repositoryContentTransfer: boolean;
  };
};

export type IssueTriageWriteIntent = {
  dryRun: boolean;
  labels: boolean;
  createMissingLabels: boolean;
  comment: boolean;
  close: boolean;
  onlySignals: readonly string[];
  minConfidence: number | null;
};

export type TriageOneIssueInput = {
  repoRoot: string;
  issueNumber: number;
  model: IssueTriageModelSelection;
  writeIntent: IssueTriageWriteIntent;
};

export type TriageOneIssueResult = {
  evidence: IssueTriageEvidence;
  result: IssueTriageResult;
  artifactPath: string;
};

export type TriageIssueBatchInput = {
  repoRoot: string;
  model: IssueTriageModelSelection;
  state: "open" | "closed" | "all";
  limit: number | null;
  label: string | null;
  includeLabels: readonly string[];
  excludeLabels: readonly string[];
  format: "table" | "json" | "markdown" | null;
  outputPath: string | null;
  writeIntent: IssueTriageWriteIntent;
};

export type TriageIssueBatchResult = WorkflowIssueTriageBatchResult & {
  output: {
    path: string;
    written: boolean;
    format: "json" | "markdown";
  } | null;
};

export type BriefIssueInput = {
  repoRoot: string;
  issueNumber: number;
  allowNonAgentReady: boolean;
  dryRun: boolean;
  outputPath: string | null;
};

export type BriefIssueResult = WorkflowIssueTriageBriefResult;

type CliIssueTriageProfile = RepoProfile;

export function createIssueTriageUseCases(
  deps: IssueTriageUseCaseDeps,
): IssueTriageUseCases {
  return {
    async triageOne(input) {
      validateIssueTriageWriteIntent(input.writeIntent);
      const session = await createModelBackedIssueTriageSession(deps, {
        repoRoot: input.repoRoot,
        model: input.model,
      });
      return session.triageOne({
        issueNumber: input.issueNumber,
        writeIntent: input.writeIntent,
      });
    },
    async triageBatch(input) {
      validateIssueTriageWriteIntent(input.writeIntent);
      const session = await createModelBackedIssueTriageSession(deps, {
        repoRoot: input.repoRoot,
        model: input.model,
      });
      return session.triageBatch({
        state: input.state,
        limit: input.limit,
        label: input.label,
        includeLabels: input.includeLabels,
        excludeLabels: input.excludeLabels,
        format: input.format,
        outputPath: input.outputPath,
        writeIntent: input.writeIntent,
      });
    },
    async briefIssue(input) {
      const session = await createIssueTriageBriefSession(deps, {
        repoRoot: input.repoRoot,
      });
      return session.briefIssue({
        issueNumber: input.issueNumber,
        allowNonAgentReady: input.allowNonAgentReady,
        dryRun: input.dryRun,
        outputPath: input.outputPath,
      });
    },
  };
}

export async function createModelBackedIssueTriageSession(
  deps: IssueTriageUseCaseDeps,
  input: {
    repoRoot: string;
    model: IssueTriageModelSelection;
  },
): Promise<IssueTriageSession> {
  assertIssueTriageModelSelection(input.model);
  const repository = await deps.repository.prepare(input.repoRoot);
  const model = await deps.modelProviders.create({
    repoRoot: input.repoRoot,
    model: input.model,
  });
  const github = await deps.github.create({
    repoRoot: input.repoRoot,
    context: repository,
  });
  const artifacts = await deps.artifacts.create(input.repoRoot);
  const workflow = createIssueTriageWorkflow({
    repo: repository.repo,
    github,
    model,
    artifacts,
  });

  return {
    async triageOne(sessionInput) {
      validateIssueTriageWriteIntent(sessionInput.writeIntent);
      const preview = await workflow.preview(sessionInput.issueNumber, {
        createMissingLabels: sessionInput.writeIntent.createMissingLabels,
      });
      const applied = await workflow.apply(preview.writePlan, {
        labels: sessionInput.writeIntent.labels,
        createMissingLabels: sessionInput.writeIntent.createMissingLabels,
        comment: sessionInput.writeIntent.comment,
        close: sessionInput.writeIntent.close,
        onlySignals: sessionInput.writeIntent.onlySignals,
        minConfidence: sessionInput.writeIntent.minConfidence,
        dryRun: sessionInput.writeIntent.dryRun,
      });
      return {
        evidence: applied.evidence,
        result: applied.result,
        artifactPath: applied.artifactPath,
      };
    },
    async triageBatch(sessionInput) {
      validateIssueTriageWriteIntent(sessionInput.writeIntent);
      const batch = await workflow.batch({
        state: sessionInput.state,
        limit: sessionInput.limit,
        label: sessionInput.label,
        includeLabels: sessionInput.includeLabels,
        excludeLabels: sessionInput.excludeLabels,
        format: sessionInput.format,
        labels: sessionInput.writeIntent.labels,
        createMissingLabels: sessionInput.writeIntent.createMissingLabels,
        comment: sessionInput.writeIntent.comment,
        close: sessionInput.writeIntent.close,
        onlySignals: sessionInput.writeIntent.onlySignals,
        minConfidence: sessionInput.writeIntent.minConfidence,
        dryRun: sessionInput.writeIntent.dryRun,
      });
      if (!sessionInput.outputPath) {
        return { ...batch, output: null };
      }
      const format = sessionInput.format === "json" ? "json" : "markdown";
      if (!sessionInput.writeIntent.dryRun) {
        await deps.output?.write(
          input.repoRoot,
          sessionInput.outputPath,
          format === "json"
            ? `${JSON.stringify(batch.report, null, 2)}\n`
            : batch.markdown,
        );
      }
      return {
        ...batch,
        output: {
          path: sessionInput.outputPath,
          written: !sessionInput.writeIntent.dryRun,
          format,
        },
      };
    },
  };
}

export async function createIssueTriageBriefSession(
  deps: IssueTriageUseCaseDeps,
  input: { repoRoot: string },
): Promise<IssueTriageBriefSession> {
  const artifacts = await deps.artifacts.create(input.repoRoot);
  return {
    async briefIssue(sessionInput) {
      const artifactPath = issueTriageArtifactPath(sessionInput.issueNumber);
      const artifact = await artifacts.readIssue(artifactPath);
      if (
        artifact.result.agentReadiness !== "agent_ready" &&
        !sessionInput.allowNonAgentReady
      ) {
        throw new Error(
          `Issue #${sessionInput.issueNumber} is ${artifact.result.agentReadiness}; pass --allow-non-agent-ready to generate an override brief.`,
        );
      }
      const repo = await deps.repository.prepareBrief(input.repoRoot);
      const workflow = createIssueTriageWorkflow({
        repo,
        github: createUnavailableIssueTriageGitHubPort(),
        model: createUnavailableIssueTriageModelPort(),
        artifacts,
      });
      return workflow.brief(sessionInput.issueNumber, {
        allowNonAgentReady: sessionInput.allowNonAgentReady,
        dryRun: sessionInput.dryRun,
        outputPath: sessionInput.outputPath,
      });
    },
  };
}

export function createCliIssueTriageAdapters(): IssueTriageUseCaseDeps {
  return {
    repository: createCliIssueTriageRepositoryPort(),
    modelProviders: createCliIssueTriageModelProviderPort(),
    github: createCliIssueTriageGitHubAdapterFactory(),
    artifacts: createCliIssueTriageArtifactPortFactory(),
    output: {
      async write(repoRoot, outputPath, content) {
        const absolutePath = path.resolve(repoRoot, outputPath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content);
      },
    },
  };
}

function validateIssueTriageWriteIntent(intent: IssueTriageWriteIntent): void {
  if (intent.createMissingLabels && !intent.labels) {
    throw new Error("--create-labels requires --apply-labels.");
  }
}

function assertIssueTriageModelSelection(
  model: IssueTriageModelSelection,
): void {
  if (!model.provider) {
    throw new Error(
      "triage issue requires --model codex or --model claude because issue triage is LLM-backed only.",
    );
  }
  if (!model.consent.repositoryContentTransfer) {
    throw new Error(
      "--model requires --allow-model-content-transfer because issue triage sends repository context and issue content to the selected CLI backend.",
    );
  }
}

function createUnavailableIssueTriageGitHubPort(): IssueTriageGitHubPort {
  const unavailable = async () => {
    throw new Error("GitHub calls are not used for issue triage briefs.");
  };
  return {
    fetchEvidence: unavailable,
    listRepoLabels: unavailable,
    listRepoLabelNames: unavailable,
    listIssueLabelNames: unavailable,
    createLabel: unavailable,
    applyLabel: unavailable,
    listTriageComments: unavailable,
    postComment: unavailable,
    updateComment: unavailable,
    closeIssue: unavailable,
    listIssues: unavailable,
  };
}

function createUnavailableIssueTriageModelPort(): IssueTriageModelPort {
  return {
    provider: "Local artifact",
    model: "none",
    async complete() {
      throw new Error("Model calls are not used for issue triage briefs.");
    },
  };
}

function createCliIssueTriageRepositoryPort(): IssueTriageRepositoryPort {
  const repositoryWorkspace = createCliRepositoryWorkspace();
  return {
    async prepare(repoRoot) {
      const profile = await repositoryWorkspace.profile(repoRoot);
      const config = await readOptionalRepoFile(
        repoRoot,
        ".open-maintainer.yml",
      )
        .then((source) => (source ? parseOpenMaintainerConfig(source) : null))
        .catch(() => null);
      const repo: IssueTriageRepoContextPort = {
        repoId: profile.repoId,
        owner: profile.owner,
        repo: profile.name,
        sourceProfileVersion: profile.version,
        contextArtifactVersion: null,
        closure: config?.issueTriage?.closure ?? null,
        batch: config?.issueTriage?.batch ?? null,
        validationCommands: profile.commands,
        readFirstPaths: issueBriefReadFirstPaths(profile),
      };
      if (config?.issueTriage?.labels) {
        repo.labels = {
          mappings: config.issueTriage.labels.mappings as Partial<
            Record<IssueTriageSignal, string>
          >,
          preferUpstream: config.issueTriage.labels.preferUpstream,
          createMissingPresetLabels:
            config.issueTriage.labels.createMissingPresetLabels,
        };
      }
      return { profile, repo };
    },
    async prepareBrief(repoRoot) {
      const profile = await repositoryWorkspace.profile(repoRoot);
      return {
        repoId: profile.repoId,
        owner: profile.owner,
        repo: profile.name,
        sourceProfileVersion: profile.version,
        validationCommands: profile.commands,
        readFirstPaths: issueBriefReadFirstPaths(profile),
      };
    },
  };
}

function createCliIssueTriageModelProviderPort(): IssueTriageModelProviderPort {
  return {
    create(input) {
      const provider = buildIssueTriageProvider(input);
      return {
        provider: provider.providerConfig.displayName,
        model: provider.providerConfig.model,
        async complete(prompt, options) {
          return provider.provider.complete(prompt, options);
        },
      };
    },
  };
}

function createCliIssueTriageArtifactPortFactory(): IssueTriageArtifactPortFactory {
  return {
    create(repoRoot) {
      return {
        writeIssue: (artifactPath, artifact) =>
          writeIssueTriageArtifact(repoRoot, artifactPath, artifact),
        readIssue: (artifactPath) =>
          readIssueTriageArtifact(repoRoot, artifactPath),
        async writeBatchReport(input) {
          await writeTriageRunReports(repoRoot, input);
        },
        async writeBriefMarkdown(outputPath, markdown) {
          const absolutePath = path.resolve(repoRoot, outputPath);
          await mkdir(path.dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, markdown);
        },
      };
    },
  };
}

function createCliIssueTriageGitHubAdapterFactory(): IssueTriageGitHubAdapterFactory {
  return {
    create(input) {
      const { profile } = input.context;
      const client = buildGhIssueTriageClient(input.repoRoot);
      const evidencePort = createGitHubIssueTriageEvidencePort({ client });
      return {
        fetchEvidence: evidencePort.fetchEvidence,
        listRepoLabels: () =>
          listRepoLabels(input.repoRoot, profile.owner, profile.name),
        listRepoLabelNames: () =>
          listRepoLabelNames(input.repoRoot, profile.owner, profile.name),
        listIssueLabelNames: (issueNumber) =>
          listIssueLabelNames(
            input.repoRoot,
            profile.owner,
            profile.name,
            issueNumber,
          ),
        createLabel: (label) =>
          createIssueTriageLabel(
            input.repoRoot,
            profile.owner,
            profile.name,
            label,
          ),
        applyLabel: (issueNumber, label) =>
          applyIssueLabel(
            input.repoRoot,
            profile.owner,
            profile.name,
            issueNumber,
            label,
          ),
        async listTriageComments(issueNumber) {
          const comments = await ghApiJson<
            Array<{ id?: number | string | null; body?: string | null }>
          >(
            input.repoRoot,
            `${issueEndpoint(profile.owner, profile.name, issueNumber)}/comments?per_page=100`,
          );
          return comments.flatMap((comment) =>
            comment.id ? [{ id: comment.id, body: comment.body ?? null }] : [],
          );
        },
        postComment: (issueNumber, body) =>
          postGitHubIssueComment(
            input.repoRoot,
            profile.owner,
            profile.name,
            issueNumber,
            body,
          ),
        updateComment: (commentId, body) =>
          ghApiWithJsonBody(
            input.repoRoot,
            `repos/${profile.owner}/${profile.name}/issues/comments/${commentId}`,
            "PATCH",
            { body },
          ),
        closeIssue: (issueNumber) =>
          ghApiWithJsonBody(
            input.repoRoot,
            issueEndpoint(profile.owner, profile.name, issueNumber),
            "PATCH",
            { state: "closed", state_reason: "not_planned" },
          ),
        listIssues: (listInput) =>
          listIssuesForTriage(input.repoRoot, {
            owner: profile.owner,
            repo: profile.name,
            state: listInput.state,
            limit: listInput.limit,
            includeLabels: [...listInput.includeLabels],
            excludeLabels: [...listInput.excludeLabels],
          }),
      };
    },
  };
}

function buildIssueTriageProvider(input: {
  repoRoot: string;
  model: IssueTriageModelSelection;
}): { providerConfig: ModelProviderConfig; provider: ModelProvider } {
  if (!input.model.provider) {
    throw new Error(
      "triage issue requires --model codex or --model claude because issue triage is LLM-backed only.",
    );
  }
  const createdAt = new Date(0).toISOString();
  const codexModel =
    input.model.model ??
    process.env["OPEN_MAINTAINER_CODEX_MODEL"] ??
    DEFAULT_CODEX_CLI_MODEL;
  const providerConfig: ModelProviderConfig =
    input.model.provider === "codex"
      ? {
          id: "model_provider_cli_issue_triage_codex",
          kind: "codex-cli",
          displayName: "Codex CLI",
          baseUrl: "http://localhost",
          model: codexModel,
          encryptedApiKey: "local-cli",
          repoContentConsent: true,
          createdAt,
          updatedAt: createdAt,
        }
      : {
          id: "model_provider_cli_issue_triage_claude",
          kind: "claude-cli",
          displayName: "Claude CLI",
          baseUrl: "http://localhost",
          model: input.model.model ?? "claude-cli",
          encryptedApiKey: "local-cli",
          repoContentConsent: true,
          createdAt,
          updatedAt: createdAt,
        };
  const provider =
    input.model.provider === "codex"
      ? buildCodexCliProvider({
          cwd: input.repoRoot,
          model: codexModel,
        })
      : buildClaudeCliProvider({
          cwd: input.repoRoot,
          ...(input.model.model ? { model: input.model.model } : {}),
        });
  return { providerConfig, provider };
}

function buildGhIssueTriageClient(repoRoot: string): GitHubRepositoryClient {
  return {
    repos: {
      async getContent() {
        throw new Error(
          "Repository content fetching is not used for issue triage.",
        );
      },
      async createOrUpdateFileContents() {
        throw new Error("Repository writes are not used for issue triage.");
      },
    },
    git: {
      async getRef() {
        throw new Error("Git ref reads are not used for issue triage.");
      },
      async createRef() {
        throw new Error("Git ref writes are not used for issue triage.");
      },
      async updateRef() {
        throw new Error("Git ref writes are not used for issue triage.");
      },
    },
    pulls: {
      async list() {
        return { data: [] };
      },
      async create() {
        throw new Error("Pull request writes are not used for issue triage.");
      },
      async update() {
        throw new Error("Pull request writes are not used for issue triage.");
      },
    },
    issues: {
      async get(input) {
        return {
          data: await ghApiJson(
            repoRoot,
            issueEndpoint(input.owner, input.repo, input.issue_number),
          ),
        };
      },
      async listComments(input) {
        const args = [
          "-F",
          `per_page=${input.per_page ?? 100}`,
          "-F",
          `page=${input.page ?? 1}`,
        ];
        return {
          data: await ghApiJson(
            repoRoot,
            `${issueEndpoint(input.owner, input.repo, input.issue_number)}/comments`,
            args,
          ),
        };
      },
    },
    search: {
      async issuesAndPullRequests(input) {
        const args = [
          "-F",
          `q=${input.q}`,
          "-F",
          `per_page=${input.per_page ?? 10}`,
          "-F",
          `page=${input.page ?? 1}`,
        ];
        return { data: await ghApiJson(repoRoot, "search/issues", args) };
      },
    },
  };
}

function issueEndpoint(
  owner: string,
  repo: string,
  issueNumber: number,
): string {
  return `repos/${owner}/${repo}/issues/${issueNumber}`;
}

async function listIssuesForTriage(
  repoRoot: string,
  input: {
    owner: string;
    repo: string;
    state: "open" | "closed" | "all";
    limit: number;
    includeLabels: string[];
    excludeLabels: string[];
  },
): Promise<Array<{ number: number; title: string; labels: string[] }>> {
  const issues: Array<{ number: number; title: string; labels: string[] }> = [];
  const skipAlreadyLabelled = input.includeLabels.length === 0;
  const pageSize = 100;
  for (let page = 1; issues.length < input.limit; page += 1) {
    const args = [
      "-F",
      `state=${input.state}`,
      "-F",
      `per_page=${pageSize}`,
      "-F",
      `page=${page}`,
      ...(input.includeLabels.length > 0
        ? ["-F", `labels=${input.includeLabels.join(",")}`]
        : []),
    ];
    const pageItems = await ghApiJson<
      Array<{
        number?: number | null;
        title?: string | null;
        labels?: Array<string | { name?: string | null }> | null;
        pull_request?: unknown;
      }>
    >(repoRoot, `repos/${input.owner}/${input.repo}/issues`, args);
    for (const item of pageItems) {
      if (issues.length >= input.limit) {
        break;
      }
      if (item.pull_request || !item.number || !item.title) {
        continue;
      }
      const labels = (item.labels ?? [])
        .map((label) => (typeof label === "string" ? label : label.name))
        .filter((label): label is string => Boolean(label));
      if (
        labels.some((label) =>
          input.excludeLabels.some(
            (excluded) =>
              normalizeSimpleLabel(label) === normalizeSimpleLabel(excluded),
          ),
        )
      ) {
        continue;
      }
      if (skipAlreadyLabelled && labels.length > 0) {
        continue;
      }
      issues.push({ number: item.number, title: item.title, labels });
    }
    if (pageItems.length < pageSize) {
      break;
    }
  }
  return issues;
}

async function listRepoLabelNames(
  repoRoot: string,
  owner: string,
  repo: string,
): Promise<Set<string>> {
  return new Set(
    (await listRepoLabels(repoRoot, owner, repo)).map((label) => label.name),
  );
}

async function listRepoLabels(
  repoRoot: string,
  owner: string,
  repo: string,
): Promise<
  Array<{
    id?: string;
    name: string;
    color?: string;
    description?: string | null;
  }>
> {
  const labels = await ghApiJson<Array<{ name?: string | null }>>(
    repoRoot,
    `repos/${owner}/${repo}/labels?per_page=100`,
  );
  return labels.flatMap((label) =>
    label.name ? [{ ...label, name: label.name }] : [],
  );
}

async function listIssueLabelNames(
  repoRoot: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<Set<string>> {
  const labels = await ghApiJson<Array<{ name?: string | null }>>(
    repoRoot,
    `${issueEndpoint(owner, repo, issueNumber)}/labels?per_page=100`,
  );
  return new Set(labels.flatMap((label) => (label.name ? [label.name] : [])));
}

async function createIssueTriageLabel(
  repoRoot: string,
  owner: string,
  repo: string,
  label: IssueTriageResolvedLabel,
): Promise<void> {
  await createGitHubLabel(
    repoRoot,
    owner,
    repo,
    label.label,
    label.color ?? "5319e7",
    {
      description:
        label.description ?? "Open Maintainer issue triage preset label.",
    },
  );
}

async function applyIssueLabel(
  repoRoot: string,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  await editGitHubIssueLabels(repoRoot, owner, repo, issueNumber, {
    addLabel: label,
  });
}

async function createGitHubLabel(
  repoRoot: string,
  owner: string,
  repo: string,
  label: string,
  color: string,
  options: { description: string },
): Promise<void> {
  await ghApiWithJsonBody(repoRoot, `repos/${owner}/${repo}/labels`, "POST", {
    name: label,
    color,
    description: options.description,
  });
}

async function editGitHubIssueLabels(
  repoRoot: string,
  owner: string,
  repo: string,
  issueNumber: number,
  options: { addLabel?: string; removeLabel?: string },
): Promise<void> {
  if (options.addLabel) {
    await ghApiWithJsonBody(
      repoRoot,
      `repos/${owner}/${repo}/issues/${issueNumber}/labels`,
      "POST",
      { labels: [options.addLabel] },
    );
  }
  if (options.removeLabel) {
    await ghApiNoBody(
      repoRoot,
      `repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(options.removeLabel)}`,
      "DELETE",
    );
  }
}

async function postGitHubIssueComment(
  repoRoot: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await ghApiWithJsonBody(
    repoRoot,
    `repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    "POST",
    { body },
  );
}

async function writeIssueTriageArtifact(
  repoRoot: string,
  artifactPath: string,
  artifact: { input: IssueTriageInput; result: IssueTriageResult },
): Promise<void> {
  const absolutePath = path.join(repoRoot, artifactPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(artifact, null, 2)}\n`);
}

function issueTriageArtifactPath(issueNumber: number): string {
  return path.join(
    ".open-maintainer",
    "triage",
    "issues",
    `${issueNumber}.json`,
  );
}

async function readIssueTriageArtifact(
  repoRoot: string,
  artifactPath: string,
): Promise<{ input: IssueTriageInput; result: IssueTriageResult }> {
  const raw = JSON.parse(
    await readFile(path.join(repoRoot, artifactPath), "utf8"),
  ) as { input?: unknown; result?: unknown };
  return {
    input: IssueTriageInputSchema.parse(raw.input),
    result: IssueTriageResultSchema.parse(raw.result),
  };
}

async function writeTriageRunReports(
  repoRoot: string,
  input: {
    jsonPath: string;
    markdownPath: string;
    report: IssueTriageBatchReport;
    markdown: string;
  },
): Promise<void> {
  const absoluteJsonPath = path.join(repoRoot, input.jsonPath);
  const absoluteMarkdownPath = path.join(repoRoot, input.markdownPath);
  await mkdir(path.dirname(absoluteJsonPath), { recursive: true });
  await writeFile(
    absoluteJsonPath,
    `${JSON.stringify(input.report, null, 2)}\n`,
  );
  await writeFile(absoluteMarkdownPath, input.markdown);
}

async function ghApiJson<T>(
  repoRoot: string,
  endpoint: string,
  args: string[] = [],
): Promise<T> {
  return createGitHubCliApi({ repoRoot }).json<T>(endpoint, args);
}

async function ghApiWithJsonBody<T = unknown>(
  repoRoot: string,
  endpoint: string,
  method: "PATCH" | "POST",
  body: unknown,
): Promise<T> {
  return createGitHubCliApi({ repoRoot }).jsonWithBody<T>(
    endpoint,
    method,
    body,
  );
}

async function ghApiNoBody(
  repoRoot: string,
  endpoint: string,
  method: "DELETE",
): Promise<void> {
  await createGitHubCliApi({ repoRoot }).noBody(endpoint, method);
}

async function readOptionalRepoFile(
  repoRoot: string,
  repoPath: string,
): Promise<string | undefined> {
  return readFile(path.join(repoRoot, repoPath), "utf8").catch(() => undefined);
}

function issueBriefReadFirstPaths(profile: CliIssueTriageProfile): string[] {
  return [
    ...profile.existingContextFiles,
    ...profile.importantDocs,
    ...profile.repoTemplates,
  ].slice(0, 12);
}

function normalizeSimpleLabel(label: string): string {
  return label.toLowerCase().trim().replace(/[_/]+/g, "-").replace(/\s+/g, "-");
}
