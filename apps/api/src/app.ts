import path from "node:path";
import cors from "@fastify/cors";
import formBody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import {
  assertProviderConsent,
  assertProviderExecutableAvailable,
  buildProvider,
  createProviderConfig,
} from "@open-maintainer/ai";
import { createContextGenerationOrchestrator } from "@open-maintainer/context";
import { checkDatabase, checkRedis, store } from "@open-maintainer/db";
import {
  mapInstallationEvent,
  verifyWebhookSignature,
} from "@open-maintainer/github";
import type { GitHubAppInstallationAuth } from "@open-maintainer/github";
import {
  type GeneratedArtifact,
  type ModelProviderConfig,
  type RepoProfile,
  RepositoryUploadRequestSchema,
  ReviewFeedbackSchema,
  newId,
  nowIso,
} from "@open-maintainer/shared";
import Fastify from "fastify";
import { z } from "zod";
import { createDashboardContextPrService } from "./context-pr-service";
import { createRepositorySourceLifecycle } from "./repository-source-analysis";
import { createDashboardReviewService } from "./review-service";

const sensitiveRouteRateLimit = {
  max: 10,
  timeWindow: "1 minute",
} as const;

export function buildApp() {
  const app = Fastify({ logger: false });
  const repositorySources = createRepositorySourceLifecycle({
    store,
    getInstallationAuth: githubAuthForInstallation,
  });
  const contextPrService = createDashboardContextPrService({
    store,
    repositorySources,
    getInstallationAuth: githubAuthForInstallation,
  });
  const reviewService = createDashboardReviewService({
    store,
    repositorySources,
    getInstallationAuth: githubAuthForInstallation,
  });
  app.register(cors, { origin: true });
  app.register(formBody);

  app.get("/health", async () => {
    const [database, redis] = await Promise.all([
      checkDatabase(),
      checkRedis(),
    ]);
    const worker = store.workerHeartbeatAt ? "ok" : "missing";
    return {
      status: database === "ok" && redis === "ok" ? "ok" : "degraded",
      api: "ok",
      database,
      redis,
      worker,
      workerHeartbeatAt: store.workerHeartbeatAt,
      checkedAt: nowIso(),
    };
  });

  app.post("/worker/heartbeat", async () => {
    store.workerHeartbeatAt = nowIso();
    return { ok: true, workerHeartbeatAt: store.workerHeartbeatAt };
  });

  app.get("/installations", async () => ({
    installations: [...store.installations.values()],
  }));
  app.get("/repos", async () => ({ repos: [...store.repos.values()] }));

  app.register(async (limitedRoutes) => {
    await limitedRoutes.register(rateLimit, { global: false });

    limitedRoutes.post(
      "/repos/local",
      { config: { rateLimit: sensitiveRouteRateLimit } },
      async (request, reply) => {
        const body = z
          .object({ repoRoot: z.string().min(1).max(500) })
          .parse(request.body ?? {});
        const result = await repositorySources.register({
          kind: "local-worktree",
          repoRoot: path.resolve(body.repoRoot),
        });
        if (!result.ok) {
          return reply
            .code(result.error.statusCode)
            .send({ error: result.error.message });
        }
        return { repo: result.value.repo, files: result.value.fileCount };
      },
    );

    limitedRoutes.post(
      "/repos/local-files",
      { config: { rateLimit: sensitiveRouteRateLimit } },
      async (request, reply) => {
        const body = RepositoryUploadRequestSchema.parse(request.body ?? {});
        const result = await repositorySources.register({
          kind: "uploaded-files",
          files: body.files,
          ...(body.name ? { name: body.name } : {}),
        });
        if (!result.ok) {
          return reply
            .code(result.error.statusCode)
            .send({ error: result.error.message });
        }
        return { repo: result.value.repo, files: result.value.fileCount };
      },
    );
  });

  app.post("/github/settings", async (request) => {
    const body = z
      .object({
        appId: z.string().min(1),
        clientId: z.string().min(1),
        privateKeyBase64: z.string().min(1),
        webhookSecret: z.string().min(1),
      })
      .parse(request.body);
    return {
      ok: true,
      appId: body.appId,
      clientId: body.clientId,
      privateKeyConfigured: true,
      webhookSecretConfigured: true,
    };
  });

  app.post("/github/webhook", async (request, reply) => {
    const payload =
      typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body ?? {});
    const signature256 = request.headers["x-hub-signature-256"];
    const secret = process.env.GITHUB_WEBHOOK_SECRET || "dev-webhook-secret";
    if (
      typeof signature256 !== "string" ||
      !verifyWebhookSignature({ secret, payload, signature256 })
    ) {
      return reply
        .code(401)
        .send({ error: "Invalid GitHub webhook signature." });
    }

    const event = mapInstallationEvent(JSON.parse(payload));
    store.installations.set(event.installation.id, event.installation);
    for (const repo of event.repos) {
      store.repos.set(repo.id, repo);
    }
    store.recordRun({
      repoId: null,
      type: "webhook",
      status: "succeeded",
      inputSummary: `GitHub installation webhook for ${event.installation.accountLogin}`,
      safeMessage: null,
      artifactVersions: [],
      repoProfileVersion: null,
      provider: null,
      model: null,
      externalId: event.installation.id,
    });
    return { ok: true, installation: event.installation, repos: event.repos };
  });

  app.register(async (limitedRoutes) => {
    await limitedRoutes.register(rateLimit, { global: false });

    limitedRoutes.post(
      "/repos/:repoId/analyze",
      { config: { rateLimit: sensitiveRouteRateLimit } },
      async (request, reply) => {
        const { repoId } = z
          .object({ repoId: z.string() })
          .parse(request.params);
        const result = await repositorySources.prepare({
          repoId,
          intent: { kind: "analyze", profile: "refresh" },
        });
        if (!result.ok) {
          return reply.code(result.error.statusCode).send({
            error: result.error.message,
            ...(result.error.run ? { run: result.error.run } : {}),
          });
        }
        return { run: result.value.run, profile: result.value.profile };
      },
    );
  });

  app.get("/repos/:repoId/profile", async (request, reply) => {
    const { repoId } = z.object({ repoId: z.string() }).parse(request.params);
    const profile = store.latestProfile(repoId);
    if (!profile) {
      return reply.code(404).send({ error: "No profile has been generated." });
    }
    return { profile };
  });

  app.post("/model-providers", async (request, reply) => {
    const body = z
      .object({
        kind: z.enum([
          "openai-compatible",
          "anthropic",
          "local-openai-compatible",
          "codex-cli",
          "claude-cli",
        ]),
        displayName: z.string(),
        baseUrl: z.string().url(),
        model: z.string(),
        apiKey: z.string(),
        repoContentConsent: z.boolean(),
      })
      .parse(request.body);
    const provider = createProviderConfig(body);
    try {
      await assertProviderExecutableAvailable(provider);
    } catch (error) {
      return reply.code(422).send({
        error:
          error instanceof Error
            ? error.message
            : "Selected provider executable is unavailable.",
      });
    }
    store.providers.set(provider.id, provider);
    return { provider: { ...provider, encryptedApiKey: "[redacted]" } };
  });

  app.get("/model-providers", async () => ({
    providers: [...store.providers.values()].map((provider) => ({
      ...provider,
      encryptedApiKey: "[redacted]",
    })),
  }));

  app.post("/model-providers/test", async () => ({
    ok: true,
    prompt: "Connectivity test uses a harmless non-repo prompt.",
  }));

  app.post("/repos/:repoId/generate-context", async (request, reply) => {
    const { repoId } = z.object({ repoId: z.string() }).parse(request.params);
    const body = z
      .object({
        providerId: z.string().optional(),
        context: z.enum(["codex", "claude", "both"]).optional(),
        skills: z.enum(["codex", "claude", "both"]).optional(),
        async: z.boolean().optional(),
      })
      .parse(request.body ?? {});
    const workspace = await repositorySources.prepare({
      repoId,
      intent: { kind: "generate-context" },
    });
    if (!workspace.ok) {
      return reply
        .code(workspace.error.statusCode)
        .send({ error: workspace.error.message });
    }
    const { profile } = workspace.value;
    const provider = body.providerId
      ? (store.providers.get(body.providerId) ?? null)
      : ([...store.providers.values()][0] ?? null);
    if (body.providerId && !provider) {
      return reply.code(404).send({ error: "Unknown model provider." });
    }
    if (!provider) {
      const run = store.recordRun({
        repoId,
        type: "generation",
        status: "failed",
        inputSummary: "Context generation blocked before provider call.",
        safeMessage:
          "Context generation requires an explicit model provider with repo-content consent.",
        artifactVersions: [],
        repoProfileVersion: profile.version,
        provider: null,
        model: null,
        externalId: null,
      });
      return reply.code(403).send({ error: run.safeMessage, run });
    }
    try {
      assertProviderConsent(provider);
    } catch (error) {
      const run = store.recordRun({
        repoId,
        type: "generation",
        status: "failed",
        inputSummary: "Context generation blocked before provider call.",
        safeMessage:
          error instanceof Error ? error.message : "Generation blocked.",
        artifactVersions: [],
        repoProfileVersion: profile.version,
        provider: null,
        model: null,
        externalId: null,
      });
      return reply.code(403).send({ error: run.safeMessage, run });
    }
    try {
      await assertProviderExecutableAvailable(provider);
    } catch (error) {
      const run = store.recordRun({
        repoId,
        type: "generation",
        status: "failed",
        inputSummary: "Context generation blocked before provider call.",
        safeMessage:
          error instanceof Error
            ? `Selected provider executable is unavailable: ${error.message}`
            : "Selected provider executable is unavailable.",
        artifactVersions: [],
        repoProfileVersion: profile.version,
        provider: provider.displayName,
        model: provider.model,
        externalId: null,
      });
      return reply.code(422).send({ error: run.safeMessage, run });
    }

    const run = store.recordRun({
      repoId,
      type: "generation",
      status: "running",
      inputSummary: `Generate AGENTS.md and .open-maintainer.yml from profile v${profile.version}.`,
      safeMessage: null,
      artifactVersions: [],
      repoProfileVersion: profile.version,
      provider: provider?.displayName ?? null,
      model: provider?.model ?? null,
      externalId: null,
    });

    if (body.async) {
      void generateContextArtifactsForRun({
        repoId,
        profile,
        files: workspace.value.files,
        worktreeRoot: workspace.value.worktreeRoot,
        provider,
        runId: run.id,
        context: body.context,
        skills: body.skills,
      }).catch(() => undefined);
      return reply.code(202).send({
        accepted: true,
        run: store.runs.get(run.id),
      });
    }

    try {
      const artifacts = await generateContextArtifactsForRun({
        repoId,
        profile,
        files: workspace.value.files,
        worktreeRoot: workspace.value.worktreeRoot,
        provider,
        runId: run.id,
        context: body.context,
        skills: body.skills,
      });
      return { run: store.runs.get(run.id), artifacts };
    } catch {
      return reply.code(502).send({
        error: store.runs.get(run.id)?.safeMessage,
        run: store.runs.get(run.id),
      });
    }
  });

  app.get("/repos/:repoId/artifacts", async (request) => {
    const { repoId } = z.object({ repoId: z.string() }).parse(request.params);
    return { artifacts: store.artifacts.get(repoId) ?? [] };
  });

  app.post("/repos/:repoId/reviews", async (request, reply) => {
    const { repoId } = z.object({ repoId: z.string() }).parse(request.params);
    const body = z
      .object({
        baseRef: z.string().min(1).optional(),
        headRef: z.string().min(1).optional(),
        prNumber: z.number().int().positive().optional(),
        providerId: z.string().optional(),
      })
      .parse(request.body ?? {});
    const result = await reviewService.preview({
      repoId,
      ...(body.baseRef ? { baseRef: body.baseRef } : {}),
      ...(body.headRef ? { headRef: body.headRef } : {}),
      ...(body.prNumber ? { prNumber: body.prNumber } : {}),
      ...(body.providerId ? { providerId: body.providerId } : {}),
    });
    if (!result.ok) {
      return reply.code(result.statusCode).send({
        error: result.error,
        run: result.run,
      });
    }
    return { run: result.run, review: result.review };
  });

  app.get("/repos/:repoId/reviews", async (request) => {
    const { repoId } = z.object({ repoId: z.string() }).parse(request.params);
    return { reviews: store.listReviews(repoId) };
  });

  app.get("/reviews/:reviewId", async (request, reply) => {
    const { reviewId } = z
      .object({ reviewId: z.string() })
      .parse(request.params);
    const review = store.reviews.get(reviewId);
    if (!review) {
      return reply.code(404).send({ error: "Unknown review." });
    }
    return { review };
  });

  app.post("/reviews/:reviewId/feedback", async (request, reply) => {
    const { reviewId } = z
      .object({ reviewId: z.string() })
      .parse(request.params);
    const body = z
      .object({
        findingId: z.string().min(1),
        verdict: ReviewFeedbackSchema.shape.verdict,
        reason: z.string().trim().min(1).nullable().optional(),
        actor: z.string().trim().min(1).nullable().optional(),
      })
      .parse(request.body ?? {});
    const review = store.reviews.get(reviewId);
    if (!review) {
      return reply.code(404).send({ error: "Unknown review." });
    }
    const finding = review.findings.find((item) => item.id === body.findingId);
    if (!finding) {
      return reply.code(422).send({
        error: "Unknown finding ID for review.",
      });
    }
    const feedback = ReviewFeedbackSchema.parse({
      findingId: finding.id,
      verdict: body.verdict,
      reason: body.reason ?? null,
      actor: body.actor ?? null,
      createdAt: nowIso(),
    });
    const updatedReview = store.addReviewFeedback(review.id, feedback);
    return { feedback, review: updatedReview };
  });

  app.post("/reviews/:reviewId/post-summary", async (request, reply) => {
    const { reviewId } = z
      .object({ reviewId: z.string() })
      .parse(request.params);
    const review = store.reviews.get(reviewId);
    if (!review) {
      return reply.code(404).send({ error: "Unknown review." });
    }
    return reply.code(409).send({
      error:
        "Posting review summaries requires GitHub credentials and pull request permissions.",
    });
  });

  app.register(async (limitedRoutes) => {
    await limitedRoutes.register(rateLimit, { global: false });

    limitedRoutes.post(
      "/repos/:repoId/open-context-pr",
      { config: { rateLimit: sensitiveRouteRateLimit } },
      async (request, reply) => {
        const { repoId } = z
          .object({ repoId: z.string() })
          .parse(request.params);
        const result = await contextPrService.open({ repoId });
        if (!result.ok) {
          return reply
            .code(result.statusCode)
            .send({ error: result.message, run: result.run });
        }
        return { run: result.run, contextPr: result.contextPr };
      },
    );
  });

  app.get("/repos/:repoId/runs", async (request) => {
    const { repoId } = z.object({ repoId: z.string() }).parse(request.params);
    return { runs: store.listRuns(repoId) };
  });

  app.get("/runs/:runId", async (request, reply) => {
    const { runId } = z.object({ runId: z.string() }).parse(request.params);
    const run = store.runs.get(runId);
    if (!run) {
      return reply.code(404).send({ error: "Unknown run." });
    }
    return { run };
  });

  app.post("/runs/:runId/retry", async (request, reply) => {
    const { runId } = z.object({ runId: z.string() }).parse(request.params);
    const run = store.runs.get(runId);
    if (!run || run.status !== "failed") {
      return reply
        .code(409)
        .send({ error: "Only failed runs can be retried." });
    }
    const retry = store.recordRun({
      repoId: run.repoId,
      type: run.type,
      status: "queued",
      inputSummary: run.inputSummary,
      safeMessage: `Retry queued for ${run.id}.`,
      artifactVersions: run.artifactVersions,
      repoProfileVersion: run.repoProfileVersion,
      provider: run.provider,
      model: run.model,
      externalId: newId("retry"),
    });
    return { run: retry };
  });

  return app;
}

async function generateContextArtifactsForRun(input: {
  repoId: string;
  profile: RepoProfile;
  files: Array<{ path: string; content: string }>;
  worktreeRoot: string | null;
  provider: ModelProviderConfig;
  runId: string;
  context: "codex" | "claude" | "both" | undefined;
  skills: "codex" | "claude" | "both" | undefined;
}): Promise<GeneratedArtifact[]> {
  try {
    const modelProvider = buildProvider(input.provider, {
      cwd: input.worktreeRoot ?? process.cwd(),
    });
    const orchestrator = createContextGenerationOrchestrator({
      events: {
        failed(error) {
          store.updateRun(input.runId, {
            status: "failed",
            safeMessage:
              error instanceof Error
                ? `Model synthesis failed: ${error.message}`
                : "Model synthesis failed.",
          });
        },
      },
    });
    const result = await orchestrator.generateFromProfile({
      repoId: input.repoId,
      profile: input.profile,
      files: input.files,
      model: {
        providerLabel: input.provider.displayName,
        model: input.provider.model,
        complete(prompt, options) {
          return modelProvider.complete(prompt, {
            outputSchema: options.outputSchema,
          });
        },
      },
      providerKind: input.provider.kind,
      selection: {
        ...(input.context ? { context: input.context } : {}),
        ...(input.skills ? { skills: input.skills } : {}),
      },
      nextArtifactVersion: (store.artifacts.get(input.repoId)?.length ?? 0) + 1,
      writeMode: { kind: "preview" },
    });

    store.updateRun(input.runId, {
      status: "succeeded",
      artifactVersions: result.artifacts.map((artifact) => artifact.version),
      safeMessage: "Context artifacts generated for preview.",
    });
    for (const artifact of result.artifacts) {
      store.addArtifact(artifact);
    }
    return result.artifacts;
  } catch (error) {
    if (store.runs.get(input.runId)?.status !== "failed") {
      store.updateRun(input.runId, {
        status: "failed",
        safeMessage:
          error instanceof Error
            ? `Model synthesis failed: ${error.message}`
            : "Model synthesis failed.",
      });
    }
    throw error;
  }
}

function githubAuthForInstallation(
  installationId: string,
): GitHubAppInstallationAuth | null {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyBase64 = process.env.GITHUB_PRIVATE_KEY_BASE64;
  if (!appId || !privateKeyBase64) {
    return null;
  }
  return {
    appId,
    installationId,
    privateKey: Buffer.from(privateKeyBase64, "base64").toString("utf8"),
  };
}
