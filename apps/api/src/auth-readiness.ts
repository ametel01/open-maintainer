import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_CODEX_CLI_MODEL,
  buildClaudeCliProvider,
  buildCodexCliProvider,
} from "@open-maintainer/ai";
import {
  type AuthReadiness,
  type AuthToolStatus,
  nowIso,
} from "@open-maintainer/shared";

const execFileAsync = promisify(execFile);

export type AuthReadinessCommandRunner = (input: {
  command: string;
  args: string[];
}) => Promise<void>;

export type ModelAuthProvider = "codex" | "claude";

export type AuthReadinessChecker = () => Promise<AuthReadiness>;

export function createAuthReadinessChecker(
  input: {
    runCommand?: AuthReadinessCommandRunner;
    cwd?: string;
    requiredModelAuthProviders?: ReadonlySet<ModelAuthProvider>;
  } = {},
): AuthReadinessChecker {
  const runCommand = input.runCommand ?? defaultAuthReadinessCommandRunner;
  const configuredCwd = input.cwd;
  const requiredModelAuthProviders =
    input.requiredModelAuthProviders ??
    requiredModelAuthProvidersFromEnv(authReadinessEnvironmentProviderConfig());
  const codexAuthRequired = requiredModelAuthProviders.has("codex");
  const claudeAuthRequired = requiredModelAuthProviders.has("claude");

  return async () => {
    const authCheckCwd =
      configuredCwd ??
      (await mkdtemp(path.join(tmpdir(), "open-maintainer-auth-")));
    try {
      const [ghAuth, codexAuth, claudeAuth] = await Promise.all([
        checkGhAuthentication(runCommand),
        codexAuthRequired
          ? checkCodexAuthentication(authCheckCwd)
          : Promise.resolve(skippedAuthStatus()),
        claudeAuthRequired
          ? checkClaudeAuthentication(authCheckCwd)
          : Promise.resolve(skippedAuthStatus()),
      ]);

      const checkedAt = nowIso();
      return {
        ghAuth,
        codexAuth,
        claudeAuth,
        authReady:
          ghAuth.status === "ok" &&
          modelAuthReady(codexAuth, codexAuthRequired) &&
          modelAuthReady(claudeAuth, claudeAuthRequired),
        checkedAt,
      };
    } finally {
      if (!configuredCwd) {
        await rm(authCheckCwd, { recursive: true, force: true });
      }
    }
  };
}

export function strictStartupAuthEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function authReadinessEnvironmentProviderConfig(): {
  requiredModelCliAuth?: string;
  requireClaudeAuth?: string;
} {
  const config: {
    requiredModelCliAuth?: string;
    requireClaudeAuth?: string;
  } = {};
  const requiredModelCliAuth =
    process.env["OPEN_MAINTAINER_REQUIRED_MODEL_CLI_AUTH"];
  const requireClaudeAuth = process.env["OPEN_MAINTAINER_REQUIRE_CLAUDE_AUTH"];
  if (requiredModelCliAuth !== undefined) {
    config.requiredModelCliAuth = requiredModelCliAuth;
  }
  if (requireClaudeAuth !== undefined) {
    config.requireClaudeAuth = requireClaudeAuth;
  }
  return config;
}

export function requiredModelAuthProvidersFromEnv(input: {
  requiredModelCliAuth?: string;
  requireClaudeAuth?: string;
}): ReadonlySet<ModelAuthProvider> {
  const providers = new Set<ModelAuthProvider>();
  const normalized = input.requiredModelCliAuth?.trim().toLowerCase();

  if (!normalized || normalized === "default") {
    providers.add("codex");
  } else {
    const tokens = normalized.split(/[,\s]+/).filter(Boolean);
    for (const token of tokens) {
      if (token === "none") {
        providers.clear();
        continue;
      }
      if (token === "both" || token === "all") {
        providers.add("codex");
        providers.add("claude");
        continue;
      }
      if (token === "codex" || token === "codex-cli") {
        providers.add("codex");
        continue;
      }
      if (token === "claude" || token === "claude-cli") {
        providers.add("claude");
      }
    }
    if (providers.size === 0 && normalized !== "none") {
      providers.add("codex");
    }
  }

  if (input.requireClaudeAuth?.trim().toLowerCase() === "true") {
    providers.add("claude");
  }

  return providers;
}

async function checkGhAuthentication(
  runCommand: AuthReadinessCommandRunner,
): Promise<AuthToolStatus> {
  const checkedAt = nowIso();
  try {
    await runCommand({ command: ghCommand(), args: ["auth", "status"] });
    return { status: "ok", error: null, checkedAt };
  } catch (error) {
    return {
      status: "missing",
      error: sanitizeAuthError(error),
      checkedAt,
    };
  }
}

async function checkCodexAuthentication(cwd: string): Promise<AuthToolStatus> {
  const checkedAt = nowIso();
  try {
    const provider = buildCodexCliProvider({
      command: codexCommand(),
      cwd,
      model: DEFAULT_CODEX_CLI_MODEL,
      timeoutMs: 30_000,
    });
    await provider.complete({
      system:
        "You are an auth readiness check. Return only: ok. Never request repository files.",
      user: "Return only: ok",
    });
    return { status: "ok", error: null, checkedAt };
  } catch (error) {
    return {
      status: "missing",
      error: sanitizeAuthError(error),
      checkedAt,
    };
  }
}

async function checkClaudeAuthentication(cwd: string): Promise<AuthToolStatus> {
  const checkedAt = nowIso();
  try {
    const provider = buildClaudeCliProvider({
      command: claudeCommand(),
      cwd,
      timeoutMs: 30_000,
    });
    await provider.complete({
      system:
        "You are an auth readiness check. Return only: ok. Never request repository files.",
      user: "Return only: ok",
    });
    return { status: "ok", error: null, checkedAt };
  } catch (error) {
    return {
      status: "missing",
      error: sanitizeAuthError(error),
      checkedAt,
    };
  }
}

function skippedAuthStatus(): AuthToolStatus {
  return { status: "skipped", error: null, checkedAt: nowIso() };
}

function modelAuthReady(status: AuthToolStatus, required: boolean): boolean {
  return required ? status.status === "ok" : status.status !== "missing";
}

async function defaultAuthReadinessCommandRunner(input: {
  command: string;
  args: string[];
}): Promise<void> {
  try {
    await execFileAsync(input.command, input.args, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const details =
      error instanceof Error ? error.message : "Command execution failed.";
    throw new Error(
      `${input.command} ${input.args.join(" ")} failed: ${details}`,
    );
  }
}

function sanitizeAuthError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Authentication check failed.";
  }
  const message = error.message.trim();
  if (message.length === 0) {
    return "Authentication check failed.";
  }
  return message.length > 400 ? `${message.slice(0, 400)}...` : message;
}

function ghCommand(): string {
  return process.env["OPEN_MAINTAINER_GH_COMMAND"] ?? "gh";
}

function codexCommand(): string {
  return process.env["OPEN_MAINTAINER_CODEX_COMMAND"] ?? "codex";
}

function claudeCommand(): string {
  return process.env["OPEN_MAINTAINER_CLAUDE_COMMAND"] ?? "claude";
}
