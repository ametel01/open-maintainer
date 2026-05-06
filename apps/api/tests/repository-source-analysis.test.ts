import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MemoryStore } from "@open-maintainer/db";
import type { Repo } from "@open-maintainer/shared";
import { newId, nowIso } from "@open-maintainer/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositorySourceLifecycle } from "../src/repository-source-analysis";

const execFileAsync = promisify(execFile);

const previousRepositoryCache = process.env["OPEN_MAINTAINER_LOCAL_REPO_CACHE"];
const previousMountedRoots =
  process.env["OPEN_MAINTAINER_DASHBOARD_REPO_ROOTS"];

afterEach(() => {
  restoreEnv("OPEN_MAINTAINER_LOCAL_REPO_CACHE", previousRepositoryCache);
  restoreEnv("OPEN_MAINTAINER_DASHBOARD_REPO_ROOTS", previousMountedRoots);
});

describe("repository source lifecycle", () => {
  it("registers local worktrees and invalidates derived state", async () => {
    const store = new MemoryStore();
    const lifecycle = createRepositorySourceLifecycle({ store });
    const repoRoot = await createGitRepository("local-worktree-tool", {
      branch: "main",
      files: {
        "package.json": JSON.stringify({
          name: "local-worktree-tool",
          scripts: { test: "bun test" },
        }),
        "src/index.ts": "export const ok = true;\n",
      },
    });

    try {
      const registered = await lifecycle.register({
        kind: "local-worktree",
        repoRoot,
        owner: "local",
      });
      expect(registered.ok).toBe(true);
      if (!registered.ok) {
        return;
      }
      expect(registered.value.repo.id).toBe("local_local_local_worktree_tool");
      expect(registered.value.fileCount).toBeGreaterThan(0);
      expect(registered.value.source).toBe("local-worktree");
      expect(registered.value.worktreeRoot).toBe(repoRoot);
      expect(registered.value.repo.defaultBranch).toBe("main");
      expect(store.repoFiles.get(registered.value.repo.id)?.[0]?.path).toBe(
        "package.json",
      );

      const analysis = await lifecycle.prepare({
        repoId: registered.value.repo.id,
        intent: { kind: "analyze", profile: "refresh" },
      });
      expect(analysis.ok).toBe(true);
      if (!analysis.ok) {
        return;
      }
      store.addArtifact({
        id: newId("artifact"),
        repoId: registered.value.repo.id,
        type: "AGENTS.md",
        version: 1,
        content: "# stale\n",
        sourceProfileVersion: analysis.value.profile.version,
        modelProvider: null,
        model: null,
        createdAt: nowIso(),
      });

      const registeredAgain = await lifecycle.register({
        kind: "local-worktree",
        repoRoot,
        owner: "local",
      });
      expect(registeredAgain.ok).toBe(true);
      expect(store.profiles.get(registered.value.repo.id)).toBeUndefined();
      expect(store.artifacts.get(registered.value.repo.id)).toBeUndefined();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("normalizes uploaded files and materializes the fallback worktree", async () => {
    const store = new MemoryStore();
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "rsa-cache-"));
    process.env["OPEN_MAINTAINER_LOCAL_REPO_CACHE"] = cacheRoot;
    const lifecycle = createRepositorySourceLifecycle({ store });

    try {
      const registered = await lifecycle.register({
        kind: "uploaded-files",
        name: "uploaded-tool",
        files: [
          { path: "/package.json", content: '{"name":"uploaded-tool"}' },
          { path: "src\\index.ts", content: "export const ok = true;\n" },
          { path: "../secret.txt", content: "nope" },
        ],
      });

      expect(registered.ok).toBe(true);
      if (!registered.ok) {
        return;
      }
      expect(registered.value.repo.id).toBe("local_local_uploaded_tool");
      expect(registered.value.fileCount).toBe(2);
      expect(registered.value.source).toBe("uploaded-files");
      expect(registered.value.worktreeRoot).toBe(
        path.join(cacheRoot, registered.value.repo.id),
      );
      expect(
        store.repoFiles.get(registered.value.repo.id)?.map((file) => file.path),
      ).toEqual(["package.json", "src/index.ts"]);
      await expect(
        readFile(
          path.join(registered.value.worktreeRoot ?? "", "src/index.ts"),
          "utf8",
        ),
      ).resolves.toBe("export const ok = true;\n");
      await expect(
        readFile(path.join(cacheRoot, "secret.txt"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("uses injectable materialization and mounted-worktree ports", async () => {
    const store = new MemoryStore();
    const materialized: Array<{ repoId: string; paths: string[] }> = [];
    const lifecycle = createRepositorySourceLifecycle({
      store,
      mountedWorktrees: async () => null,
      materializeFiles: async ({ repoId, files }) => {
        materialized.push({
          repoId,
          paths: files.map((file) => file.path),
        });
        return `/virtual-cache/${repoId}`;
      },
    });

    const registered = await lifecycle.register({
      kind: "uploaded-files",
      name: "virtual-tool",
      files: [
        { path: "/package.json", content: '{"name":"virtual-tool"}' },
        { path: "../secret.txt", content: "nope" },
      ],
    });

    expect(registered.ok).toBe(true);
    if (!registered.ok) {
      return;
    }
    expect(registered.value.worktreeRoot).toBe(
      "/virtual-cache/local_local_virtual_tool",
    );
    expect(materialized).toEqual([
      {
        repoId: "local_local_virtual_tool",
        paths: ["package.json"],
      },
    ]);
  });

  it("uses a mounted worktree when browser uploads match it", async () => {
    const store = new MemoryStore();
    const repoRoot = await createGitRepository("mounted-dashboard-tool", {
      branch: "feature/context-base",
      files: {
        "package.json": JSON.stringify({
          name: "mounted-dashboard-tool",
          scripts: { test: "bun test" },
        }),
        "src/index.ts": "export const mounted = true;\n",
      },
    });
    process.env["OPEN_MAINTAINER_DASHBOARD_REPO_ROOTS"] = repoRoot;
    const lifecycle = createRepositorySourceLifecycle({ store });

    try {
      const registered = await lifecycle.register({
        kind: "uploaded-files",
        name: "mounted-dashboard-tool",
        files: [
          {
            path: "package.json",
            content: JSON.stringify({ name: "mounted-dashboard-tool" }),
          },
        ],
      });

      expect(registered.ok).toBe(true);
      if (!registered.ok) {
        return;
      }
      expect(registered.value.source).toBe("uploaded-files-mounted-worktree");
      expect(registered.value.worktreeRoot).toBe(repoRoot);
      expect(registered.value.repo.defaultBranch).toBe("feature/context-base");
      expect(store.repoFiles.get(registered.value.repo.id)).toContainEqual({
        path: "src/index.ts",
        content: "export const mounted = true;\n",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("tracks analysis runs, profile versions, and lazy profile reuse", async () => {
    const store = new MemoryStore();
    const lifecycle = createRepositorySourceLifecycle({ store });
    const registered = await lifecycle.register({
      kind: "uploaded-files",
      name: "profile-tool",
      files: [
        {
          path: "package.json",
          content: JSON.stringify({
            name: "profile-tool",
            dependencies: { fastify: "latest" },
          }),
        },
      ],
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) {
      return;
    }

    const firstAnalysis = await lifecycle.prepare({
      repoId: registered.value.repo.id,
      intent: { kind: "analyze", profile: "refresh" },
    });
    expect(firstAnalysis.ok).toBe(true);
    if (!firstAnalysis.ok) {
      return;
    }
    expect(firstAnalysis.value.run?.status).toBe("succeeded");
    expect(firstAnalysis.value.run?.repoProfileVersion).toBe(1);
    expect(firstAnalysis.value.profile.frameworks).toContain("fastify");

    const runsBeforeReuse = store.listRuns(registered.value.repo.id).length;
    const reusedWorkspace = await lifecycle.prepare({
      repoId: registered.value.repo.id,
      intent: { kind: "analyze", profile: "reuse-or-create" },
    });
    expect(reusedWorkspace.ok).toBe(true);
    if (!reusedWorkspace.ok) {
      return;
    }
    expect(reusedWorkspace.value.profileCreated).toBe(false);
    expect(reusedWorkspace.value.run).toBeNull();
    expect(reusedWorkspace.value.files[0]?.path).toBe("package.json");
    expect(store.listRuns(registered.value.repo.id)).toHaveLength(
      runsBeforeReuse,
    );

    const refreshedWorkspace = await lifecycle.prepare({
      repoId: registered.value.repo.id,
      intent: { kind: "analyze", profile: "refresh" },
    });
    expect(refreshedWorkspace.ok).toBe(true);
    if (!refreshedWorkspace.ok) {
      return;
    }
    expect(refreshedWorkspace.value.profileCreated).toBe(true);
    expect(refreshedWorkspace.value.profile.version).toBe(2);
    expect(refreshedWorkspace.value.run?.safeMessage).toBe(
      "Repository profile generated.",
    );
  });

  it("prepares generation, review, and context PR workspaces by intent", async () => {
    const store = new MemoryStore();
    const lifecycle = createRepositorySourceLifecycle({ store });
    const repoRoot = await createGitRepository("workspace-tool", {
      branch: "main",
      files: {
        "package.json": JSON.stringify({
          name: "workspace-tool",
          scripts: { test: "bun test" },
        }),
      },
    });

    try {
      const registered = await lifecycle.register({
        kind: "local-worktree",
        repoRoot,
        owner: "local",
      });
      expect(registered.ok).toBe(true);
      if (!registered.ok) {
        return;
      }

      const missingGeneration = await lifecycle.prepare({
        repoId: registered.value.repo.id,
        intent: { kind: "generate-context" },
      });
      expect(missingGeneration.ok).toBe(false);
      if (!missingGeneration.ok) {
        expect(missingGeneration.error.code).toBe("NO_PROFILE");
      }

      const analysis = await lifecycle.prepare({
        repoId: registered.value.repo.id,
        intent: { kind: "analyze", profile: "refresh" },
      });
      expect(analysis.ok).toBe(true);
      if (!analysis.ok) {
        return;
      }
      const generation = await lifecycle.prepare({
        repoId: registered.value.repo.id,
        intent: { kind: "generate-context" },
      });
      expect(generation.ok).toBe(true);
      if (!generation.ok) {
        return;
      }
      expect(generation.value.profile.version).toBe(
        analysis.value.profile.version,
      );
      expect(generation.value.files.map((file) => file.path)).toEqual([
        "package.json",
      ]);
      expect(generation.value.worktreeRoot).toBe(repoRoot);

      const review = await lifecycle.prepare({
        repoId: registered.value.repo.id,
        intent: { kind: "review-preview" },
      });
      expect(review.ok).toBe(true);
      if (!review.ok) {
        return;
      }
      expect(review.value.profileCreated).toBe(false);
      expect(review.value.worktreeRoot).toBe(repoRoot);

      const contextPr = await lifecycle.prepare({
        repoId: registered.value.repo.id,
        intent: { kind: "context-pr", requireWritableWorktree: true },
      });
      expect(contextPr.ok).toBe(true);
      if (!contextPr.ok) {
        return;
      }
      expect(contextPr.value.worktreeRoot).toBe(repoRoot);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports a domain error when context PR preparation requires a missing worktree", async () => {
    const store = new MemoryStore();
    const repo = remoteRepo("remote_context");
    store.repos.set(repo.id, repo);
    store.repoFiles.set(repo.id, [
      {
        path: "package.json",
        content: JSON.stringify({ scripts: { test: "bun test" } }),
      },
    ]);
    const lifecycle = createRepositorySourceLifecycle({ store });

    const analysis = await lifecycle.prepare({
      repoId: repo.id,
      intent: { kind: "analyze", profile: "refresh" },
    });
    expect(analysis.ok).toBe(true);
    if (!analysis.ok) {
      return;
    }

    const contextPr = await lifecycle.prepare({
      repoId: repo.id,
      intent: { kind: "context-pr", requireWritableWorktree: true },
    });
    expect(contextPr.ok).toBe(false);
    if (!contextPr.ok) {
      expect(contextPr.error.statusCode).toBe(409);
      expect(contextPr.error.code).toBe("WORKTREE_UNAVAILABLE");
    }
  });

  it("returns domain errors for unknown and unavailable repositories", async () => {
    const store = new MemoryStore();
    const lifecycle = createRepositorySourceLifecycle({ store });

    const unknown = await lifecycle.prepare({
      repoId: "missing",
      intent: { kind: "analyze", profile: "refresh" },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.statusCode).toBe(404);
      expect(unknown.error.code).toBe("UNKNOWN_REPO");
    }

    const repo = remoteRepo("remote_unseeded");
    store.repos.set(repo.id, repo);
    const unavailable = await lifecycle.prepare({
      repoId: repo.id,
      intent: { kind: "analyze", profile: "refresh" },
    });
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.error.statusCode).toBe(409);
      expect(unavailable.error.code).toBe("REPOSITORY_FILES_UNAVAILABLE");
      expect(unavailable.error.run?.status).toBe("failed");
    }
  });

  it("fetches GitHub App files, caches them, and creates missing profiles", async () => {
    const store = new MemoryStore();
    const repo = remoteRepo("remote_seeded");
    store.repos.set(repo.id, repo);
    const lifecycle = createRepositorySourceLifecycle({
      store,
      getInstallationAuth: () => ({
        appId: "1",
        installationId: repo.installationId,
        privateKey: "fake",
      }),
      fetchRepositoryFiles: async (input) => {
        expect(input.owner).toBe("remote");
        expect(input.repo).toBe("seeded");
        expect(input.ref).toBe("feature/base");
        return {
          files: [
            {
              path: "package.json",
              content: JSON.stringify({ dependencies: { next: "latest" } }),
            },
          ],
        };
      },
    });

    const prepared = await lifecycle.prepare({
      repoId: repo.id,
      intent: {
        kind: "review-preview",
        baseRef: "feature/base",
      },
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(prepared.value.profileCreated).toBe(true);
    expect(prepared.value.run?.status).toBe("succeeded");
    expect(prepared.value.source).toBe("github-app");
    expect(prepared.value.profile.frameworks).toContain("next");
    expect(store.repoFiles.get(repo.id)?.[0]?.path).toBe("package.json");
  });
});

async function createGitRepository(
  name: string,
  input: { branch: string; files: Record<string, string> },
): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "rsa-repo-"));
  const repoRoot = path.join(parent, name);
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["init", "-b", input.branch], { cwd: repoRoot });
  for (const [repoPath, content] of Object.entries(input.files)) {
    const destination = path.join(repoRoot, repoPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Open Maintainer",
      "commit",
      "-m",
      "Initial commit",
    ],
    { cwd: repoRoot },
  );
  return repoRoot;
}

function remoteRepo(id: string): Repo {
  return {
    id,
    installationId: "installation_remote",
    owner: "remote",
    name: id.replace("remote_", ""),
    fullName: `remote/${id.replace("remote_", "")}`,
    defaultBranch: "main",
    private: false,
    permissions: { contents: true, metadata: true, pull_requests: true },
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}
