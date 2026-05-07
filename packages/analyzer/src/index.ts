import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  DetectedCommand,
  EvidenceReference,
  RepoProfile,
} from "@open-maintainer/shared";
import {
  buildRepositoryIgnoreRules,
  isRepositoryPathIgnored,
  newId,
  nowIso,
  recognizedContextArtifactHints,
  repositoryIgnoreFileNames,
  requiredContextArtifactHints,
} from "@open-maintainer/shared";
import type { RepositoryIgnoreRule } from "@open-maintainer/shared";

export type AnalyzerFile = {
  path: string;
  content: string;
};

export type AnalyzeRepoInput = {
  repoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  version: number;
  files: AnalyzerFile[];
};

export type ScanRepositoryOptions = {
  maxFiles?: number;
  maxBytesPerFile?: number;
};

export type RepositoryIdentity = {
  repoId?: string;
  owner?: string;
  name?: string;
  defaultBranch?: string;
  version?: number;
};

export type GitHubRepositoryUrlReference = {
  owner: string;
  name: string;
  htmlUrl: string;
  cloneUrl: string;
};

export type RepositoryProfilePurpose =
  | "workspace"
  | "context"
  | "review"
  | "triage";

export type RepositoryProfileInput =
  | string
  | {
      repoRoot: string;
      identity?: RepositoryIdentity;
      scan?: ScanRepositoryOptions;
      purpose?: RepositoryProfilePurpose;
      previousProfile?: RepoProfile;
    }
  | {
      files: readonly AnalyzerFile[];
      identity: Required<RepositoryIdentity>;
      purpose?: RepositoryProfilePurpose;
      previousProfile?: RepoProfile;
    };

export type RepositoryProfileGuidance = {
  readiness: RepoProfile["agentReadiness"];
  summary: {
    status: "ready" | "needs_context" | "needs_human_attention";
    score: number;
    primaryMissingItems: string[];
  };
  suggestedActions: Array<{
    kind: "setup" | "testing" | "ci" | "docs" | "risk" | "generated-files";
    title: string;
    reason: string;
    evidence: EvidenceReference[];
  }>;
  validation: {
    defaultCommands: DetectedCommand[];
    commandsBySurface: Record<string, DetectedCommand[]>;
  };
  risk: {
    areas: string[];
    paths: string[];
    notes: string[];
  };
};

export type RepositoryProfileSource = {
  filesAnalyzed: number;
  scannedFromFilesystem: boolean;
  usedGitVisibleFiles: boolean;
  truncated: boolean;
};

export type RepositoryProfileResult = {
  profile: RepoProfile;
  guidance: RepositoryProfileGuidance;
  source: RepositoryProfileSource;
};

export type RepositoryProfilerDeps = {
  scanRepository(
    repoRoot: string,
    options?: ScanRepositoryOptions,
  ): Promise<AnalyzerFile[]>;
  analyzeRepo(input: AnalyzeRepoInput): RepoProfile;
  resolveIdentity(
    repoRoot: string,
  ): RepositoryIdentity | Promise<RepositoryIdentity>;
};

const defaultScanOptions = {
  maxFiles: 400,
  maxBytesPerFile: 128_000,
};

const execFileAsync = promisify(execFile);

const ignoredPathParts = new Set([
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
]);

const languageByExtension = new Map([
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript"],
  [".go", "Go"],
  [".py", "Python"],
  [".rs", "Rust"],
  [".nr", "Noir"],
  [".sol", "Solidity"],
  [".cairo", "Cairo"],
]);

const configFilePatterns = [
  /^tsconfig(\..+)?\.json$/,
  /^biome\.json$/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^\.eslintrc(\..+)?$/,
  /^\.prettierrc(\..+)?$/,
  /^docker-compose\.ya?ml$/,
  /^drizzle\.config\.[cm]?[jt]s$/,
  /^Scarb\.toml$/,
  /^Cargo\.toml$/,
  /^pyproject\.toml$/,
  /^go\.mod$/,
  /^Makefile$/,
];

const environmentFilePatterns = [
  /^\.env\.example$/,
  /^\.env\.sample$/,
  /^\.env\.template$/,
  /^\.env\.dist$/,
  /^\.envrc$/,
];

const contextArtifactPaths = [...requiredContextArtifactHints];
const recognizedContextArtifactPaths = [...recognizedContextArtifactHints];

export async function scanRepository(
  repoRoot: string,
  options: ScanRepositoryOptions = {},
): Promise<AnalyzerFile[]> {
  return (await scanRepositoryWithSource(repoRoot, options)).files;
}

type RepositoryProfileScanResult = {
  files: AnalyzerFile[];
  source: RepositoryProfileSource;
};

async function scanRepositoryWithSource(
  repoRoot: string,
  options: ScanRepositoryOptions = {},
): Promise<RepositoryProfileScanResult> {
  const absoluteRoot = path.resolve(repoRoot);
  const maxFiles = options.maxFiles ?? defaultScanOptions.maxFiles;
  const maxBytesPerFile =
    options.maxBytesPerFile ?? defaultScanOptions.maxBytesPerFile;
  const files: AnalyzerFile[] = [];
  const ignoreRules = await loadRepositoryIgnoreRules(absoluteRoot);
  const gitVisibleFiles = await listGitVisibleFiles(absoluteRoot);
  let truncated = false;

  if (gitVisibleFiles) {
    for (const relativePath of gitVisibleFiles) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (
        shouldSkipRepoPath(relativePath) ||
        isRepositoryPathIgnored(relativePath, ignoreRules) ||
        !shouldReadFile(relativePath)
      ) {
        continue;
      }
      const absolutePath = path.join(absoluteRoot, relativePath);
      const fileStat = await stat(absolutePath).catch(() => null);
      if (!fileStat?.isFile() || fileStat.size > maxBytesPerFile) {
        continue;
      }
      const content = await readFile(absolutePath, "utf8").catch(() => null);
      if (content === null) {
        continue;
      }
      files.push({ path: relativePath, content });
    }
    return {
      files,
      source: {
        filesAnalyzed: files.length,
        scannedFromFilesystem: true,
        usedGitVisibleFiles: true,
        truncated,
      },
    };
  }

  async function visit(directory: string): Promise<void> {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRepoPath(
        path.relative(absoluteRoot, absolutePath),
      );
      if (
        shouldSkipRepoPath(relativePath) ||
        isRepositoryPathIgnored(relativePath, ignoreRules)
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !shouldReadFile(relativePath)) {
        continue;
      }
      const fileStat = await stat(absolutePath).catch(() => null);
      if (!fileStat) {
        continue;
      }
      if (fileStat.size > maxBytesPerFile) {
        continue;
      }
      const content = await readFile(absolutePath, "utf8").catch(() => null);
      if (content === null) {
        continue;
      }
      files.push({ path: relativePath, content });
    }
  }

  await visit(absoluteRoot);
  return {
    files,
    source: {
      filesAnalyzed: files.length,
      scannedFromFilesystem: true,
      usedGitVisibleFiles: false,
      truncated,
    },
  };
}

export function createRepositoryProfiler(
  deps: Partial<RepositoryProfilerDeps> = {},
): {
  prepare(input: RepositoryProfileInput): Promise<RepositoryProfileResult>;
  guide(
    profile: RepoProfile,
    purpose?: RepositoryProfilePurpose,
  ): RepositoryProfileGuidance;
} {
  const resolved: RepositoryProfilerDeps = {
    scanRepository: deps.scanRepository ?? scanRepository,
    analyzeRepo: deps.analyzeRepo ?? analyzeRepo,
    resolveIdentity: deps.resolveIdentity ?? inferRepositoryIdentity,
  };
  const hasCustomScanner = Boolean(deps.scanRepository);

  async function prepare(
    input: RepositoryProfileInput,
  ): Promise<RepositoryProfileResult> {
    if (isFilesProfileInput(input)) {
      const identity = completeRepositoryIdentity(
        input.identity,
        undefined,
        input.previousProfile,
      );
      const profile = resolved.analyzeRepo({
        ...identity,
        files: Array.from(input.files),
      });
      return {
        profile,
        guidance: guideRepositoryProfile(profile, input.purpose),
        source: sourceForFileInput(input.files.length),
      };
    }

    const repoRoot = typeof input === "string" ? input : input.repoRoot;
    const scanOptions = typeof input === "string" ? {} : (input.scan ?? {});
    const scanResult = hasCustomScanner
      ? await scanWithCustomDependency(
          resolved.scanRepository,
          repoRoot,
          scanOptions,
        )
      : await scanRepositoryWithSource(repoRoot, scanOptions);
    const resolvedIdentity = await resolved.resolveIdentity(repoRoot);
    const inputIdentity =
      typeof input === "string" ? {} : (input.identity ?? {});
    const identity = completeRepositoryIdentity(
      { ...resolvedIdentity, ...inputIdentity },
      repoRoot,
      typeof input === "string" ? undefined : input.previousProfile,
    );
    const profile = resolved.analyzeRepo({
      ...identity,
      files: scanResult.files,
    });
    const purpose = typeof input === "string" ? undefined : input.purpose;
    return {
      profile,
      guidance: guideRepositoryProfile(profile, purpose),
      source: scanResult.source,
    };
  }

  return {
    prepare,
    guide: guideRepositoryProfile,
  };
}

export async function prepareRepositoryProfile(
  input: RepositoryProfileInput,
): Promise<RepositoryProfileResult> {
  return createRepositoryProfiler().prepare(input);
}

export type RepositoryWorkspaceScanOptions = Pick<
  ScanRepositoryOptions,
  "maxFiles" | "maxBytesPerFile"
>;

export interface RepositoryWorkspace {
  profile(repoRoot: string): Promise<RepoProfile>;
  profile(input: RepositoryWorkspaceProfileInput): Promise<RepoProfile>;
  scan(
    repoRoot: string,
    options?: RepositoryWorkspaceScanOptions,
  ): Promise<AnalyzerFile[]>;
  defaultBranch(repoRoot: string): Promise<string | null>;
}

export type RepositoryWorkspaceProfileInput = {
  repoRoot: string;
  files?: readonly AnalyzerFile[];
  scan?: RepositoryWorkspaceScanOptions;
  repoId?: string;
  version?: number;
};

export type RepositoryWorkspaceDeps = {
  scanRepository(
    repoRoot: string,
    options?: RepositoryWorkspaceScanOptions,
  ): Promise<AnalyzerFile[]>;
  analyzeRepo(input: AnalyzeRepoInput): RepoProfile;
  gitOutput(repoRoot: string, args: readonly string[]): Promise<string | null>;
};

const defaultRepositoryWorkspaceScanOptions = {
  maxFiles: 800,
} satisfies RepositoryWorkspaceScanOptions;

export function createRepositoryWorkspace(
  deps: Partial<RepositoryWorkspaceDeps> = {},
): RepositoryWorkspace {
  const resolved: RepositoryWorkspaceDeps = {
    scanRepository: deps.scanRepository ?? scanRepository,
    analyzeRepo: deps.analyzeRepo ?? analyzeRepo,
    gitOutput: deps.gitOutput ?? defaultRepositoryWorkspaceGitOutput,
  };
  const profiler = createRepositoryProfiler({
    scanRepository: resolved.scanRepository,
    analyzeRepo: resolved.analyzeRepo,
    resolveIdentity(repoRoot) {
      return resolveRepositoryWorkspaceIdentity(repoRoot, resolved.gitOutput);
    },
  });

  async function scan(
    repoRoot: string,
    options?: RepositoryWorkspaceScanOptions,
  ): Promise<AnalyzerFile[]> {
    return resolved.scanRepository(repoRoot, {
      ...defaultRepositoryWorkspaceScanOptions,
      ...options,
    });
  }

  async function profile(repoRoot: string): Promise<RepoProfile>;
  async function profile(
    input: RepositoryWorkspaceProfileInput,
  ): Promise<RepoProfile>;
  async function profile(
    input: string | RepositoryWorkspaceProfileInput,
  ): Promise<RepoProfile> {
    const profileInput =
      typeof input === "string" ? { repoRoot: input } : input;
    const repoId = profileInput.repoId ?? "local";
    const version = profileInput.version ?? 1;
    if (profileInput.files) {
      const identity = await resolveRepositoryWorkspaceIdentity(
        profileInput.repoRoot,
        resolved.gitOutput,
      );
      const result = await profiler.prepare({
        files: profileInput.files,
        identity: {
          repoId,
          version,
          ...identity,
        },
      });
      return result.profile;
    }

    const result = await profiler.prepare({
      repoRoot: profileInput.repoRoot,
      identity: {
        repoId,
        version,
      },
      scan: {
        ...defaultRepositoryWorkspaceScanOptions,
        ...profileInput.scan,
      },
    });
    return result.profile;
  }

  return {
    profile,
    scan,
    defaultBranch(repoRoot) {
      return detectRepositoryWorkspaceDefaultBranch(
        repoRoot,
        resolved.gitOutput,
      );
    },
  };
}

export function guideRepositoryProfile(
  profile: RepoProfile,
  purpose: RepositoryProfilePurpose = "workspace",
): RepositoryProfileGuidance {
  return {
    readiness: profile.agentReadiness,
    summary: {
      status: readinessStatus(profile),
      score: profile.agentReadiness.score,
      primaryMissingItems: prioritizeMissingItems(
        profile.agentReadiness.missingItems,
        purpose,
      ),
    },
    suggestedActions: buildSuggestedActions(profile),
    validation: {
      defaultCommands: selectDefaultValidationCommands(
        profile.commands,
        purpose,
      ),
      commandsBySurface: groupCommandsBySurface(profile.commands),
    },
    risk: {
      areas: [...profile.detectedRiskAreas],
      paths: dedupeStrings(profile.riskHintPaths),
      notes: buildRiskNotes(profile),
    },
  };
}

async function resolveRepositoryWorkspaceIdentity(
  repoRoot: string,
  gitOutput: RepositoryWorkspaceDeps["gitOutput"],
): Promise<{
  owner: string;
  name: string;
  defaultBranch: string;
}> {
  const fallback = {
    owner: path.basename(path.dirname(repoRoot)) || "local",
    name: path.basename(repoRoot),
    defaultBranch: "main",
  };
  const [remoteUrl, defaultBranch] = await Promise.all([
    safeRepositoryWorkspaceGitOutput(gitOutput, repoRoot, [
      "remote",
      "get-url",
      "origin",
    ]),
    detectRepositoryWorkspaceDefaultBranch(repoRoot, gitOutput),
  ]);
  const remoteIdentity = remoteUrl
    ? parseRepositoryWorkspaceGitHubRemote(remoteUrl)
    : null;
  return {
    owner: remoteIdentity?.owner ?? fallback.owner,
    name: remoteIdentity?.name ?? fallback.name,
    defaultBranch: defaultBranch ?? fallback.defaultBranch,
  };
}

async function detectRepositoryWorkspaceDefaultBranch(
  repoRoot: string,
  gitOutput: RepositoryWorkspaceDeps["gitOutput"],
): Promise<string | null> {
  const symbolicRef = await safeRepositoryWorkspaceGitOutput(
    gitOutput,
    repoRoot,
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
  );
  if (symbolicRef?.startsWith("origin/")) {
    return symbolicRef.slice("origin/".length);
  }
  return null;
}

async function safeRepositoryWorkspaceGitOutput(
  gitOutput: RepositoryWorkspaceDeps["gitOutput"],
  repoRoot: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    return await gitOutput(repoRoot, args);
  } catch {
    return null;
  }
}

async function defaultRepositoryWorkspaceGitOutput(
  repoRoot: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const gitArgs =
      args.join(" ") === "remote get-url origin"
        ? ["-C", repoRoot, "config", "--get", "remote.origin.url"]
        : ["-C", repoRoot, ...args];
    const { stdout } = await execFileAsync("git", gitArgs);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function parseRepositoryWorkspaceGitHubRemote(
  remoteUrl: string,
): { owner: string; name: string } | null {
  const normalized = remoteUrl.trim().replace(/\.git$/, "");
  const sshMatch = /^git@[^:]+:([^/]+)\/(.+)$/.exec(normalized);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], name: sshMatch[2] };
  }
  const githubUrl = parseGitHubRepositoryUrl(remoteUrl);
  if (githubUrl) {
    return { owner: githubUrl.owner, name: githubUrl.name };
  }
  try {
    const url = new URL(normalized);
    const [owner, name] = url.pathname.replace(/^\/+/, "").split("/");
    return owner && name ? { owner, name } : null;
  } catch {
    return null;
  }
}

export function parseGitHubRepositoryUrl(
  value: string,
): GitHubRepositoryUrlReference | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com"
  ) {
    return null;
  }
  const parts = url.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const [owner, rawName] = parts;
  const name = rawName?.replace(/\.git$/i, "");
  if (!owner || !name || name.length === 0) {
    return null;
  }
  return {
    owner,
    name,
    htmlUrl: `https://github.com/${owner}/${name}`,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
  };
}

async function listGitVisibleFiles(repoRoot: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        repoRoot,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout
      .split("\0")
      .filter(Boolean)
      .map(normalizeRepoPath)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return null;
  }
}

async function loadRepositoryIgnoreRules(
  repoRoot: string,
): Promise<RepositoryIgnoreRule[]> {
  const ignoreFiles = await Promise.all(
    repositoryIgnoreFileNames.map(async (fileName) => {
      const content = await readFile(
        path.join(repoRoot, fileName),
        "utf8",
      ).catch(() => null);
      return content === null ? null : { path: fileName, content };
    }),
  );
  return buildRepositoryIgnoreRules(
    ignoreFiles.filter(
      (file): file is NonNullable<(typeof ignoreFiles)[number]> =>
        file !== null,
    ),
  );
}

export function shouldSkipRepoPath(repoPath: string): boolean {
  return repoPath
    .split("/")
    .some(
      (part) => ignoredPathParts.has(part) || part.endsWith(".tsbuildinfo"),
    );
}

export function analyzeRepo(input: AnalyzeRepoInput): RepoProfile {
  const normalizedFiles = input.files
    .map((file) => ({ ...file, path: normalizeRepoPath(file.path) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const paths = normalizedFiles.map((file) => file.path);
  const evidence: EvidenceReference[] = [];
  const commands: DetectedCommand[] = [];
  const frameworks = new Set<string>();
  const workspaceManifests: string[] = [];

  for (const packageJson of normalizedFiles.filter((file) =>
    file.path.endsWith("package.json"),
  )) {
    evidence.push({ path: packageJson.path, reason: "package manifest" });
    const manifest = parseJson(packageJson.content) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      workspaces?: string[] | { packages?: string[] };
    } | null;
    if (!manifest) {
      continue;
    }
    if (manifest.workspaces) {
      workspaceManifests.push(packageJson.path);
    }
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      if (isQualityOrWorkflowScript(name)) {
        commands.push({
          name,
          command: commandForSource(packageJson.path, command),
          source: packageJson.path,
        });
      }
    }
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const candidate of [
      "next",
      "react",
      "fastify",
      "hono",
      "drizzle-orm",
      "vitest",
      "playwright",
      "typescript",
      "zod",
    ]) {
      if (deps[candidate]) {
        frameworks.add(candidate);
      }
    }
  }

  for (const makefile of normalizedFiles.filter(
    (file) => path.posix.basename(file.path) === "Makefile",
  )) {
    evidence.push({ path: makefile.path, reason: "make targets" });
    for (const target of detectMakeTargets(makefile.content)) {
      if (isQualityOrWorkflowScript(target)) {
        commands.push({
          name: target,
          command:
            makefile.path === "Makefile"
              ? `make ${target}`
              : `make -C ${path.posix.dirname(makefile.path)} ${target}`,
          source: makefile.path,
        });
      }
    }
  }

  for (const scarbToml of normalizedFiles.filter((file) =>
    file.path.endsWith("Scarb.toml"),
  )) {
    evidence.push({ path: scarbToml.path, reason: "Scarb manifest" });
    frameworks.add("Scarb");
    frameworks.add("Starknet Foundry");
    const scriptCommands = detectScarbScripts(scarbToml.content);
    for (const [name, command] of Object.entries(scriptCommands)) {
      if (isQualityOrWorkflowScript(name)) {
        const directory = path.posix.dirname(scarbToml.path);
        commands.push({
          name,
          command:
            directory === "."
              ? `scarb run ${name}`
              : `cd ${directory} && ${command}`,
          source: scarbToml.path,
        });
      }
    }
  }

  const lockfiles = paths.filter((repoPath) =>
    [
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "uv.lock",
      "Cargo.lock",
      "Scarb.lock",
      "go.sum",
    ].some(
      (lockfile) => repoPath === lockfile || repoPath.endsWith(`/${lockfile}`),
    ),
  );
  const ciWorkflows = paths.filter((repoPath) =>
    repoPath.startsWith(".github/workflows/"),
  );
  const importantDocs = paths.filter((repoPath) =>
    /^(README|CONTRIBUTING|docs\/|local-docs\/)/i.test(repoPath),
  );
  const repoTemplates = paths.filter(
    (repoPath) =>
      repoPath.startsWith(".github/ISSUE_TEMPLATE/") ||
      repoPath === ".github/pull_request_template.md" ||
      repoPath === "PULL_REQUEST_TEMPLATE.md",
  );
  const existingContextFiles = paths.filter(
    (repoPath) =>
      recognizedContextArtifactPaths.some((hint) => hint === repoPath) ||
      repoPath.startsWith(".agents/skills/") ||
      repoPath.startsWith(".claude/skills/"),
  );
  const configFiles = paths.filter((repoPath) =>
    configFilePatterns.some((pattern) =>
      pattern.test(path.posix.basename(repoPath)),
    ),
  );
  const ownershipHints = detectOwnershipHints(paths);
  const environmentFiles = paths.filter((repoPath) =>
    environmentFilePatterns.some((pattern) =>
      pattern.test(path.posix.basename(repoPath)),
    ),
  );
  const environmentVariables = detectEnvironmentVariables(normalizedFiles);
  const generatedFilePaths = detectGeneratedFilePaths(normalizedFiles);
  const ignoreFiles = paths.filter(
    (repoPath) =>
      repositoryIgnoreFileNames.some(
        (fileName) => path.posix.basename(repoPath) === fileName,
      ) || path.posix.basename(repoPath) === ".dockerignore",
  );
  const testFilePaths = detectTestFilePaths(paths);
  const riskHintPaths = detectRiskHintPaths(paths);
  const trackedDriftPaths = new Set([
    ...commands.map((command) => command.source),
    ...ciWorkflows,
    ...importantDocs,
    ...repoTemplates,
    ...existingContextFiles,
    ...workspaceManifests,
    ...lockfiles,
    ...configFiles,
    ...ownershipHints,
    ...environmentFiles,
    ...generatedFilePaths,
    ...ignoreFiles,
    ...testFilePaths,
    ...riskHintPaths,
  ]);
  const trackedFileHashes = normalizedFiles
    .filter((file) => trackedDriftPaths.has(file.path))
    .map((file) => ({
      path: file.path,
      hash: fileHash(file.content),
    }));
  const packageManager = detectPackageManager(lockfiles, paths);

  for (const repoPath of [
    ...lockfiles,
    ...ciWorkflows,
    ...importantDocs,
    ...repoTemplates,
    ...existingContextFiles,
    ...configFiles,
    ...ownershipHints,
    ...environmentFiles,
    ...generatedFilePaths,
    ...ignoreFiles,
    ...testFilePaths,
  ]) {
    evidence.push({ path: repoPath, reason: "detected repository context" });
  }

  const riskAreas = detectRiskAreas(
    riskHintPaths,
    ciWorkflows,
    existingContextFiles,
  );
  const profileBase = {
    id: newId("repo_profile"),
    repoId: input.repoId,
    version: input.version,
    owner: input.owner,
    name: input.name,
    defaultBranch: input.defaultBranch,
    primaryLanguages: [...new Set(paths.flatMap(detectLanguage))],
    frameworks: [...frameworks],
    packageManager,
    commands: dedupeCommands(commands),
    ciWorkflows,
    importantDocs,
    repoTemplates,
    architecturePathGroups: detectPathGroups(paths),
    generatedFileHints: contextArtifactPaths,
    generatedFilePaths,
    existingContextFiles,
    detectedRiskAreas: riskAreas,
    riskHintPaths,
    ownershipHints,
    environmentFiles,
    environmentVariables,
    ignoreFiles,
    testFilePaths,
    reviewRuleCandidates: buildRuleCandidates(commands, packageManager),
    evidence: dedupeEvidence(evidence),
    workspaceManifests: [...new Set(workspaceManifests)],
    lockfiles,
    configFiles,
    trackedFileHashes,
    contextArtifactHashes: [],
    createdAt: nowIso(),
  };

  const profileWithoutReadiness = {
    ...profileBase,
    agentReadiness: {
      score: 0,
      categories: [],
      missingItems: [],
      generatedAt: nowIso(),
    },
  };

  return {
    ...profileBase,
    agentReadiness: scoreAgentReadiness(profileWithoutReadiness),
  };
}

export function scoreAgentReadiness(
  profile: Pick<
    RepoProfile,
    | "commands"
    | "ciWorkflows"
    | "importantDocs"
    | "architecturePathGroups"
    | "repoTemplates"
    | "generatedFilePaths"
    | "existingContextFiles"
    | "reviewRuleCandidates"
    | "detectedRiskAreas"
    | "riskHintPaths"
    | "ownershipHints"
    | "environmentFiles"
    | "environmentVariables"
    | "ignoreFiles"
    | "testFilePaths"
    | "evidence"
    | "workspaceManifests"
    | "lockfiles"
    | "configFiles"
  >,
): RepoProfile["agentReadiness"] {
  const categories: RepoProfile["agentReadiness"]["categories"] = [
    scoreCategory({
      name: "setup clarity",
      maxScore: 13,
      checks: [
        check(
          profile.importantDocs.some((repoPath) => /^README/i.test(repoPath)),
          "README is missing.",
        ),
        check(
          profile.commands.length > 0,
          "No runnable scripts or Make targets detected.",
        ),
        check(
          profile.lockfiles.length > 0,
          "No lockfile or dependency lock evidence detected.",
        ),
        check(
          profile.environmentVariables.length === 0 ||
            profile.environmentFiles.length > 0 ||
            profile.importantDocs.length > 0,
          "Environment variables are referenced without example or setup documentation.",
        ),
      ],
      evidence: evidenceFor(profile, [
        ...profile.importantDocs,
        ...profile.commands.map((command) => command.source),
        ...profile.lockfiles,
        ...profile.environmentFiles,
      ]),
    }),
    scoreCategory({
      name: "architecture clarity",
      maxScore: 13,
      checks: [
        check(
          profile.architecturePathGroups.length > 0,
          "No major source directories detected.",
        ),
        check(
          profile.configFiles.length > 0,
          "No toolchain config files detected.",
        ),
        check(
          profile.workspaceManifests.length > 0 ||
            !profile.architecturePathGroups.some(
              (group) =>
                group.startsWith("apps/") || group.startsWith("packages/"),
            ),
          "No workspace or package boundary evidence detected.",
        ),
      ],
      evidence: evidenceFor(profile, [
        ...profile.architecturePathGroups,
        ...profile.configFiles,
        ...profile.workspaceManifests,
      ]),
    }),
    scoreCategory({
      name: "testing",
      maxScore: 13,
      checks: [
        check(
          hasCommand(profile.commands, "test"),
          "No test command detected.",
        ),
        check(profile.testFilePaths.length > 0, "No test files detected."),
      ],
      evidence: evidenceFor(profile, [
        ...profile.commands.map((command) => command.source),
        ...profile.testFilePaths,
      ]),
    }),
    scoreCategory({
      name: "CI",
      maxScore: 13,
      checks: [
        check(
          hasCommand(profile.commands, "lint") ||
            hasCommand(profile.commands, "check"),
          "No lint/check command detected.",
        ),
        check(
          profile.ciWorkflows.length > 0,
          "No GitHub Actions workflow detected.",
        ),
      ],
      evidence: evidenceFor(profile, [
        ...profile.commands.map((command) => command.source),
        ...profile.ciWorkflows,
      ]),
    }),
    scoreCategory({
      name: "docs",
      maxScore: 12,
      checks: [
        check(
          profile.importantDocs.some((repoPath) => /^README/i.test(repoPath)),
          "README is missing.",
        ),
        check(
          profile.importantDocs.some((repoPath) =>
            repoPath.startsWith("docs/"),
          ),
          "No docs directory detected.",
        ),
        check(
          profile.importantDocs.some((repoPath) =>
            /CONTRIBUTING/i.test(repoPath),
          ),
          "CONTRIBUTING.md is missing.",
        ),
      ],
      evidence: evidenceFor(profile, [
        ...profile.importantDocs,
        ...profile.repoTemplates,
      ]),
    }),
    scoreCategory({
      name: "risk handling",
      maxScore: 12,
      checks: [
        check(
          profile.reviewRuleCandidates.length > 0,
          "No review or quality gate rules inferred.",
        ),
        check(
          profile.riskHintPaths.length === 0 ||
            profile.importantDocs.some((repoPath) =>
              /CONTRIBUTING|SECURITY|docs\//i.test(repoPath),
            ) ||
            profile.existingContextFiles.length > 0,
          "Risk-sensitive paths are present without repo-local guidance.",
        ),
        check(
          profile.ownershipHints.length > 0 ||
            profile.importantDocs.some((repoPath) =>
              /CONTRIBUTING|README|docs\//i.test(repoPath),
            ),
          "No ownership or maintainer guidance detected.",
        ),
      ],
      evidence: evidenceFor(profile, [
        ...profile.riskHintPaths,
        ...profile.ownershipHints,
        ...profile.importantDocs,
      ]),
    }),
    scoreCategory({
      name: "generated-file handling",
      maxScore: 12,
      checks: [
        check(profile.ignoreFiles.length > 0, "No ignore file detected."),
        check(
          profile.generatedFilePaths.length === 0 ||
            profile.importantDocs.length > 0 ||
            profile.existingContextFiles.length > 0,
          "Generated files are present without documented handling.",
        ),
        check(
          profile.existingContextFiles.includes(".open-maintainer.yml"),
          ".open-maintainer.yml policy file is missing.",
        ),
      ],
      evidence: evidenceFor(profile, [
        ...profile.ignoreFiles,
        ...profile.generatedFilePaths,
        ...profile.existingContextFiles,
      ]),
    }),
    scoreCategory({
      name: "agent instructions",
      maxScore: 12,
      checks: [
        check(
          profile.existingContextFiles.includes("AGENTS.md") ||
            profile.existingContextFiles.includes("CLAUDE.md"),
          "AGENTS.md or CLAUDE.md is missing.",
        ),
        check(
          profile.existingContextFiles.some(
            (repoPath) =>
              repoPath.startsWith(".agents/skills/") ||
              repoPath.startsWith(".claude/skills/"),
          ),
          "Repo-local skills are missing.",
        ),
      ],
      evidence: evidenceFor(profile, profile.existingContextFiles),
    }),
  ];
  const missingItems = categories.flatMap((category) =>
    category.missing.map((item) => `${category.name}: ${item}`),
  );
  return {
    score: categories.reduce((total, category) => total + category.score, 0),
    categories,
    missingItems,
    generatedAt: nowIso(),
  };
}

function isFilesProfileInput(
  input: RepositoryProfileInput,
): input is Extract<
  RepositoryProfileInput,
  { files: readonly AnalyzerFile[] }
> {
  return typeof input === "object" && "files" in input;
}

async function scanWithCustomDependency(
  scanner: RepositoryProfilerDeps["scanRepository"],
  repoRoot: string,
  options: ScanRepositoryOptions,
): Promise<RepositoryProfileScanResult> {
  const files = await scanner(repoRoot, options);
  const maxFiles = options.maxFiles ?? defaultScanOptions.maxFiles;
  return {
    files,
    source: {
      filesAnalyzed: files.length,
      scannedFromFilesystem: true,
      usedGitVisibleFiles: false,
      truncated: files.length >= maxFiles,
    },
  };
}

function sourceForFileInput(filesAnalyzed: number): RepositoryProfileSource {
  return {
    filesAnalyzed,
    scannedFromFilesystem: false,
    usedGitVisibleFiles: false,
    truncated: false,
  };
}

function inferRepositoryIdentity(repoRoot: string): RepositoryIdentity {
  const absoluteRoot = path.resolve(repoRoot);
  return {
    owner: path.basename(path.dirname(absoluteRoot)) || "local",
    name: path.basename(absoluteRoot) || "repository",
    defaultBranch: "main",
  };
}

function completeRepositoryIdentity(
  identity: RepositoryIdentity,
  repoRoot: string | undefined,
  previousProfile: RepoProfile | undefined,
): Required<RepositoryIdentity> {
  const inferred = repoRoot ? inferRepositoryIdentity(repoRoot) : {};
  return {
    repoId: identity.repoId ?? previousProfile?.repoId ?? "local",
    owner:
      identity.owner ?? previousProfile?.owner ?? inferred.owner ?? "local",
    name:
      identity.name ?? previousProfile?.name ?? inferred.name ?? "repository",
    defaultBranch:
      identity.defaultBranch ??
      previousProfile?.defaultBranch ??
      inferred.defaultBranch ??
      "main",
    version: identity.version ?? (previousProfile?.version ?? 0) + 1,
  };
}

function readinessStatus(
  profile: RepoProfile,
): RepositoryProfileGuidance["summary"]["status"] {
  if (
    profile.agentReadiness.score >= 90 &&
    profile.agentReadiness.missingItems.length === 0
  ) {
    return "ready";
  }

  const riskCategory = profile.agentReadiness.categories.find(
    (category) => category.name === "risk handling",
  );
  if ((riskCategory?.missing.length ?? 0) > 0) {
    return "needs_human_attention";
  }

  return "needs_context";
}

function prioritizeMissingItems(
  missingItems: string[],
  purpose: RepositoryProfilePurpose,
): string[] {
  return [...missingItems]
    .sort(
      (left, right) =>
        missingItemPriority(left, purpose) -
          missingItemPriority(right, purpose) || left.localeCompare(right),
    )
    .slice(0, 5);
}

function missingItemPriority(
  missingItem: string,
  purpose: RepositoryProfilePurpose,
): number {
  const category = missingItem.split(":")[0] ?? "";
  const purposePriorities: Record<RepositoryProfilePurpose, string[]> = {
    workspace: ["setup clarity", "architecture clarity", "testing", "CI"],
    context: [
      "agent instructions",
      "generated-file handling",
      "docs",
      "architecture clarity",
    ],
    review: ["testing", "CI", "risk handling", "generated-file handling"],
    triage: ["setup clarity", "testing", "CI", "docs"],
  };
  const priority = purposePriorities[purpose].indexOf(category);
  return priority === -1 ? purposePriorities[purpose].length : priority;
}

function buildSuggestedActions(
  profile: RepoProfile,
): RepositoryProfileGuidance["suggestedActions"] {
  return profile.agentReadiness.categories.flatMap((category) => {
    if (category.missing.length === 0) {
      return [];
    }
    const kind = actionKindForCategory(category.name);
    return [
      {
        kind,
        title: actionTitleForKind(kind, category.name),
        reason: `${category.name}: ${category.missing.join(" ")}`,
        evidence: category.evidence,
      },
    ];
  });
}

function actionKindForCategory(
  categoryName: RepoProfile["agentReadiness"]["categories"][number]["name"],
): RepositoryProfileGuidance["suggestedActions"][number]["kind"] {
  if (categoryName === "testing") {
    return "testing";
  }
  if (categoryName === "CI") {
    return "ci";
  }
  if (categoryName === "risk handling") {
    return "risk";
  }
  if (categoryName === "generated-file handling") {
    return "generated-files";
  }
  if (categoryName === "docs" || categoryName === "agent instructions") {
    return "docs";
  }
  return "setup";
}

function actionTitleForKind(
  kind: RepositoryProfileGuidance["suggestedActions"][number]["kind"],
  categoryName: string,
): string {
  const titles: Record<
    RepositoryProfileGuidance["suggestedActions"][number]["kind"],
    string
  > = {
    setup: "Clarify repository setup",
    testing: "Define test validation",
    ci: "Add CI validation",
    docs: "Document agent context",
    risk: "Document risk-sensitive paths",
    "generated-files": "Document generated-file handling",
  };
  return titles[kind] ?? `Improve ${categoryName}`;
}

function selectDefaultValidationCommands(
  commands: DetectedCommand[],
  purpose: RepositoryProfilePurpose,
): DetectedCommand[] {
  const priorities =
    purpose === "triage"
      ? ["test", "lint", "check", "typecheck", "build", "smoke"]
      : ["lint", "check", "typecheck", "test", "build", "smoke"];
  const selected: DetectedCommand[] = [];
  for (const priority of priorities) {
    selected.push(
      ...commands.filter((command) => commandMatches(command.name, priority)),
    );
  }
  const deduped = dedupeCommands(selected);
  return deduped.length > 0 ? deduped : commands.slice(0, 5);
}

function commandMatches(commandName: string, priority: string): boolean {
  return commandName === priority || commandName.startsWith(`${priority}:`);
}

function groupCommandsBySurface(
  commands: DetectedCommand[],
): Record<string, DetectedCommand[]> {
  const grouped: Record<string, DetectedCommand[]> = {};
  for (const command of commands) {
    const surface = commandSurface(command.source);
    grouped[surface] = [...(grouped[surface] ?? []), command];
  }
  return grouped;
}

function commandSurface(source: string): string {
  const directory = path.posix.dirname(source);
  if (directory === ".") {
    return "root";
  }
  const [topLevel, second] = directory.split("/");
  if ((topLevel === "apps" || topLevel === "packages") && second) {
    return `${topLevel}/${second}`;
  }
  return topLevel ?? "root";
}

function buildRiskNotes(profile: RepoProfile): string[] {
  const notes = [...profile.detectedRiskAreas];
  if (profile.riskHintPaths.length > 0) {
    notes.push(
      `Risk-sensitive paths detected: ${profile.riskHintPaths.join(", ")}.`,
    );
  }
  if (profile.environmentVariables.length > 0) {
    notes.push(
      `Environment variables detected: ${profile.environmentVariables.join(", ")}.`,
    );
  }
  if (profile.ownershipHints.length === 0) {
    notes.push("No ownership hints detected.");
  }
  if (profile.generatedFilePaths.length > 0) {
    notes.push(
      `Generated files detected: ${profile.generatedFilePaths.join(", ")}.`,
    );
  }
  return dedupeStrings(notes);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeRepoPath(repoPath: string): string {
  return repoPath.split(path.sep).join("/");
}

function shouldReadFile(repoPath: string): boolean {
  if (repoPath.startsWith(".open-maintainer/")) {
    return true;
  }
  if (
    repoPath.startsWith(".github/workflows/") ||
    repoPath.startsWith(".cursor/rules/") ||
    repoPath.startsWith(".agents/skills/") ||
    repoPath.startsWith(".claude/skills/")
  ) {
    return true;
  }
  if (
    /^(README|CONTRIBUTING|CHANGELOG|AGENTS|CLAUDE)(\..*)?$/i.test(
      path.posix.basename(repoPath),
    )
  ) {
    return true;
  }
  if (
    path.posix.basename(repoPath) === ".gitignore" ||
    path.posix.basename(repoPath) === ".open-maintainerignore" ||
    path.posix.basename(repoPath) === ".dockerignore" ||
    detectOwnershipHints([repoPath]).length > 0 ||
    environmentFilePatterns.some((pattern) =>
      pattern.test(path.posix.basename(repoPath)),
    )
  ) {
    return true;
  }
  if (repoPath.startsWith("docs/")) {
    return true;
  }
  if (
    repoPath.endsWith("package.json") ||
    repoPath.endsWith("bun.lock") ||
    repoPath.endsWith("bun.lockb") ||
    repoPath.endsWith("package-lock.json") ||
    repoPath.endsWith("pnpm-lock.yaml") ||
    repoPath.endsWith("yarn.lock") ||
    repoPath.endsWith("go.mod") ||
    repoPath.endsWith("go.sum") ||
    repoPath.endsWith("Cargo.toml") ||
    repoPath.endsWith("Scarb.toml") ||
    repoPath.endsWith("pyproject.toml") ||
    repoPath.endsWith("Makefile")
  ) {
    return true;
  }
  return /\.(ts|tsx|js|jsx|go|py|rs|nr|sol|cairo|json|ya?ml|toml|md)$/.test(
    repoPath,
  );
}

function isQualityOrWorkflowScript(name: string): boolean {
  return [
    "install",
    "dev",
    "test",
    "test:unit",
    "test:integration",
    "test:e2e",
    "build",
    "lint",
    "check",
    "typecheck",
    "format",
    "format:check",
    "diagnostics",
    "smoke",
    "smoke:compose",
    "smoke:mvp",
    "dev-up",
    "dev-down",
    "dev-fork",
    "dev-fork-down",
    "clean-env",
  ].includes(name);
}

function commandForSource(source: string, command: string): string {
  if (source === "package.json") {
    return command;
  }
  return `cd ${path.posix.dirname(source)} && ${command}`;
}

function parseJson(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function fileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function detectMakeTargets(content: string): string[] {
  return [...content.matchAll(/^([a-zA-Z0-9][\w:.-]*):(?:\s|$)/gm)].flatMap(
    (match) => {
      const target = match[1];
      return target && !target.includes("%") ? [target] : [];
    },
  );
}

function detectScarbScripts(content: string): Record<string, string> {
  const scripts: Record<string, string> = {};
  let inScripts = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\[[^\]]+\]\s*$/.test(line)) {
      inScripts = line.trim() === "[scripts]";
      continue;
    }
    if (!inScripts) {
      continue;
    }
    const match = /^([A-Za-z0-9:_-]+)\s*=\s*"([^"]+)"\s*$/.exec(line);
    if (match?.[1] && match[2]) {
      scripts[match[1]] = match[2];
    }
  }
  return scripts;
}

function detectPackageManager(
  lockfiles: string[],
  paths: string[],
): string | null {
  if (
    lockfiles.some(
      (repoPath) =>
        repoPath.endsWith("bun.lock") || repoPath.endsWith("bun.lockb"),
    )
  ) {
    return "bun";
  }
  if (lockfiles.some((repoPath) => repoPath.endsWith("pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (lockfiles.some((repoPath) => repoPath.endsWith("yarn.lock"))) {
    return "yarn";
  }
  if (lockfiles.some((repoPath) => repoPath.endsWith("package-lock.json"))) {
    return "npm";
  }
  if (paths.some((repoPath) => repoPath.endsWith("pyproject.toml"))) {
    return "uv/pip";
  }
  if (paths.some((repoPath) => repoPath.endsWith("go.mod"))) {
    return "go";
  }
  return null;
}

function detectLanguage(repoPath: string): string[] {
  for (const [extension, language] of languageByExtension) {
    if (repoPath.endsWith(extension)) {
      return [language];
    }
  }
  return [];
}

function detectPathGroups(paths: string[]): string[] {
  const groups = new Set<string>();
  for (const repoPath of paths) {
    const [topLevel, second] = repoPath.split("/");
    if (!topLevel) {
      continue;
    }
    if (
      ["apps", "packages", "src", "docs", "contracts", "tests"].includes(
        topLevel,
      )
    ) {
      groups.add(
        second && ["apps", "packages"].includes(topLevel)
          ? `${topLevel}/${second}`
          : topLevel,
      );
    }
  }
  return [...groups].sort();
}

function detectOwnershipHints(paths: string[]): string[] {
  return paths.filter((repoPath) =>
    [
      "CODEOWNERS",
      ".github/CODEOWNERS",
      "OWNERS",
      "OWNERS.md",
      "docs/OWNERS.md",
      "docs/MAINTAINERS.md",
      "MAINTAINERS.md",
    ].includes(repoPath),
  );
}

function detectEnvironmentVariables(files: AnalyzerFile[]): string[] {
  const variables = new Set<string>();
  const patterns = [
    /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g,
    /\bprocess\.env\s*\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
    /\bDeno\.env\.get\(["']([A-Z][A-Z0-9_]*)["']\)/g,
    /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)\b/g,
  ];
  for (const file of files) {
    for (const pattern of patterns) {
      for (const match of file.content.matchAll(pattern)) {
        if (match[1]) {
          variables.add(match[1]);
        }
      }
    }
    for (const variable of detectShellEnvironmentVariables(file.content)) {
      variables.add(variable);
    }
    if (
      environmentFilePatterns.some((pattern) =>
        pattern.test(path.posix.basename(file.path)),
      )
    ) {
      for (const variable of detectEnvironmentFileVariables(file.content)) {
        variables.add(variable);
      }
    }
  }
  return [...variables].sort();
}

function detectEnvironmentFileVariables(content: string): string[] {
  const variables = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
    if (match?.[1]) {
      variables.add(match[1]);
    }
  }
  return [...variables];
}

function detectShellEnvironmentVariables(content: string): string[] {
  const variables = new Set<string>();
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const tokenStart = content.indexOf("${", searchFrom);
    if (tokenStart === -1) {
      break;
    }

    const nameStart = tokenStart + 2;
    if (!isEnvVarNameStart(content.charCodeAt(nameStart))) {
      searchFrom = nameStart;
      continue;
    }

    let nameEnd = nameStart + 1;
    while (
      nameEnd < content.length &&
      isEnvVarNamePart(content.charCodeAt(nameEnd))
    ) {
      nameEnd += 1;
    }

    if (content[nameEnd] === "}") {
      variables.add(content.slice(nameStart, nameEnd));
      searchFrom = nameEnd + 1;
      continue;
    }

    if (
      content[nameEnd] === ":" &&
      ["-", "=", "?"].includes(content[nameEnd + 1] ?? "")
    ) {
      const tokenEnd = content.indexOf("}", nameEnd + 2);
      if (tokenEnd !== -1) {
        variables.add(content.slice(nameStart, nameEnd));
        searchFrom = tokenEnd + 1;
        continue;
      }
    }

    searchFrom = nameEnd + 1;
  }
  return [...variables];
}

function isEnvVarNameStart(charCode: number): boolean {
  return charCode >= 65 && charCode <= 90;
}

function isEnvVarNamePart(charCode: number): boolean {
  return (
    (charCode >= 65 && charCode <= 90) ||
    (charCode >= 48 && charCode <= 57) ||
    charCode === 95
  );
}

function detectGeneratedFilePaths(files: AnalyzerFile[]): string[] {
  return files
    .filter(
      (file) =>
        path.posix.basename(file.path) === "next-env.d.ts" ||
        file.path.includes("/generated/") ||
        /generated by open-maintainer|auto-generated|autogenerated|do not edit/i.test(
          file.content.slice(0, 4000),
        ),
    )
    .map((file) => file.path)
    .sort();
}

function detectTestFilePaths(paths: string[]): string[] {
  return paths
    .filter(
      (repoPath) =>
        /(^|\/)(tests?|__tests__)\//.test(repoPath) ||
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(repoPath),
    )
    .sort();
}

function detectRiskAreas(
  riskHintPaths: string[],
  ciWorkflows: string[],
  existingContextFiles: string[],
): string[] {
  const riskAreas = [];
  if (riskHintPaths.length > 0) {
    riskAreas.push(
      "Authentication, secret, payment, or security-sensitive paths are present.",
    );
  }
  if (ciWorkflows.length === 0) {
    riskAreas.push("No GitHub Actions workflows detected.");
  }
  if (existingContextFiles.length === 0) {
    riskAreas.push("No repo-local agent context files detected.");
  }
  return riskAreas;
}

function detectRiskHintPaths(paths: string[]): string[] {
  return paths.filter(
    (repoPath) =>
      /auth|security|secret|payment|billing/i.test(repoPath) &&
      detectTestFilePaths([repoPath]).length === 0,
  );
}

function buildRuleCandidates(
  commands: DetectedCommand[],
  packageManager: string | null,
): string[] {
  const rules = [];
  if (packageManager) {
    rules.push(`Use ${packageManager} for dependency and script commands.`);
  }
  for (const command of dedupeCommands(commands)) {
    if (
      ["test", "lint", "check", "typecheck", "build"].includes(command.name)
    ) {
      rules.push(
        `Run \`${command.command}\` before finishing changes that affect ${command.name}.`,
      );
    }
  }
  return rules;
}

function dedupeCommands(commands: DetectedCommand[]): DetectedCommand[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = `${command.name}:${command.command}:${command.source}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeEvidence(evidence: EvidenceReference[]): EvidenceReference[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.path}:${item.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function check(
  passed: boolean,
  missing: string,
): { passed: boolean; missing: string } {
  return { passed, missing };
}

function scoreCategory(input: {
  name: RepoProfile["agentReadiness"]["categories"][number]["name"];
  maxScore: number;
  checks: Array<{ passed: boolean; missing: string }>;
  evidence: EvidenceReference[];
}): RepoProfile["agentReadiness"]["categories"][number] {
  const passed = input.checks.filter((item) => item.passed).length;
  return {
    name: input.name,
    score: Math.round((passed / input.checks.length) * input.maxScore),
    maxScore: input.maxScore,
    missing: input.checks
      .filter((item) => !item.passed)
      .map((item) => item.missing),
    evidence: input.evidence,
  };
}

function evidenceFor(
  profile: Pick<RepoProfile, "evidence">,
  paths: string[],
): EvidenceReference[] {
  const pathSet = new Set(paths);
  return profile.evidence.filter(
    (item) =>
      pathSet.has(item.path) ||
      paths.some((repoPath) => item.path.startsWith(`${repoPath}/`)),
  );
}

function hasCommand(commands: DetectedCommand[], name: string): boolean {
  return commands.some(
    (command) => command.name === name || command.name.startsWith(`${name}:`),
  );
}
