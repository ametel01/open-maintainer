import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  prepareRepositoryProfile,
  scanRepository,
} from "@open-maintainer/analyzer";
import type { MemoryStore } from "@open-maintainer/db";
import {
  type GitHubAppInstallationAuth,
  fetchRepositoryFilesForAnalysis,
} from "@open-maintainer/github";
import type {
  Installation,
  Repo,
  RepoProfile,
  RunRecord,
} from "@open-maintainer/shared";
import { nowIso } from "@open-maintainer/shared";

export type RepositoryFile = {
  path: string;
  content: string;
};

export type RepositorySourceRegistration =
  | {
      kind: "local-worktree";
      repoRoot: string;
      owner?: string;
      name?: string;
    }
  | {
      kind: "uploaded-files";
      name?: string;
      files: RepositoryFile[];
    };

export type RepositoryLifecycleIntent =
  | {
      kind: "analyze";
      ref?: string;
      profile?: "refresh" | "reuse-or-create";
    }
  | { kind: "generate-context"; ref?: string }
  | {
      kind: "review-preview";
      baseRef?: string;
      headRef?: string;
      prNumber?: number;
    }
  | { kind: "context-pr"; requireWritableWorktree?: boolean };

export type RepositorySourceKind =
  | "local-worktree"
  | "uploaded-files"
  | "uploaded-files-mounted-worktree"
  | "github-app"
  | "cached";

export type RegisteredRepositorySource = {
  repo: Repo;
  fileCount: number;
  source: Extract<
    RepositorySourceKind,
    "local-worktree" | "uploaded-files" | "uploaded-files-mounted-worktree"
  >;
  worktreeRoot: string | null;
};

export type RepositorySourceWorkspace = {
  repo: Repo;
  files: RepositoryFile[];
  profile: RepoProfile;
  profileCreated: boolean;
  worktreeRoot: string | null;
  source: RepositorySourceKind;
  run: RunRecord | null;
};

export type RepositoryLifecycleError = {
  statusCode: 404 | 409 | 422;
  code:
    | "UNKNOWN_REPO"
    | "NO_READABLE_FILES"
    | "REPOSITORY_FILES_UNAVAILABLE"
    | "NO_PROFILE"
    | "WORKTREE_UNAVAILABLE";
  message: string;
  run: RunRecord | null;
};

export type RepositoryLifecycleResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RepositoryLifecycleError };

export interface RepositorySourceLifecycle {
  register(
    input: RepositorySourceRegistration,
  ): Promise<RepositoryLifecycleResult<RegisteredRepositorySource>>;

  prepare(input: {
    repoId: string;
    intent: RepositoryLifecycleIntent;
  }): Promise<RepositoryLifecycleResult<RepositorySourceWorkspace>>;
}

export type RepositorySourceStatePort = {
  repo(repoId: string): Repo | null;
  files(repoId: string): RepositoryFile[];
  saveFiles(repoId: string, files: RepositoryFile[]): void;
  worktreeRoot(repoId: string): string | null;
  saveWorktreeRoot(repoId: string, worktreeRoot: string | null): void;
  source(repoId: string): RegisteredRepositorySource["source"] | null;
  latestProfile(repoId: string): RepoProfile | null;
  profileCount(repoId: string): number;
  addProfile(profile: RepoProfile): void;
  recordRun(
    input: Omit<RunRecord, "id" | "createdAt" | "updatedAt">,
  ): RunRecord;
  updateRun(id: string, patch: Partial<RunRecord>): RunRecord;
  saveRegisteredRepository(input: {
    repo: Repo;
    installation: Installation;
    files: RepositoryFile[];
    worktreeRoot: string | null;
    source: RegisteredRepositorySource["source"];
  }): void;
  clearDerivedRepositoryState(repoId: string): void;
};

type RepositoryFilesFetcher = (input: {
  owner: string;
  repo: string;
  ref: string;
  auth?: GitHubAppInstallationAuth;
}) => Promise<{ files: RepositoryFile[] }>;

type RepositoryScanner = typeof scanRepository;
type RepositoryProfilePreparer = typeof prepareRepositoryProfile;

export type RepositoryFileMaterializer = (input: {
  repoId: string;
  files: RepositoryFile[];
}) => Promise<string>;

export type MountedWorktreeMatcher = (input: {
  name: string;
  files: RepositoryFile[];
}) => Promise<{
  worktreeRoot: string;
  files: RepositoryFile[];
  defaultBranch: string;
} | null>;

export type RepositoryLifecycleGitPort = {
  detectDefaultBranch(repoRoot: string): Promise<string>;
  requireWorktree(repoRoot: string): Promise<void>;
};

type LifecycleOptions = {
  store?: MemoryStore;
  state?: RepositorySourceStatePort;
  scanRepository?: RepositoryScanner;
  prepareRepositoryProfile?: RepositoryProfilePreparer;
  fetchRepositoryFiles?: RepositoryFilesFetcher;
  getInstallationAuth?: (
    installationId: string,
  ) => GitHubAppInstallationAuth | null;
  materializeFiles?: RepositoryFileMaterializer;
  mountedWorktrees?: MountedWorktreeMatcher;
  git?: Partial<RepositoryLifecycleGitPort>;
  clock?: () => string;
};

type RepositoryFilesResult =
  | { ok: true; files: RepositoryFile[]; source: RepositorySourceKind }
  | { ok: false; error: RepositoryLifecycleError };

const execFileAsync = promisify(execFile);
const maxRepositoryFiles = 800;

export function createRepositorySourceLifecycle(
  options: LifecycleOptions,
): RepositorySourceLifecycle {
  const resolvedState =
    options.state ??
    (options.store
      ? repositorySourceStateFromMemoryStore(options.store)
      : undefined);
  if (!resolvedState) {
    throw new Error(
      "createRepositorySourceLifecycle requires a store or state port.",
    );
  }
  const state: RepositorySourceStatePort = resolvedState;

  const scanner = options.scanRepository ?? scanRepository;
  const profilePreparer =
    options.prepareRepositoryProfile ?? prepareRepositoryProfile;
  const fetchRepositoryFiles =
    options.fetchRepositoryFiles ?? defaultRepositoryFilesFetcher;
  const getInstallationAuth = options.getInstallationAuth ?? (() => null);
  const materializeFiles =
    options.materializeFiles ?? defaultRepositoryFileMaterializer;
  const clock = options.clock ?? nowIso;
  const git: RepositoryLifecycleGitPort = {
    detectDefaultBranch:
      options.git?.detectDefaultBranch ?? detectLocalDefaultBranch,
    requireWorktree: options.git?.requireWorktree ?? requireGitRepository,
  };
  const mountedWorktrees =
    options.mountedWorktrees ??
    createMountedWorktreeMatcher({ scanRepository: scanner, git });

  async function register(
    input: RepositorySourceRegistration,
  ): Promise<RepositoryLifecycleResult<RegisteredRepositorySource>> {
    if (input.kind === "local-worktree") {
      const repoRoot = path.resolve(input.repoRoot);
      const files = await scanner(repoRoot, {
        maxFiles: maxRepositoryFiles,
      });
      if (files.length === 0) {
        return noReadableFiles(
          "No readable repository files were found at the selected path.",
        );
      }

      const owner =
        (input.owner ?? path.basename(path.dirname(repoRoot))) || "local";
      const name = (input.name ?? path.basename(repoRoot)) || "repository";
      const repo = await registerLocalRepository({
        owner,
        name,
        files,
        source: "local-worktree",
        worktreeRoot: repoRoot,
        defaultBranch: await git.detectDefaultBranch(repoRoot),
      });

      return {
        ok: true,
        value: {
          repo,
          fileCount: files.length,
          source: "local-worktree",
          worktreeRoot: repoRoot,
        },
      };
    }

    const files = normalizeUploadedFiles(input.files);
    if (files.length === 0) {
      return noReadableFiles(
        "No readable repository files were provided by the selected directory.",
      );
    }

    const repoName = input.name ?? "uploaded-repo";
    const mountedWorktree = await mountedWorktrees({
      name: repoName,
      files,
    });
    const pendingRepo = localRepositoryRecord({
      owner: "local",
      name: repoName,
    });
    const source = mountedWorktree
      ? "uploaded-files-mounted-worktree"
      : "uploaded-files";
    const worktreeRoot =
      mountedWorktree?.worktreeRoot ??
      (await materializeFiles({ repoId: pendingRepo.id, files }));
    const repo = await registerLocalRepository({
      owner: "local",
      name: repoName,
      files: mountedWorktree?.files ?? files,
      id: pendingRepo.id,
      source,
      worktreeRoot,
      ...(mountedWorktree
        ? { defaultBranch: mountedWorktree.defaultBranch }
        : {}),
    });

    return {
      ok: true,
      value: {
        repo,
        fileCount: files.length,
        source,
        worktreeRoot,
      },
    };
  }

  async function prepare(input: {
    repoId: string;
    intent: RepositoryLifecycleIntent;
  }): Promise<RepositoryLifecycleResult<RepositorySourceWorkspace>> {
    const repo = state.repo(input.repoId);
    if (!repo) {
      return unknownRepo();
    }

    switch (input.intent.kind) {
      case "analyze":
        return prepareProfileWorkspace({
          repo,
          repoId: input.repoId,
          ...(input.intent.ref ? { ref: input.intent.ref } : {}),
          profilePolicy: input.intent.profile ?? "refresh",
          createdRunMessage: "Repository profile generated.",
        });
      case "generate-context":
        return existingProfileWorkspace({
          repo,
          repoId: input.repoId,
          ...(input.intent.ref ? { ref: input.intent.ref } : {}),
          missingProfileMessage:
            "Generate a repo profile before context artifacts.",
        });
      case "review-preview":
        return prepareProfileWorkspace({
          repo,
          repoId: input.repoId,
          ...(input.intent.baseRef ? { ref: input.intent.baseRef } : {}),
          profilePolicy: "reuse-or-create",
          createdRunMessage:
            "Repository profile generated for PR review preview.",
        });
      case "context-pr": {
        const workspace = await existingProfileWorkspace({
          repo,
          repoId: input.repoId,
          missingProfileMessage: "No repo profile available.",
        });
        if (!workspace.ok) {
          return workspace;
        }
        if (input.intent.requireWritableWorktree) {
          const worktreeRoot = workspace.value.worktreeRoot;
          if (!worktreeRoot) {
            return worktreeUnavailable();
          }
          try {
            await git.requireWorktree(worktreeRoot);
          } catch {
            return worktreeUnavailable();
          }
        }
        return workspace;
      }
    }
  }

  async function prepareProfileWorkspace(input: {
    repoId: string;
    repo: Repo;
    ref?: string;
    profilePolicy: "refresh" | "reuse-or-create";
    createdRunMessage: string;
  }): Promise<RepositoryLifecycleResult<RepositorySourceWorkspace>> {
    const existingProfile = state.latestProfile(input.repoId);
    const shouldCreateProfile =
      input.profilePolicy === "refresh" || !existingProfile;
    const run = shouldCreateProfile
      ? state.recordRun({
          repoId: input.repoId,
          type: "analysis",
          status: "running",
          inputSummary: `Analyze ${input.repo.fullName}`,
          safeMessage: null,
          artifactVersions: [],
          repoProfileVersion: null,
          provider: null,
          model: null,
          externalId: null,
        })
      : null;
    const filesResult = await repositoryFilesForWorkspace({
      repo: input.repo,
      repoId: input.repoId,
      ...(input.ref ? { ref: input.ref } : {}),
    });
    if (!filesResult.ok) {
      const failedRun = run
        ? state.updateRun(run.id, {
            status: "failed",
            safeMessage: filesResult.error.message,
          })
        : null;
      return {
        ok: false,
        error: {
          ...filesResult.error,
          run: failedRun,
        },
      };
    }

    const profile = shouldCreateProfile
      ? await createProfile({
          repo: input.repo,
          repoId: input.repoId,
          files: filesResult.files,
        })
      : existingProfile;
    if (!profile) {
      return noProfile("No repo profile available.");
    }
    const updatedRun = run
      ? state.updateRun(run.id, {
          status: "succeeded",
          repoProfileVersion: profile.version,
          safeMessage: input.createdRunMessage,
        })
      : null;

    return {
      ok: true,
      value: {
        repo: input.repo,
        files: filesResult.files,
        profile,
        profileCreated: shouldCreateProfile,
        run: updatedRun,
        worktreeRoot: state.worktreeRoot(input.repoId),
        source: filesResult.source,
      },
    };
  }

  async function existingProfileWorkspace(input: {
    repoId: string;
    repo: Repo;
    ref?: string;
    missingProfileMessage: string;
  }): Promise<RepositoryLifecycleResult<RepositorySourceWorkspace>> {
    const profile = state.latestProfile(input.repoId);
    if (!profile) {
      return noProfile(input.missingProfileMessage);
    }
    const filesResult = await repositoryFilesForWorkspace({
      repo: input.repo,
      repoId: input.repoId,
      ...(input.ref ? { ref: input.ref } : {}),
    });
    if (!filesResult.ok) {
      return filesResult;
    }
    return {
      ok: true,
      value: {
        repo: input.repo,
        files: filesResult.files,
        profile,
        profileCreated: false,
        run: null,
        worktreeRoot: state.worktreeRoot(input.repoId),
        source: filesResult.source,
      },
    };
  }

  async function repositoryFilesForWorkspace(input: {
    repoId: string;
    repo: Repo;
    ref?: string;
  }): Promise<RepositoryFilesResult> {
    const auth = getInstallationAuth(input.repo.installationId);
    if (auth) {
      try {
        const fetched = await fetchRepositoryFiles({
          owner: input.repo.owner,
          repo: input.repo.name,
          ref: input.ref ?? input.repo.defaultBranch,
          auth,
        });
        const files = normalizeRepositoryFiles(fetched.files);
        if (files.length === 0) {
          return noReadableFiles(
            "No readable repository files are available for this repository.",
          );
        }
        state.saveFiles(input.repoId, files);
        return { ok: true, files, source: "github-app" };
      } catch {
        return repositoryFilesUnavailable();
      }
    }

    const files = state.files(input.repoId);
    if (files.length > 0) {
      return {
        ok: true,
        files,
        source: state.source(input.repoId) ?? "cached",
      };
    }
    return repositoryFilesUnavailable();
  }

  async function createProfile(input: {
    repoId: string;
    repo: Repo;
    files: RepositoryFile[];
  }): Promise<RepoProfile> {
    const version = state.profileCount(input.repoId) + 1;
    const result = await profilePreparer({
      files: input.files,
      identity: {
        repoId: input.repoId,
        owner: input.repo.owner,
        name: input.repo.name,
        defaultBranch: input.repo.defaultBranch,
        version,
      },
    });
    const profile = result.profile;
    state.addProfile(profile);
    return profile;
  }

  async function registerLocalRepository(input: {
    owner: string;
    name: string;
    files: RepositoryFile[];
    id?: string;
    source: RegisteredRepositorySource["source"];
    worktreeRoot?: string;
    defaultBranch?: string;
  }): Promise<Repo> {
    const repo = localRepositoryRecord(input);

    state.saveRegisteredRepository({
      repo,
      installation: localInstallation(clock),
      files: input.files,
      worktreeRoot: input.worktreeRoot ?? null,
      source: input.source,
    });
    state.clearDerivedRepositoryState(repo.id);

    return repo;
  }

  return {
    register,
    prepare,
  };
}

const memoryStoreSources = new WeakMap<
  MemoryStore,
  Map<string, RegisteredRepositorySource["source"]>
>();

export function repositorySourceStateFromMemoryStore(
  store: MemoryStore,
): RepositorySourceStatePort {
  let sources = memoryStoreSources.get(store);
  if (!sources) {
    sources = new Map();
    memoryStoreSources.set(store, sources);
  }

  const saveWorktreeRoot = (repoId: string, worktreeRoot: string | null) => {
    if (worktreeRoot) {
      store.repoWorktrees.set(repoId, worktreeRoot);
    } else {
      store.repoWorktrees.delete(repoId);
    }
  };

  return {
    repo(repoId) {
      return store.repos.get(repoId) ?? null;
    },
    files(repoId) {
      return store.repoFiles.get(repoId) ?? [];
    },
    saveFiles(repoId, files) {
      store.repoFiles.set(repoId, files);
    },
    worktreeRoot(repoId) {
      return store.repoWorktrees.get(repoId) ?? null;
    },
    saveWorktreeRoot,
    source(repoId) {
      return sources.get(repoId) ?? null;
    },
    latestProfile(repoId) {
      return store.latestProfile(repoId);
    },
    profileCount(repoId) {
      return store.profiles.get(repoId)?.length ?? 0;
    },
    addProfile(profile) {
      store.addProfile(profile);
    },
    recordRun(input) {
      return store.recordRun(input);
    },
    updateRun(id, patch) {
      return store.updateRun(id, patch);
    },
    saveRegisteredRepository(input) {
      store.installations.set(input.repo.installationId, input.installation);
      store.repos.set(input.repo.id, input.repo);
      store.repoFiles.set(input.repo.id, input.files);
      sources.set(input.repo.id, input.source);
      saveWorktreeRoot(input.repo.id, input.worktreeRoot);
    },
    clearDerivedRepositoryState(repoId) {
      store.profiles.delete(repoId);
      store.artifacts.delete(repoId);
    },
  };
}

async function defaultRepositoryFilesFetcher(input: {
  owner: string;
  repo: string;
  ref: string;
  auth?: GitHubAppInstallationAuth;
}): Promise<{ files: RepositoryFile[] }> {
  const fetched = await fetchRepositoryFilesForAnalysis(input);
  return {
    files: fetched.files.map((file) => ({
      path: file.path,
      content: file.content,
    })),
  };
}

function normalizeRepositoryFiles(files: RepositoryFile[]): RepositoryFile[] {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
  }));
}

function normalizeUploadedFiles(files: RepositoryFile[]): RepositoryFile[] {
  return files.flatMap((file) => {
    const normalizedPath = normalizeUploadedPath(file.path);
    return normalizedPath ? [{ ...file, path: normalizedPath }] : [];
  });
}

function lifecycleError(
  statusCode: RepositoryLifecycleError["statusCode"],
  code: RepositoryLifecycleError["code"],
  message: string,
  run: RunRecord | null = null,
): { ok: false; error: RepositoryLifecycleError } {
  return {
    ok: false,
    error: {
      statusCode,
      code,
      message,
      run,
    },
  };
}

function unknownRepo(): RepositoryLifecycleResult<never> {
  return lifecycleError(404, "UNKNOWN_REPO", "Unknown repo.");
}

function noProfile(message: string): {
  ok: false;
  error: RepositoryLifecycleError;
} {
  return lifecycleError(409, "NO_PROFILE", message);
}

function noReadableFiles(message: string): {
  ok: false;
  error: RepositoryLifecycleError;
} {
  return lifecycleError(422, "NO_READABLE_FILES", message);
}

function worktreeUnavailable(): {
  ok: false;
  error: RepositoryLifecycleError;
} {
  return lifecycleError(
    409,
    "WORKTREE_UNAVAILABLE",
    "A writable local repository worktree is required for this operation.",
  );
}

function repositoryFilesUnavailable(): {
  ok: false;
  error: RepositoryLifecycleError;
} {
  return lifecycleError(
    409,
    "REPOSITORY_FILES_UNAVAILABLE",
    "Repository files are unavailable. Configure GitHub App credentials with contents read permission or seed local files for development.",
  );
}

function localRepositoryRecord(input: {
  owner: string;
  name: string;
  id?: string;
  defaultBranch?: string;
}): Repo {
  return {
    id: input.id ?? `local_${slugId(input.owner)}_${slugId(input.name)}`,
    installationId: "installation_local",
    owner: input.owner,
    name: input.name,
    fullName: `${input.owner}/${input.name}`,
    defaultBranch: input.defaultBranch ?? "local",
    private: true,
    permissions: { contents: true, metadata: true, pull_requests: false },
  };
}

function localInstallation(clock: () => string): Installation {
  return {
    id: "installation_local",
    accountLogin: "local",
    accountType: "Local",
    repositorySelection: "selected",
    permissions: {
      contents: "local",
      metadata: "local",
      pull_requests: "mock",
    },
    createdAt: clock(),
  };
}

function createMountedWorktreeMatcher(input: {
  scanRepository: RepositoryScanner;
  git: RepositoryLifecycleGitPort;
}): MountedWorktreeMatcher {
  return async ({ name, files }) => {
    for (const candidateRoot of mountedWorktreeCandidates()) {
      try {
        await input.git.requireWorktree(candidateRoot);
        const candidateFiles = await input.scanRepository(candidateRoot, {
          maxFiles: maxRepositoryFiles,
        });
        if (
          uploadedFilesMatchMountedWorktree({
            uploadName: name,
            uploadedFiles: files,
            candidateRoot,
            candidateFiles,
          })
        ) {
          return {
            worktreeRoot: candidateRoot,
            files: candidateFiles,
            defaultBranch: await input.git.detectDefaultBranch(candidateRoot),
          };
        }
      } catch {}
    }
    return null;
  };
}

function mountedWorktreeCandidates(): string[] {
  const configuredRoots = (
    process.env.OPEN_MAINTAINER_DASHBOARD_REPO_ROOTS ??
    process.env.OPEN_MAINTAINER_DASHBOARD_REPO_ROOT ??
    ""
  )
    .split(path.delimiter)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0);
  const candidates = [...configuredRoots, process.cwd(), "/app"];
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function uploadedFilesMatchMountedWorktree(input: {
  uploadName: string;
  uploadedFiles: RepositoryFile[];
  candidateRoot: string;
  candidateFiles: RepositoryFile[];
}): boolean {
  const uploadedPackageName = packageNameFromFiles(input.uploadedFiles);
  const candidatePackageName = packageNameFromFiles(input.candidateFiles);
  if (
    uploadedPackageName &&
    candidatePackageName &&
    uploadedPackageName === candidatePackageName
  ) {
    return true;
  }

  const uploadedSlug = slugId(input.uploadName);
  const candidateSlug = slugId(path.basename(input.candidateRoot));
  const uploadedPackageJson = rootFileContent(
    input.uploadedFiles,
    "package.json",
  );
  const candidatePackageJson = rootFileContent(
    input.candidateFiles,
    "package.json",
  );
  return (
    uploadedSlug === candidateSlug &&
    !!uploadedPackageJson &&
    uploadedPackageJson === candidatePackageJson
  );
}

function packageNameFromFiles(files: RepositoryFile[]): string | null {
  const packageJson = rootFileContent(files, "package.json");
  if (!packageJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(packageJson) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

function rootFileContent(
  files: RepositoryFile[],
  filePath: string,
): string | null {
  return files.find((file) => file.path === filePath)?.content ?? null;
}

async function defaultRepositoryFileMaterializer(input: {
  repoId: string;
  files: RepositoryFile[];
}): Promise<string> {
  const base =
    process.env.OPEN_MAINTAINER_LOCAL_REPO_CACHE ??
    path.join(tmpdir(), "open-maintainer", "local-repos");
  const root = path.join(base, input.repoId);
  await rm(root, { recursive: true, force: true });
  for (const file of input.files) {
    const normalizedPath = normalizeUploadedPath(file.path);
    if (!normalizedPath) {
      continue;
    }
    const destination = path.join(root, normalizedPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, "utf8");
  }
  return root;
}

function normalizeUploadedPath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    return null;
  }
  return parts.join("/");
}

async function detectLocalDefaultBranch(repoRoot: string): Promise<string> {
  try {
    return (await runGit(repoRoot, ["symbolic-ref", "--short", "HEAD"])).trim();
  } catch {
    return "local";
  }
}

async function requireGitRepository(cwd: string): Promise<void> {
  try {
    await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error("Not a Git checkout.");
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      process.env.OPEN_MAINTAINER_GIT_COMMAND ?? "git",
      args,
      {
        cwd,
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
      },
    );
    return stdout;
  } catch {
    throw new Error(`git ${args.join(" ")} failed.`);
  }
}

function slugId(value: string): string {
  let slug = "";
  let needsSeparator = false;

  for (const character of value.toLowerCase()) {
    const isAsciiLetter = character >= "a" && character <= "z";
    const isDigit = character >= "0" && character <= "9";
    if (isAsciiLetter || isDigit) {
      if (needsSeparator && slug.length > 0) {
        slug += "_";
      }
      slug += character;
      needsSeparator = false;
    } else {
      needsSeparator = slug.length > 0;
    }
  }

  return slug || "repo";
}
