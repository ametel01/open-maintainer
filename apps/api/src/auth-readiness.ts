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

export type AuthReadinessChecker = () => Promise<AuthReadiness>;

export function createAuthReadinessChecker(
  input: {
    runCommand?: AuthReadinessCommandRunner;
    cwd?: string;
  } = {},
): AuthReadinessChecker {
  const runCommand = input.runCommand ?? defaultAuthReadinessCommandRunner;
  const configuredCwd = input.cwd;

  return async () => {
    const authCheckCwd =
      configuredCwd ??
      (await mkdtemp(path.join(tmpdir(), "open-maintainer-auth-")));
    try {
      const [ghAuth, codexAuth, claudeAuth] = await Promise.all([
        checkGhAuthentication(runCommand),
        checkCodexAuthentication(authCheckCwd),
        checkClaudeAuthentication(authCheckCwd),
      ]);

      const checkedAt = nowIso();
      return {
        ghAuth,
        codexAuth,
        claudeAuth,
        authReady:
          ghAuth.status === "ok" &&
          codexAuth.status === "ok" &&
          claudeAuth.status === "ok",
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
