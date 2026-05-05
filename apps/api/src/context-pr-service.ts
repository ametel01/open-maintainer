import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { scanRepository } from "@open-maintainer/analyzer";
import type { MemoryStore } from "@open-maintainer/db";
import {
  type ContextPrPublishInput,
  type ContextPrPublisher,
  type ContextPrWorkflowDeps,
  type GitHubAppInstallationAuth,
  type OpenContextPrResult,
  createContextPrWorkflow,
  createGitHubAppContextPrPublisher,
} from "@open-maintainer/github";
import {
  type ArtifactType,
  ArtifactTypeSchema,
  type GeneratedArtifact,
  type RepoProfile,
  isWritableContextArtifactType,
  newId,
  nowIso,
} from "@open-maintainer/shared";
import type {
  RepositoryLifecycleError,
  RepositorySourceLifecycle,
} from "./repository-source-analysis";

const execFileAsync = promisify(execFile);

export type DashboardContextPrService = {
  open(input: { repoId: string }): Promise<OpenContextPrResult>;
};

export type ContextPrCommandRunner = (input: {
  tool: "git" | "gh";
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}) => Promise<string>;

export type LocalGhContextPrPublisherOptions = {
  runCommand?: ContextPrCommandRunner;
  readFile?: typeof readFile;
  writeFile?: typeof writeFile;
  mkdir?: typeof mkdir;
  clock?: () => string;
  id?: () => string;
};

export function createDashboardContextPrService(input: {
  store: MemoryStore;
  repositorySources: RepositorySourceLifecycle;
  getInstallationAuth?: (
    installationId: string,
  ) => GitHubAppInstallationAuth | null;
  localPublisher?: ContextPrPublisher;
  githubAppPublisher?: ContextPrPublisher;
  scanRepository?: typeof scanRepository;
  readFile?: typeof readFile;
}): DashboardContextPrService {
  const localPublisher =
    input.localPublisher ?? createLocalGhContextPrPublisher();
  const workflow = createContextPrWorkflow(
    createDashboardContextPrWorkflowDeps({
      store: input.store,
      repositorySources: input.repositorySources,
      localPublisher,
      githubAppPublisher:
        input.githubAppPublisher ??
        createGitHubAppContextPrPublisher({
          credentials: (repo) =>
            repo.installationId && input.getInstallationAuth
              ? input.getInstallationAuth(repo.installationId)
              : null,
        }),
      scanRepository: input.scanRepository ?? scanRepository,
      readFile: input.readFile ?? readFile,
    }),
  );

  return {
    open({ repoId }) {
      return workflow.open({
        target: { kind: "registered-repo", repoId },
        origin: { kind: "dashboard" },
        writePolicy: "preserve-maintainer-owned",
      });
    },
  };
}

function createDashboardContextPrWorkflowDeps(input: {
  store: MemoryStore;
  repositorySources: RepositorySourceLifecycle;
  localPublisher: ContextPrPublisher;
  githubAppPublisher: ContextPrPublisher;
  scanRepository: typeof scanRepository;
  readFile: typeof readFile;
}): ContextPrWorkflowDeps {
  return {
    state: {
      runs: {
        start({ repo, artifacts }) {
          return input.store.recordRun({
            repoId: repo.repoId,
            type: "context_pr",
            status: "running",
            inputSummary: "Open context PR from approved artifact versions.",
            safeMessage: null,
            artifactVersions: artifacts.map((artifact) => artifact.version),
            repoProfileVersion: repo.profileVersion,
            provider: artifacts[0]?.modelProvider ?? null,
            model: artifacts[0]?.model ?? null,
            externalId: null,
          });
        },
        succeed({ run, contextPr }) {
          if (!run) {
            return null;
          }
          return input.store.updateRun(run.id, {
            status: "succeeded",
            safeMessage: `Opened context PR at ${contextPr.prUrl}.`,
            externalId: contextPr.prUrl,
          });
        },
        fail({ run, message }) {
          if (!run) {
            return null;
          }
          return input.store.updateRun(run.id, {
            status: "failed",
            safeMessage: message,
            externalId: null,
          });
        },
      },
      contextPrs: {
        save(contextPr) {
          input.store.contextPrs.set(contextPr.id, contextPr);
        },
      },
    },
    repositorySources: {
      async prepareRegisteredRepo(repoId) {
        const workspace = await input.repositorySources.prepare({
          repoId,
          intent: { kind: "context-pr" },
        });
        if (!workspace.ok) {
          throw {
            ok: false as const,
            statusCode: workspace.error.statusCode,
            code: contextPrSourceErrorCode(workspace.error.code),
            message: workspace.error.message,
            run: workspace.error.run,
          };
        }
        return {
          repoId,
          owner: workspace.value.repo.owner,
          name: workspace.value.repo.name,
          defaultBranch: workspace.value.repo.defaultBranch,
          profileVersion: workspace.value.profile.version,
          profile: workspace.value.profile,
          worktreeRoot: workspace.value.worktreeRoot,
          installationId: workspace.value.repo.installationId,
        };
      },
      async prepareWorkspace() {
        throw {
          ok: false as const,
          statusCode: 422,
          code: "WORKTREE_UNAVAILABLE",
          message: "Workspace context PRs are handled by the CLI.",
          run: null,
        };
      },
    },
    artifactCatalog: {
      async collect(repo) {
        if (!repo.profile) {
          return [];
        }
        return artifactsForContextPr({
          repoId: repo.repoId,
          profile: repo.profile,
          worktreeRoot: repo.worktreeRoot,
          store: input.store,
          scanRepository: input.scanRepository,
          readFile: input.readFile,
        });
      },
    },
    publishers: {
      localGh: input.localPublisher,
      githubApp: input.githubAppPublisher,
      actionGh: input.localPublisher,
    },
  };
}

function contextPrSourceErrorCode(
  code: RepositoryLifecycleError["code"],
): "UNKNOWN_REPO" | "NO_PROFILE" | "WORKTREE_UNAVAILABLE" {
  if (code === "NO_PROFILE" || code === "WORKTREE_UNAVAILABLE") {
    return code;
  }
  return "UNKNOWN_REPO";
}

async function artifactsForContextPr(input: {
  repoId: string;
  profile: RepoProfile;
  worktreeRoot: string | null;
  store: MemoryStore;
  scanRepository: typeof scanRepository;
  readFile: typeof readFile;
}): Promise<GeneratedArtifact[]> {
  const storedArtifacts = input.store.artifacts.get(input.repoId) ?? [];
  if (storedArtifacts.length >= 2) {
    return storedArtifacts;
  }
  if (!input.worktreeRoot) {
    return storedArtifacts;
  }

  const localArtifacts = await readContextArtifactsFromWorktree({
    repoId: input.repoId,
    profile: input.profile,
    worktreeRoot: input.worktreeRoot,
    scanRepository: input.scanRepository,
    readFile: input.readFile,
  });
  if (localArtifacts.length >= 2) {
    input.store.artifacts.set(input.repoId, localArtifacts);
    return localArtifacts;
  }
  return storedArtifacts;
}

async function readContextArtifactsFromWorktree(input: {
  repoId: string;
  profile: RepoProfile;
  worktreeRoot: string;
  scanRepository: typeof scanRepository;
  readFile: typeof readFile;
}): Promise<GeneratedArtifact[]> {
  const paths = await contextArtifactPathsInWorktree({
    worktreeRoot: input.worktreeRoot,
    scanRepository: input.scanRepository,
  });
  const timestamp = nowIso();
  const artifacts: GeneratedArtifact[] = [];
  for (const [index, artifactPath] of paths.entries()) {
    artifacts.push({
      id: newId("artifact"),
      repoId: input.repoId,
      type: artifactPath,
      version: index + 1,
      content: await input.readFile(
        path.join(input.worktreeRoot, artifactPath),
        "utf8",
      ),
      sourceProfileVersion: input.profile.version,
      modelProvider: null,
      model: null,
      createdAt: timestamp,
    });
  }
  return artifacts;
}

async function contextArtifactPathsInWorktree(input: {
  worktreeRoot: string;
  scanRepository: typeof scanRepository;
}): Promise<ArtifactType[]> {
  const files = await input.scanRepository(input.worktreeRoot, {
    maxFiles: 800,
  });
  return files
    .map((file) => ArtifactTypeSchema.safeParse(file.path))
    .filter((result) => result.success)
    .map((result) => result.data)
    .filter(isWritableContextArtifactType);
}

export function createLocalGhContextPrPublisher(
  options: LocalGhContextPrPublisherOptions = {},
): ContextPrPublisher {
  return {
    publish(input) {
      return createLocalContextPrWithGh(input, localPublisherDeps(options));
    },
  };
}

function localPublisherDeps(options: LocalGhContextPrPublisherOptions) {
  return {
    runCommand: options.runCommand ?? defaultContextPrCommandRunner,
    readFile: options.readFile ?? readFile,
    writeFile: options.writeFile ?? writeFile,
    mkdir: options.mkdir ?? mkdir,
    clock: options.clock ?? nowIso,
    id: options.id ?? (() => newId("context_pr")),
  };
}

async function saveArtifactsToLocalWorktree(
  worktreeRoot: string,
  input: ContextPrPublishInput,
  deps: ReturnType<typeof localPublisherDeps>,
): Promise<string[]> {
  const savedPaths: string[] = [];
  for (const { artifact, path: artifactPath } of input.writableArtifacts) {
    const destination = path.join(worktreeRoot, artifactPath);
    const relativePath = path.relative(worktreeRoot, destination);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(
        `Refusing to write artifact outside repository: ${artifact.type}`,
      );
    }
    const existingContent = await deps
      .readFile(destination, "utf8")
      .catch(() => null);
    if (
      existingContent &&
      !input.shouldOverwriteExistingFile(existingContent)
    ) {
      continue;
    }
    await deps.mkdir(path.dirname(destination), { recursive: true });
    await deps.writeFile(destination, artifact.content, "utf8");
    savedPaths.push(relativePath);
  }
  if (savedPaths.length === 0) {
    throw new Error(
      "No context artifact files were written because existing files are preserved by default.",
    );
  }
  return savedPaths;
}

async function createLocalContextPrWithGh(
  input: ContextPrPublishInput,
  deps: ReturnType<typeof localPublisherDeps>,
) {
  if (!input.repo.worktreeRoot) {
    throw new Error("A writable local worktree is required.");
  }
  await requireLocalGhPrReady(input.repo.worktreeRoot, deps);

  const originalBranch = await detectLocalDefaultBranch(
    input.repo.worktreeRoot,
    deps,
  );
  try {
    await runGit(
      input.repo.worktreeRoot,
      ["checkout", "-B", input.branchName, input.repo.defaultBranch],
      deps,
    );
    const savedPaths = await saveArtifactsToLocalWorktree(
      input.repo.worktreeRoot,
      input,
      deps,
    );
    await runGit(input.repo.worktreeRoot, ["add", "--", ...savedPaths], deps);
    const hasStagedChanges = await gitHasStagedChanges(
      input.repo.worktreeRoot,
      deps,
    );
    if (!hasStagedChanges) {
      throw new Error("generated context files did not change the worktree.");
    }
    await runGit(
      input.repo.worktreeRoot,
      ["commit", "-m", "Update Open Maintainer context"],
      deps,
      gitCommitIdentityEnv(),
    );
    const commitSha = (
      await runGit(input.repo.worktreeRoot, ["rev-parse", "HEAD"], deps)
    ).trim();
    await runGit(
      input.repo.worktreeRoot,
      ["push", "--set-upstream", "origin", input.branchName],
      deps,
      gitPushAuthEnv(),
    );

    const prUrl = await openOrUpdateGhPullRequest(
      input.repo.worktreeRoot,
      {
        baseBranch: input.repo.defaultBranch,
        headBranch: input.branchName,
        title: input.title,
        body: input.body,
      },
      deps,
    );

    return {
      id: deps.id(),
      repoId: input.repo.repoId,
      branchName: input.branchName,
      commitSha,
      prNumber: pullRequestNumber(prUrl),
      prUrl,
      artifactVersions: input.writableArtifacts.map(
        ({ artifact }) => artifact.version,
      ),
      status: "succeeded" as const,
      createdAt: deps.clock(),
    };
  } finally {
    if (originalBranch !== "local" && originalBranch !== input.branchName) {
      await runGit(
        input.repo.worktreeRoot,
        ["checkout", originalBranch],
        deps,
      ).catch(() => undefined);
    }
  }
}

async function openOrUpdateGhPullRequest(
  cwd: string,
  input: {
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
  },
  deps: ReturnType<typeof localPublisherDeps>,
): Promise<string> {
  const existingPrUrl = await findExistingGhPullRequestUrl(
    cwd,
    input.headBranch,
    deps,
  );
  if (existingPrUrl) {
    await runGh(
      cwd,
      [
        "pr",
        "edit",
        input.headBranch,
        "--title",
        input.title,
        "--body",
        input.body,
      ],
      deps,
    );
    return existingPrUrl;
  }

  const prUrl = findFirstUrl(
    await runGh(
      cwd,
      [
        "pr",
        "create",
        "--base",
        input.baseBranch,
        "--head",
        input.headBranch,
        "--title",
        input.title,
        "--body",
        input.body,
      ],
      deps,
    ),
  );
  if (!prUrl) {
    throw new Error("gh did not return a pull request URL.");
  }
  return prUrl;
}

async function findExistingGhPullRequestUrl(
  cwd: string,
  headBranch: string,
  deps: ReturnType<typeof localPublisherDeps>,
): Promise<string | null> {
  try {
    return findFirstUrl(
      await runGh(
        cwd,
        ["pr", "view", headBranch, "--json", "url", "--jq", ".url"],
        deps,
      ),
    );
  } catch {
    return null;
  }
}

async function requireLocalGhPrReady(
  cwd: string,
  deps: ReturnType<typeof localPublisherDeps>,
): Promise<void> {
  await requireGitRepository(cwd, deps);
  await runGit(cwd, ["remote", "get-url", "origin"], deps);
  await requireGhAuthentication(cwd, deps);
}

async function requireGhAuthentication(
  cwd: string,
  deps: ReturnType<typeof localPublisherDeps>,
): Promise<void> {
  try {
    await runGh(cwd, ["auth", "status"], deps);
  } catch {
    throw new Error(
      "gh is not authenticated in the API environment. Set GH_TOKEN in .env and recreate the API container, run gh auth login inside the API container, or mount an authenticated GitHub CLI config.",
    );
  }
}

async function requireGitRepository(
  cwd: string,
  deps: ReturnType<typeof localPublisherDeps>,
): Promise<void> {
  try {
    await runGit(cwd, ["rev-parse", "--show-toplevel"], deps);
  } catch {
    throw new Error(
      "the selected repository is not a Git checkout in the API environment. Add it by mounted path instead of browser upload.",
    );
  }
}

async function gitHasStagedChanges(
  cwd: string,
  deps: ReturnType<typeof localPublisherDeps>,
): Promise<boolean> {
  try {
    await runGit(cwd, ["diff", "--cached", "--quiet"], deps);
    return false;
  } catch {
    return true;
  }
}

async function runGit(
  cwd: string,
  args: string[],
  deps: ReturnType<typeof localPublisherDeps>,
  env?: Record<string, string>,
): Promise<string> {
  return deps.runCommand({
    tool: "git",
    command: process.env.OPEN_MAINTAINER_GIT_COMMAND ?? "git",
    args,
    cwd,
    ...(env ? { env } : {}),
  });
}

async function runGh(
  cwd: string,
  args: string[],
  deps: ReturnType<typeof localPublisherDeps>,
): Promise<string> {
  return deps.runCommand({
    tool: "gh",
    command: process.env.OPEN_MAINTAINER_GH_COMMAND ?? "gh",
    args,
    cwd,
  });
}

async function defaultContextPrCommandRunner(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(input.command, input.args, {
      cwd: input.cwd,
      ...(input.env ? { env: { ...process.env, ...input.env } } : {}),
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    });
    return stdout;
  } catch (error) {
    if (isExecError(error)) {
      const details = [error.stderr, error.stdout, error.message]
        .filter((part) => typeof part === "string" && part.trim().length > 0)
        .join("\n")
        .trim();
      throw new Error(
        `${input.command} ${input.args.join(" ")} failed: ${details}`,
      );
    }
    throw error;
  }
}

function gitCommitIdentityEnv(): Record<string, string> {
  const name =
    process.env.OPEN_MAINTAINER_GIT_AUTHOR_NAME ??
    process.env.GIT_AUTHOR_NAME ??
    "Open Maintainer";
  const email =
    process.env.OPEN_MAINTAINER_GIT_AUTHOR_EMAIL ??
    process.env.GIT_AUTHOR_EMAIL ??
    "open-maintainer@users.noreply.github.com";
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

function gitPushAuthEnv(): Record<string, string> | undefined {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return undefined;
  }
  const credentials = Buffer.from(`x-access-token:${token}`, "utf8").toString(
    "base64",
  );
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credentials}`,
  };
}

async function detectLocalDefaultBranch(
  repoRoot: string,
  deps: ReturnType<typeof localPublisherDeps>,
): Promise<string> {
  try {
    const branch = (
      await runGit(repoRoot, ["branch", "--show-current"], deps)
    ).trim();
    return branch || "local";
  } catch {
    return "local";
  }
}

function isExecError(
  error: unknown,
): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error;
}

function findFirstUrl(output: string): string | null {
  return output.match(/https?:\/\/\S+/)?.[0] ?? null;
}

function pullRequestNumber(prUrl: string): number {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}
