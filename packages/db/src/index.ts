import type {
  ContextPr,
  GeneratedArtifact,
  Installation,
  ModelProviderConfig,
  Repo,
  RepoProfile,
  ReviewFeedback,
  ReviewResult,
  RunRecord,
} from "@open-maintainer/shared";
import { newId, nowIso } from "@open-maintainer/shared";
import Redis from "ioredis";
import pg from "pg";

export type RepositoryFile = {
  path: string;
  content: string;
};

export class MemoryStore {
  installations = new Map<string, Installation>();
  repos = new Map<string, Repo>();
  repoFiles = new Map<string, RepositoryFile[]>();
  repoWorktrees = new Map<string, string>();
  profiles = new Map<string, RepoProfile[]>();
  providers = new Map<string, ModelProviderConfig>();
  artifacts = new Map<string, GeneratedArtifact[]>();
  reviews = new Map<string, ReviewResult>();
  runs = new Map<string, RunRecord>();
  contextPrs = new Map<string, ContextPr>();
  workerHeartbeatAt: string | null = null;

  constructor() {
    const createdAt = nowIso();
    const installation: Installation = {
      id: "installation_demo",
      accountLogin: "demo-org",
      accountType: "Organization",
      repositorySelection: "selected",
      permissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
      createdAt,
    };
    const repo: Repo = {
      id: "repo_demo",
      installationId: installation.id,
      owner: "demo-org",
      name: "demo-repo",
      fullName: "demo-org/demo-repo",
      defaultBranch: "main",
      private: false,
      permissions: { contents: true, metadata: true, pull_requests: true },
    };
    this.installations.set(installation.id, installation);
    this.repos.set(repo.id, repo);
    this.repoFiles.set(repo.id, [
      { path: "README.md", content: "# Demo Repo\n\nA TypeScript service." },
      {
        path: "package.json",
        content: JSON.stringify({
          scripts: { test: "bun test", build: "tsc -b", lint: "biome check ." },
          dependencies: { fastify: "latest", next: "latest" },
        }),
      },
      { path: "bun.lock", content: "" },
      {
        path: ".github/workflows/ci.yml",
        content: "name: CI\non: [push]\njobs: {}\n",
      },
    ]);
  }

  recordRun(
    input: Omit<RunRecord, "id" | "createdAt" | "updatedAt">,
  ): RunRecord {
    const timestamp = nowIso();
    const run: RunRecord = {
      ...input,
      id: newId("run"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.runs.set(run.id, run);
    return run;
  }

  updateRun(id: string, patch: Partial<RunRecord>): RunRecord {
    const current = this.runs.get(id);
    if (!current) {
      throw new Error(`Unknown run: ${id}`);
    }
    const updated = { ...current, ...patch, updatedAt: nowIso() };
    this.runs.set(id, updated);
    return updated;
  }

  addProfile(profile: RepoProfile): RepoProfile {
    const existing = this.profiles.get(profile.repoId) ?? [];
    this.profiles.set(profile.repoId, [...existing, profile]);
    return profile;
  }

  latestProfile(repoId: string): RepoProfile | null {
    const profiles = this.profiles.get(repoId) ?? [];
    return profiles.at(-1) ?? null;
  }

  addArtifact(artifact: GeneratedArtifact): GeneratedArtifact {
    const existing = this.artifacts.get(artifact.repoId) ?? [];
    this.artifacts.set(artifact.repoId, [...existing, artifact]);
    return artifact;
  }

  listRuns(repoId: string): RunRecord[] {
    return [...this.runs.values()].filter(
      (run) => run.repoId === repoId || run.repoId === null,
    );
  }

  listReviews(repoId: string): ReviewResult[] {
    return [...this.reviews.values()].filter(
      (review) => review.repoId === repoId,
    );
  }

  addReviewFeedback(reviewId: string, feedback: ReviewFeedback): ReviewResult {
    const review = this.reviews.get(reviewId);
    if (!review) {
      throw new Error(`Unknown review: ${reviewId}`);
    }
    const updated = { ...review, feedback: [...review.feedback, feedback] };
    this.reviews.set(reviewId, updated);
    return updated;
  }
}

export const store = new MemoryStore();

export async function checkDatabase(
  databaseUrl = process.env["DATABASE_URL"],
): Promise<"ok" | "error"> {
  if (!databaseUrl) {
    return "ok";
  }
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1000,
  });
  try {
    await client.connect();
    await client.query("select 1");
    return "ok";
  } catch {
    return "error";
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function checkRedis(
  redisUrl = process.env["REDIS_URL"],
): Promise<"ok" | "error"> {
  if (!redisUrl) {
    return "ok";
  }
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1000,
  });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    await redis.ping();
    return "ok";
  } catch {
    return "error";
  } finally {
    redis.disconnect();
  }
}
