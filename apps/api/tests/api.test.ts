import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeCodexCli } from "../../../tests/helpers/fake-model-cli";
import { buildApp } from "../src/app";
import {
  createAuthReadinessChecker,
  requiredModelAuthProvidersFromEnv,
} from "../src/auth-readiness";

const execFileAsync = promisify(execFile);
const app = buildApp({ authReadiness: async () => authReadinessFixture() });

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function authReadinessFixture(input?: {
  ghAuth?: { status: "ok" | "missing" | "skipped"; error: string | null };
  codexAuth?: { status: "ok" | "missing" | "skipped"; error: string | null };
  claudeAuth?: { status: "ok" | "missing" | "skipped"; error: string | null };
}) {
  const checkedAt = new Date("2026-01-01T00:00:00.000Z").toISOString();
  const ghAuth = {
    status: input?.ghAuth?.status ?? ("ok" as const),
    error: input?.ghAuth?.error ?? null,
    checkedAt,
  };
  const codexAuth = {
    status: input?.codexAuth?.status ?? ("ok" as const),
    error: input?.codexAuth?.error ?? null,
    checkedAt,
  };
  const claudeAuth = {
    status: input?.claudeAuth?.status ?? ("ok" as const),
    error: input?.claudeAuth?.error ?? null,
    checkedAt,
  };
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
}

async function createLocalReviewRepo(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "api-review-test-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: directory,
  });
  await execFileAsync("git", ["config", "user.name", "Test User"], {
    cwd: directory,
  });
  await mkdir(path.join(directory, "src"), { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ scripts: { test: "bun test", build: "tsc -b" } }),
  );
  await writeFile(
    path.join(directory, "src", "index.ts"),
    "export const value = 1;\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });
  await writeFile(
    path.join(directory, "src", "index.ts"),
    "export const value = 2;\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "change value"], {
    cwd: directory,
  });
  return directory;
}

async function createLocalPullRequestRepo(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "api-pr-test-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: directory,
  });
  await execFileAsync("git", ["config", "user.name", "Test User"], {
    cwd: directory,
  });
  await mkdir(path.join(directory, "src"), { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ scripts: { test: "bun test", build: "tsc -b" } }),
  );
  await writeFile(
    path.join(directory, "src/index.ts"),
    "export const value = 1;\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });
  await execFileAsync("git", ["checkout", "-b", "feature"], {
    cwd: directory,
  });
  await writeFile(
    path.join(directory, "src/index.ts"),
    "export const value = 2;\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "change value"], {
    cwd: directory,
  });
  return directory;
}

async function createFakeGhCli(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "api-gh-test-"));
  const command = path.join(directory, "fake-gh.js");
  await writeFile(
    command,
    `#!/usr/bin/env node
if (process.argv.slice(2).join(" ") === "pr view 52 --json baseRefName,headRefName,headRefOid,title,body,url,author,isDraft,mergeable,mergeStateStatus,reviewDecision") {
  process.stdout.write(JSON.stringify({
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: "head-sha",
    title: "Require LLM mode for generation and PR review",
    body: "Validation: bun test",
    url: "https://github.com/Open-Maintainer/open-maintainer/pull/52",
    author: { login: "maintainer" },
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "REVIEW_REQUIRED"
  }));
  process.exit(0);
}
process.stderr.write("unexpected fake gh args: " + process.argv.slice(2).join(" ") + "\\n");
process.exit(1);
`,
  );
  await chmod(command, 0o755);
  return command;
}

async function createFakePrDashboardGhCli(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "api-pr-dashboard-gh-"));
  const command = path.join(directory, "fake-gh-dashboard.js");
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
function writeLog(entry) {
  if (process.env.OPEN_MAINTAINER_FAKE_GH_LABEL_LOG) {
    fs.appendFileSync(process.env.OPEN_MAINTAINER_FAKE_GH_LABEL_LOG, entry + "\\n");
  }
}
if (args[0] === "pr" && args[1] === "list") {
  const jsonFields = args[args.indexOf("--json") + 1] || "";
  if (jsonFields.includes("commits") || jsonFields.includes("comments") || jsonFields.includes("statusCheckRollup")) {
    process.stderr.write("list query includes expensive fields: " + jsonFields + "\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([
    {
      number: 52,
      title: "Add dashboard pull request management",
      state: "OPEN",
      body: "Fast PR queue. Generated by Codex.",
      url: "https://github.com/local/tool/pull/52",
      author: { login: "maintainer" },
      isDraft: false,
      labels: [{ name: "dashboard" }],
      reviewDecision: "REVIEW_REQUIRED",
      mergeStateStatus: "CLEAN",
      updatedAt: "2026-05-04T00:01:00.000Z",
      createdAt: "2026-05-04T00:00:00.000Z",
      statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
      comments: 1,
      commits: 1,
      changedFiles: 1,
      additions: 1,
      deletions: 1,
      headRefName: "feature",
      headRefOid: "head-sha",
      baseRefName: "main",
      assignees: [],
      reviewRequests: [{ login: "reviewer" }]
    }
  ]));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view" && args[2] === "52") {
  const jsonFields = args[args.indexOf("--json") + 1] || "";
  if (jsonFields.includes("baseRefOid")) {
    process.stderr.write("view query includes unsupported gh field: " + jsonFields + "\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    number: 52,
    title: "Add dashboard pull request management",
    state: "OPEN",
    body: "Fast PR queue. Generated by Codex.",
    url: "https://github.com/local/tool/pull/52",
    author: { login: "maintainer" },
    isDraft: false,
    labels: [{ name: "dashboard" }],
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    updatedAt: "2026-05-04T00:01:00.000Z",
    createdAt: "2026-05-04T00:00:00.000Z",
    statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
    comments: [{
      id: 100,
      body: "Looks ready for review.",
      url: "https://github.com/local/tool/pull/52#issuecomment-100",
      author: { login: "reviewer" },
      createdAt: "2026-05-04T00:02:00.000Z",
      updatedAt: "2026-05-04T00:02:00.000Z"
    }],
    reviews: [{
      id: 101,
      body: "Requested review.",
      state: "COMMENTED",
      url: "https://github.com/local/tool/pull/52#pullrequestreview-101",
      author: { login: "reviewer" },
      submittedAt: "2026-05-04T00:03:00.000Z"
    }],
    commits: [{
      oid: "commit-sha",
      messageHeadline: "change value",
      authoredDate: "2026-05-04T00:00:30.000Z",
      authors: [{ login: "maintainer" }]
    }],
    changedFiles: 1,
    additions: 1,
    deletions: 1,
    headRefName: "feature",
    headRefOid: "head-sha",
    baseRefName: "main",
    assignees: [],
    reviewRequests: [{ login: "reviewer" }]
  }));
  process.exit(0);
}
if (args[0] === "label" && args[1] === "create") {
  writeLog("label-create " + args[2]);
  process.stdout.write("{}");
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write("local/tool\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/local/tool/issues/52/labels") {
  writeLog("issue-labels " + args.filter((arg) => arg.startsWith("labels[]=")).join(","));
  process.stdout.write("{}");
  process.exit(0);
}
process.stderr.write("unexpected fake gh args: " + args.join(" ") + "\\n");
process.exit(1);
`,
  );
  await chmod(command, 0o755);
  return command;
}

async function createFailingGhCli(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "api-gh-fail-test-"));
  const command = path.join(directory, "fake-gh-fail.js");
  await writeFile(
    command,
    `#!/usr/bin/env node
process.stderr.write("gh is not authenticated\\n");
process.exit(1);
`,
  );
  await chmod(command, 0o755);
  return command;
}

async function createFakeAuthCodexCli(): Promise<{
  command: string;
  directory: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "api-auth-codex-"));
  const command = path.join(directory, "fake-auth-codex.js");
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex >= 0) {
  fs.writeFileSync(process.argv[outputIndex + 1], "ok\\n");
}
process.exit(0);
`,
  );
  await chmod(command, 0o755);
  return { command, directory };
}

async function createFakeClaudeCli(input: {
  exitCode: number;
}): Promise<{ command: string; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "api-auth-claude-"));
  const command = path.join(directory, "fake-auth-claude.js");
  await writeFile(
    command,
    `#!/usr/bin/env node
if (${input.exitCode} === 0) {
  process.stdout.write(JSON.stringify({ result: "ok" }));
} else {
  process.stderr.write("claude auth missing\\n");
}
process.exit(${input.exitCode});
`,
  );
  await chmod(command, 0o755);
  return { command, directory };
}

describe("MVP API", () => {
  it("returns auth readiness when all CLI auth checks pass", async () => {
    const authApp = buildApp({
      authReadiness: async () => authReadinessFixture(),
    });
    try {
      await authApp.ready();
      const response = await authApp.inject({
        method: "GET",
        url: "/auth/ready",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().authReady).toBe(true);
      expect(response.json().ghAuth.status).toBe("ok");
      expect(response.json().codexAuth.status).toBe("ok");
      expect(response.json().claudeAuth.status).toBe("ok");
    } finally {
      await authApp.close();
    }
  });

  it("returns launch-time cached auth readiness in non-strict mode", async () => {
    let checks = 0;
    const authApp = buildApp({
      authReadiness: async () => {
        checks += 1;
        return authReadinessFixture({
          ghAuth: { status: "missing", error: "gh auth status failed" },
        });
      },
    });
    try {
      await authApp.ready();
      const first = await authApp.inject({
        method: "GET",
        url: "/auth/ready",
      });
      const second = await authApp.inject({
        method: "GET",
        url: "/auth/ready",
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.json().authReady).toBe(false);
      expect(second.json()).toEqual(first.json());
      expect(checks).toBe(1);
    } finally {
      await authApp.close();
    }
  });

  it("does not block non-strict startup on slow auth readiness checks", async () => {
    let resolveReadiness:
      | ((readiness: ReturnType<typeof authReadinessFixture>) => void)
      | null = null;
    const delayedReadiness = new Promise<
      ReturnType<typeof authReadinessFixture>
    >((resolve) => {
      resolveReadiness = resolve;
    });
    const authApp = buildApp({
      authReadiness: async () => delayedReadiness,
    });
    try {
      const startup = authApp.ready().then(() => "ready" as const);
      const result = await Promise.race([
        startup,
        new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), 50),
        ),
      ]);
      expect(result).toBe("ready");
      resolveReadiness?.(authReadinessFixture());
      await delayedReadiness;
      await startup;
    } finally {
      await authApp.close();
    }
  });

  it("returns degraded auth readiness when only gh auth is missing", async () => {
    const authApp = buildApp({
      authReadiness: async () =>
        authReadinessFixture({
          ghAuth: { status: "missing", error: "gh auth status failed" },
        }),
    });
    try {
      await authApp.ready();
      const response = await authApp.inject({
        method: "GET",
        url: "/auth/ready",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().authReady).toBe(false);
      expect(response.json().ghAuth.status).toBe("missing");
      expect(response.json().codexAuth.status).toBe("ok");
      expect(response.json().claudeAuth.status).toBe("ok");
    } finally {
      await authApp.close();
    }
  });

  it("returns degraded auth readiness when only codex auth is missing", async () => {
    const authApp = buildApp({
      authReadiness: async () =>
        authReadinessFixture({
          codexAuth: {
            status: "missing",
            error: "Codex CLI auth missing",
          },
        }),
    });
    try {
      await authApp.ready();
      const response = await authApp.inject({
        method: "GET",
        url: "/auth/ready",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().authReady).toBe(false);
      expect(response.json().ghAuth.status).toBe("ok");
      expect(response.json().codexAuth.status).toBe("missing");
      expect(response.json().claudeAuth.status).toBe("ok");
    } finally {
      await authApp.close();
    }
  });

  it("returns degraded auth readiness when only claude auth is missing", async () => {
    const authApp = buildApp({
      authReadiness: async () =>
        authReadinessFixture({
          claudeAuth: {
            status: "missing",
            error: "Claude CLI auth missing",
          },
        }),
    });
    try {
      await authApp.ready();
      const response = await authApp.inject({
        method: "GET",
        url: "/auth/ready",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().authReady).toBe(false);
      expect(response.json().ghAuth.status).toBe("ok");
      expect(response.json().codexAuth.status).toBe("ok");
      expect(response.json().claudeAuth.status).toBe("missing");
    } finally {
      await authApp.close();
    }
  });

  it("skips Claude auth readiness in the default Codex-only model auth mode", async () => {
    const fakeCodex = await createFakeAuthCodexCli();
    const previousCodexCommand = process.env["OPEN_MAINTAINER_CODEX_COMMAND"];
    const previousRequiredModelCliAuth =
      process.env["OPEN_MAINTAINER_REQUIRED_MODEL_CLI_AUTH"];
    const previousRequireClaudeAuth =
      process.env["OPEN_MAINTAINER_REQUIRE_CLAUDE_AUTH"];
    try {
      process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = fakeCodex.command;
      Reflect.deleteProperty(
        process.env,
        "OPEN_MAINTAINER_REQUIRED_MODEL_CLI_AUTH",
      );
      Reflect.deleteProperty(
        process.env,
        "OPEN_MAINTAINER_REQUIRE_CLAUDE_AUTH",
      );

      const readiness = await createAuthReadinessChecker({
        cwd: fakeCodex.directory,
        runCommand: async () => undefined,
      })();

      expect(readiness.authReady).toBe(true);
      expect(readiness.ghAuth.status).toBe("ok");
      expect(readiness.codexAuth.status).toBe("ok");
      expect(readiness.claudeAuth.status).toBe("skipped");
    } finally {
      if (previousCodexCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CODEX_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = previousCodexCommand;
      }
      if (previousRequiredModelCliAuth === undefined) {
        Reflect.deleteProperty(
          process.env,
          "OPEN_MAINTAINER_REQUIRED_MODEL_CLI_AUTH",
        );
      } else {
        process.env["OPEN_MAINTAINER_REQUIRED_MODEL_CLI_AUTH"] =
          previousRequiredModelCliAuth;
      }
      if (previousRequireClaudeAuth === undefined) {
        Reflect.deleteProperty(
          process.env,
          "OPEN_MAINTAINER_REQUIRE_CLAUDE_AUTH",
        );
      } else {
        process.env["OPEN_MAINTAINER_REQUIRE_CLAUDE_AUTH"] =
          previousRequireClaudeAuth;
      }
      await rm(fakeCodex.directory, { recursive: true, force: true });
    }
  });

  it("degrades readiness when Claude auth is explicitly required and missing", async () => {
    const fakeCodex = await createFakeAuthCodexCli();
    const fakeClaude = await createFakeClaudeCli({ exitCode: 1 });
    const previousCodexCommand = process.env["OPEN_MAINTAINER_CODEX_COMMAND"];
    const previousClaudeCommand = process.env["OPEN_MAINTAINER_CLAUDE_COMMAND"];
    const previousRequiredModelCliAuth =
      process.env["OPEN_MAINTAINER_REQUIRED_MODEL_CLI_AUTH"];
    try {
      process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = fakeCodex.command;
      process.env["OPEN_MAINTAINER_CLAUDE_COMMAND"] = fakeClaude.command;
      process.env["OPEN_MAINTAINER_REQUIRED_MODEL_CLI_AUTH"] = "codex,claude";

      const readiness = await createAuthReadinessChecker({
        cwd: fakeCodex.directory,
        runCommand: async () => undefined,
      })();

      expect(readiness.authReady).toBe(false);
      expect(readiness.codexAuth.status).toBe("ok");
      expect(readiness.claudeAuth.status).toBe("missing");
      expect(readiness.claudeAuth.error).toContain(
        "Claude CLI exited with code 1",
      );
    } finally {
      if (previousCodexCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CODEX_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = previousCodexCommand;
      }
      if (previousClaudeCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CLAUDE_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_CLAUDE_COMMAND"] = previousClaudeCommand;
      }
      if (previousRequiredModelCliAuth === undefined) {
        Reflect.deleteProperty(
          process.env,
          "OPEN_MAINTAINER_REQUIRED_MODEL_CLI_AUTH",
        );
      } else {
        process.env["OPEN_MAINTAINER_REQUIRED_MODEL_CLI_AUTH"] =
          previousRequiredModelCliAuth;
      }
      await rm(fakeCodex.directory, { recursive: true, force: true });
      await rm(fakeClaude.directory, { recursive: true, force: true });
    }
  });

  it("supports Claude-only model auth readiness for Claude CLI deployments", async () => {
    const fakeClaude = await createFakeClaudeCli({ exitCode: 0 });
    const previousCodexCommand = process.env["OPEN_MAINTAINER_CODEX_COMMAND"];
    const previousClaudeCommand = process.env["OPEN_MAINTAINER_CLAUDE_COMMAND"];
    const previousRequiredModelCliAuth =
      process.env["OPEN_MAINTAINER_REQUIRED_MODEL_CLI_AUTH"];
    try {
      process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = "/missing/codex";
      process.env["OPEN_MAINTAINER_CLAUDE_COMMAND"] = fakeClaude.command;
      process.env["OPEN_MAINTAINER_REQUIRED_MODEL_CLI_AUTH"] = "claude";

      const readiness = await createAuthReadinessChecker({
        cwd: fakeClaude.directory,
        runCommand: async () => undefined,
      })();

      expect(readiness.authReady).toBe(true);
      expect(readiness.codexAuth.status).toBe("skipped");
      expect(readiness.claudeAuth.status).toBe("ok");
    } finally {
      if (previousCodexCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CODEX_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = previousCodexCommand;
      }
      if (previousClaudeCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CLAUDE_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_CLAUDE_COMMAND"] = previousClaudeCommand;
      }
      if (previousRequiredModelCliAuth === undefined) {
        Reflect.deleteProperty(
          process.env,
          "OPEN_MAINTAINER_REQUIRED_MODEL_CLI_AUTH",
        );
      } else {
        process.env["OPEN_MAINTAINER_REQUIRED_MODEL_CLI_AUTH"] =
          previousRequiredModelCliAuth;
      }
      await rm(fakeClaude.directory, { recursive: true, force: true });
    }
  });

  it("parses model auth readiness provider requirements", () => {
    expect([...requiredModelAuthProvidersFromEnv({})]).toEqual(["codex"]);
    expect([
      ...requiredModelAuthProvidersFromEnv({ requiredModelCliAuth: "none" }),
    ]).toEqual([]);
    expect([
      ...requiredModelAuthProvidersFromEnv({
        requiredModelCliAuth: "codex,claude",
      }),
    ]).toEqual(["codex", "claude"]);
    expect([
      ...requiredModelAuthProvidersFromEnv({
        requiredModelCliAuth: "codex",
        requireClaudeAuth: "true",
      }),
    ]).toEqual(["codex", "claude"]);
  });

  it("fails startup in strict auth mode when readiness checks fail", async () => {
    const previousStrict = process.env["OPEN_MAINTAINER_STRICT_STARTUP_AUTH"];
    process.env["OPEN_MAINTAINER_STRICT_STARTUP_AUTH"] = "true";
    const strictApp = buildApp({
      authReadiness: async () =>
        authReadinessFixture({
          ghAuth: { status: "missing", error: "gh auth status failed" },
        }),
    });
    try {
      await expect(strictApp.ready()).rejects.toThrow(
        /Strict startup auth readiness failed/,
      );
    } finally {
      await strictApp.close().catch(() => undefined);
      if (previousStrict === undefined) {
        Reflect.deleteProperty(
          process.env,
          "OPEN_MAINTAINER_STRICT_STARTUP_AUTH",
        );
      } else {
        process.env["OPEN_MAINTAINER_STRICT_STARTUP_AUTH"] = previousStrict;
      }
    }
  });

  it("reports service health and worker heartbeat", async () => {
    const beforeRuns = await app.inject({
      method: "GET",
      url: "/repos/repo_demo/runs",
    });
    await app.inject({ method: "POST", url: "/worker/heartbeat" });
    const response = await app.inject({ method: "GET", url: "/health" });
    const afterRuns = await app.inject({
      method: "GET",
      url: "/repos/repo_demo/runs",
    });
    const workerRunsBefore = beforeRuns
      .json()
      .runs.filter((run: { type: string }) => run.type === "worker").length;
    const workerRunsAfter = afterRuns
      .json()
      .runs.filter((run: { type: string }) => run.type === "worker").length;

    expect(response.statusCode).toBe(200);
    expect(response.json().worker).toBe("ok");
    expect(workerRunsAfter).toBe(workerRunsBefore);
  });

  it("rate-limits repo actions that can use GitHub installation authorization", async () => {
    await expectPostRouteIsRateLimited("/repos/missing/analyze");
    await expectPostRouteIsRateLimited("/repos/missing/open-context-pr");
  });

  it("accepts browser form submissions for dashboard actions", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/repos/repo_demo/open-context-pr",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("No repo profile available.");
  });

  it("accepts CLI model providers for dashboard setup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "api-cli-test-"));
    const command = path.join(directory, "fake-cli.js");
    const previousCodexCommand = process.env["OPEN_MAINTAINER_CODEX_COMMAND"];
    const previousClaudeCommand = process.env["OPEN_MAINTAINER_CLAUDE_COMMAND"];
    try {
      await writeFile(
        command,
        "#!/usr/bin/env node\nprocess.stdout.write('fake-cli 1.0.0\\n');\n",
      );
      await chmod(command, 0o755);
      process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = command;
      process.env["OPEN_MAINTAINER_CLAUDE_COMMAND"] = command;

      const codex = await app.inject({
        method: "POST",
        url: "/model-providers",
        payload: {
          kind: "codex-cli",
          displayName: "Codex CLI",
          baseUrl: "http://localhost",
          model: "codex-cli",
          apiKey: "local-cli",
          repoContentConsent: true,
        },
      });
      expect(codex.statusCode).toBe(200);
      expect(codex.json().provider.kind).toBe("codex-cli");
      expect(codex.json().provider.repoContentConsent).toBe(true);

      const claude = await app.inject({
        method: "POST",
        url: "/model-providers",
        payload: {
          kind: "claude-cli",
          displayName: "Claude CLI",
          baseUrl: "http://localhost",
          model: "claude-cli",
          apiKey: "local-cli",
          repoContentConsent: true,
        },
      });
      expect(claude.statusCode).toBe(200);
      expect(claude.json().provider.kind).toBe("claude-cli");
    } finally {
      if (previousCodexCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CODEX_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = previousCodexCommand;
      }
      if (previousClaudeCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CLAUDE_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_CLAUDE_COMMAND"] = previousClaudeCommand;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("registers a local filesystem repository for dashboard selection", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/repos/local",
      payload: { repoRoot: `${process.cwd()}/tests/fixtures/low-context-ts` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().repo.id).toBe("local_fixtures_low_context_ts");
    expect(response.json().files).toBeGreaterThan(0);

    const analysis = await app.inject({
      method: "POST",
      url: "/repos/local_fixtures_low_context_ts/analyze",
    });
    expect(analysis.statusCode).toBe(200);
    expect(analysis.json().profile.name).toBe("low-context-ts");
  });

  it("registers browser-uploaded repository files for dashboard selection", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/repos/local-files",
      payload: {
        name: "uploaded-tool",
        files: [
          {
            path: "package.json",
            content: JSON.stringify({
              scripts: { test: "bun test" },
              dependencies: { fastify: "latest" },
            }),
          },
          { path: "README.md", content: "# Uploaded Tool\n" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().repo.id).toBe("local_local_uploaded_tool");

    const analysis = await app.inject({
      method: "POST",
      url: "/repos/local_local_uploaded_tool/analyze",
    });
    expect(analysis.statusCode).toBe(200);
    expect(analysis.json().profile.frameworks).toContain("fastify");
  });

  it("lists local pull requests and returns dashboard detail tabs", async () => {
    const repoRoot = await createLocalPullRequestRepo();
    const fakeGh = await createFakePrDashboardGhCli();
    const previousGhCommand = process.env["OPEN_MAINTAINER_GH_COMMAND"];
    try {
      process.env["OPEN_MAINTAINER_GH_COMMAND"] = fakeGh;
      const registered = await app.inject({
        method: "POST",
        url: "/repos/local",
        payload: { repoRoot },
      });
      expect(registered.statusCode).toBe(200);
      const repoId = registered.json().repo.id;

      const list = await app.inject({
        method: "GET",
        url: `/repos/${repoId}/pulls?state=open&search=dashboard&sort=updated`,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().source).toBe("local-gh");
      expect(list.json().pullRequests).toHaveLength(1);
      expect(list.json().pullRequests[0]).toEqual(
        expect.objectContaining({
          number: 52,
          attention: "review_required",
          labels: ["dashboard"],
          reviewers: ["reviewer"],
          triageTags: [
            expect.objectContaining({
              githubLabel: "open-maintainer/llm-authored",
            }),
          ],
        }),
      );

      const detail = await app.inject({
        method: "GET",
        url: `/repos/${repoId}/pulls/52`,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().pullRequest.summary.number).toBe(52);
      expect(detail.json().pullRequest.baseSha).toEqual(expect.any(String));
      expect(detail.json().pullRequest.timeline).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "comment" }),
          expect.objectContaining({ kind: "review" }),
        ]),
      );
      expect(detail.json().pullRequest.files[0]).toEqual(
        expect.objectContaining({ path: "src/index.ts" }),
      );
      expect(detail.json().pullRequest.commits[0]).toEqual(
        expect.objectContaining({ message: "change value" }),
      );
    } finally {
      if (previousGhCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_GH_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_GH_COMMAND"] = previousGhCommand;
      }
    }
  });

  it("runs batch PR triage and applies Open Maintainer labels", async () => {
    const repoRoot = await createLocalPullRequestRepo();
    const fakeGh = await createFakePrDashboardGhCli();
    const fakeCodex = await createFakeCodexCli();
    const labelLog = path.join(repoRoot, "fake-gh-labels.log");
    const previousGhCommand = process.env["OPEN_MAINTAINER_GH_COMMAND"];
    const previousCodexCommand = process.env["OPEN_MAINTAINER_CODEX_COMMAND"];
    const previousLabelLog = process.env["OPEN_MAINTAINER_FAKE_GH_LABEL_LOG"];
    try {
      process.env["OPEN_MAINTAINER_GH_COMMAND"] = fakeGh;
      process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = fakeCodex.command;
      process.env["OPEN_MAINTAINER_FAKE_GH_LABEL_LOG"] = labelLog;
      const registered = await app.inject({
        method: "POST",
        url: "/repos/local",
        payload: { repoRoot },
      });
      expect(registered.statusCode).toBe(200);
      const repoId = registered.json().repo.id;
      const provider = await app.inject({
        method: "POST",
        url: "/model-providers",
        payload: {
          kind: "codex-cli",
          displayName: "Codex CLI",
          baseUrl: "http://localhost",
          model: "codex-cli",
          apiKey: "local-cli",
          repoContentConsent: true,
        },
      });
      expect(provider.statusCode).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: `/repos/${repoId}/pulls/triage`,
        payload: {
          providerId: provider.json().provider.id,
          pullNumbers: [52],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().run.status).toBe("succeeded");
      expect(response.json().results[0]).toEqual(
        expect.objectContaining({
          number: 52,
          status: "labeled",
          appliedLabels: [
            "open-maintainer/ready-for-review",
            "open-maintainer/llm-authored",
          ],
        }),
      );
      const log = await readFile(labelLog, "utf8");
      expect(log).toContain("label-create open-maintainer/ready-for-review");
      expect(log).toContain("label-create open-maintainer/llm-authored");
      expect(log).toContain(
        "issue-labels labels[]=open-maintainer/ready-for-review,labels[]=open-maintainer/llm-authored",
      );
    } finally {
      if (previousGhCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_GH_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_GH_COMMAND"] = previousGhCommand;
      }
      if (previousCodexCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CODEX_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = previousCodexCommand;
      }
      if (previousLabelLog === undefined) {
        Reflect.deleteProperty(
          process.env,
          "OPEN_MAINTAINER_FAKE_GH_LABEL_LOG",
        );
      } else {
        process.env["OPEN_MAINTAINER_FAKE_GH_LABEL_LOG"] = previousLabelLog;
      }
    }
  });

  it("creates dashboard PR review previews and guards posting", async () => {
    const repoRoot = await createLocalReviewRepo();
    const fakeCodex = await createFakeCodexCli();
    const previousCodexCommand = process.env["OPEN_MAINTAINER_CODEX_COMMAND"];
    process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = fakeCodex.command;
    const registered = await app.inject({
      method: "POST",
      url: "/repos/local",
      payload: { repoRoot },
    });
    expect(registered.statusCode).toBe(200);
    const repoId = registered.json().repo.id;
    const analysis = await app.inject({
      method: "POST",
      url: `/repos/${repoId}/analyze`,
    });
    expect(analysis.statusCode).toBe(200);

    const provider = await app.inject({
      method: "POST",
      url: "/model-providers",
      payload: {
        kind: "codex-cli",
        displayName: "Codex CLI",
        baseUrl: "http://localhost",
        model: "codex-cli",
        apiKey: "local-cli",
        repoContentConsent: true,
      },
    });
    expect(provider.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: `/repos/${repoId}/reviews`,
      payload: {
        baseRef: "HEAD~1",
        headRef: "HEAD",
        prNumber: 48,
        providerId: provider.json().provider.id,
      },
    });
    if (previousCodexCommand === undefined) {
      Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CODEX_COMMAND");
    } else {
      process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = previousCodexCommand;
    }
    expect(created.statusCode).toBe(200);
    expect(created.json().run.type).toBe("review");
    expect(created.json().run.status).toBe("succeeded");
    expect(created.json().review.prNumber).toBe(48);
    expect(created.json().review.changedFiles[0].path).toBe("src/index.ts");
    expect(created.json().review.modelProvider).toBe("Codex CLI");

    const reviews = await app.inject({
      method: "GET",
      url: `/repos/${repoId}/reviews`,
    });
    expect(reviews.statusCode).toBe(200);
    expect(reviews.json().reviews).toHaveLength(1);

    const readback = await app.inject({
      method: "GET",
      url: `/reviews/${created.json().review.id}`,
    });
    expect(readback.statusCode).toBe(200);
    expect(readback.json().review.id).toBe(created.json().review.id);

    const feedback = await app.inject({
      method: "POST",
      url: `/reviews/${created.json().review.id}/feedback`,
      payload: {
        findingId: "missing-finding",
        verdict: "false_positive",
        reason: "Validation is covered by the disposable test repo.",
        actor: "maintainer",
      },
    });
    expect(feedback.statusCode).toBe(422);

    expect(feedback.json().error).toContain("Unknown finding ID");

    const posting = await app.inject({
      method: "POST",
      url: `/reviews/${created.json().review.id}/post-summary`,
    });
    expect(posting.statusCode).toBe(409);
    expect(posting.json().error).toContain("GitHub credentials");

    const runs = await app.inject({
      method: "GET",
      url: `/repos/${repoId}/runs`,
    });
    expect(
      runs.json().runs.some((run: { type: string }) => run.type === "review"),
    ).toBe(true);
  });

  it("creates PR-number-only review previews from an existing profile", async () => {
    const repoRoot = await createLocalPullRequestRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();
    const previousCodexCommand = process.env["OPEN_MAINTAINER_CODEX_COMMAND"];
    const previousGhCommand = process.env["OPEN_MAINTAINER_GH_COMMAND"];
    try {
      process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = fakeCodex.command;
      process.env["OPEN_MAINTAINER_GH_COMMAND"] = fakeGh;
      const registered = await app.inject({
        method: "POST",
        url: "/repos/local",
        payload: { repoRoot },
      });
      expect(registered.statusCode).toBe(200);
      const repoId = registered.json().repo.id;
      const analysis = await app.inject({
        method: "POST",
        url: `/repos/${repoId}/analyze`,
      });
      expect(analysis.statusCode).toBe(200);

      const provider = await app.inject({
        method: "POST",
        url: "/model-providers",
        payload: {
          kind: "codex-cli",
          displayName: "Codex CLI",
          baseUrl: "http://localhost",
          model: "codex-cli",
          apiKey: "local-cli",
          repoContentConsent: true,
        },
      });
      expect(provider.statusCode).toBe(200);

      const created = await app.inject({
        method: "POST",
        url: `/repos/${repoId}/reviews`,
        payload: {
          prNumber: 52,
          providerId: provider.json().provider.id,
        },
      });

      expect(created.statusCode).toBe(200);
      expect(created.json().review.prNumber).toBe(52);
      expect(created.json().review.baseRef).toBe("main");
      expect(created.json().review.headRef).toBe("feature");
      expect(created.json().review.changedFiles[0].path).toBe("src/index.ts");
      expect(created.json().run.repoProfileVersion).toBe(1);
    } finally {
      if (previousCodexCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CODEX_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = previousCodexCommand;
      }
      if (previousGhCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_GH_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_GH_COMMAND"] = previousGhCommand;
      }
    }
  });

  it("rejects PR-number-only review previews when PR refs cannot be resolved", async () => {
    const repoRoot = await createLocalPullRequestRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFailingGhCli();
    const previousCodexCommand = process.env["OPEN_MAINTAINER_CODEX_COMMAND"];
    const previousGhCommand = process.env["OPEN_MAINTAINER_GH_COMMAND"];
    try {
      process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = fakeCodex.command;
      process.env["OPEN_MAINTAINER_GH_COMMAND"] = fakeGh;
      const registered = await app.inject({
        method: "POST",
        url: "/repos/local",
        payload: { repoRoot },
      });
      expect(registered.statusCode).toBe(200);
      const repoId = registered.json().repo.id;

      const provider = await app.inject({
        method: "POST",
        url: "/model-providers",
        payload: {
          kind: "codex-cli",
          displayName: "Codex CLI",
          baseUrl: "http://localhost",
          model: "codex-cli",
          apiKey: "local-cli",
          repoContentConsent: true,
        },
      });
      expect(provider.statusCode).toBe(200);

      const created = await app.inject({
        method: "POST",
        url: `/repos/${repoId}/reviews`,
        payload: {
          prNumber: 52,
          providerId: provider.json().provider.id,
        },
      });

      expect(created.statusCode).toBe(422);
      expect(created.json().error).toContain(
        "Unable to resolve the base ref for PR #52",
      );
      expect(created.json().error).toContain("gh is not authenticated");
    } finally {
      if (previousCodexCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CODEX_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = previousCodexCommand;
      }
      if (previousGhCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_GH_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_GH_COMMAND"] = previousGhCommand;
      }
    }
  });

  it("passes repo context files into dashboard PR review prompts", async () => {
    const repoRoot = await createLocalPullRequestRepo();
    const repoName = path.basename(repoRoot);
    await mkdir(path.join(repoRoot, ".open-maintainer"), { recursive: true });
    await mkdir(
      path.join(repoRoot, ".agents/skills", `${repoName}-pr-review`),
      {
        recursive: true,
      },
    );
    await mkdir(
      path.join(repoRoot, ".agents/skills", `${repoName}-testing-workflow`),
      { recursive: true },
    );
    await writeFile(
      path.join(repoRoot, "AGENTS.md"),
      "# AGENTS marker\n\nUse repo-specific review context.\n",
    );
    await writeFile(
      path.join(repoRoot, ".open-maintainer.yml"),
      "qualityRules:\n  - open-maintainer config marker\n",
    );
    await writeFile(
      path.join(
        repoRoot,
        ".agents/skills",
        `${repoName}-pr-review`,
        "SKILL.md",
      ),
      "---\nname: pr-review\n---\n\nPR review skill marker.\n",
    );
    await writeFile(
      path.join(
        repoRoot,
        ".agents/skills",
        `${repoName}-testing-workflow`,
        "SKILL.md",
      ),
      "---\nname: testing-workflow\n---\n\nTesting skill marker.\n",
    );
    const capturedUsers: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role: string; content: string }>;
        };
        const userMessage = payload.messages?.find(
          (message) => message.role === "user",
        );
        if (userMessage) {
          capturedUsers.push(userMessage.content);
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: {
                      overview: "Prompt context was received.",
                      changedSurfaces: ["api"],
                      riskLevel: "low",
                      validationSummary: "No validation gaps.",
                      docsSummary: "No docs gaps.",
                    },
                    findings: [],
                    contributionTriage: {
                      category: "ready_for_review",
                      recommendation: "Proceed with normal maintainer review.",
                      evidence: [
                        {
                          id: "precheck:contribution:1",
                          kind: "precheck",
                          summary: "Contribution triage evidence was supplied.",
                        },
                      ],
                      missingInformation: [],
                      requiredActions: [],
                    },
                    mergeReadiness: {
                      status: "ready",
                      reason: "No findings.",
                      requiredActions: [],
                    },
                    residualRisk: [],
                  }),
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected provider test server port");
    }
    try {
      const registered = await app.inject({
        method: "POST",
        url: "/repos/local",
        payload: { repoRoot },
      });
      expect(registered.statusCode).toBe(200);
      const repoId = registered.json().repo.id;

      const provider = await app.inject({
        method: "POST",
        url: "/model-providers",
        payload: {
          kind: "local-openai-compatible",
          displayName: "Local prompt capture",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: "prompt-capture",
          apiKey: "dev",
          repoContentConsent: true,
        },
      });
      expect(provider.statusCode).toBe(200);

      const created = await app.inject({
        method: "POST",
        url: `/repos/${repoId}/reviews`,
        payload: {
          baseRef: "main",
          headRef: "HEAD",
          providerId: provider.json().provider.id,
        },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().review.contributionTriage.category).toBe(
        "ready_for_review",
      );

      const history = await app.inject({
        method: "GET",
        url: `/repos/${repoId}/reviews`,
      });
      expect(history.statusCode).toBe(200);
      expect(history.json().reviews[0].contributionTriage.category).toBe(
        "ready_for_review",
      );

      const promptPayload = JSON.parse(capturedUsers[0] ?? "{}") as {
        context?: Record<string, string>;
      };
      expect(promptPayload.context?.agentsMd).toContain("AGENTS marker");
      expect(promptPayload.context?.openMaintainerConfig).toContain(
        "open-maintainer config marker",
      );
      expect(promptPayload.context?.repoPrReviewSkill).toContain(
        "PR review skill marker",
      );
      expect(promptPayload.context?.repoTestingWorkflowSkill).toContain(
        "Testing skill marker",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("generates dashboard context and opens local PRs through authenticated gh", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "api-codex-gen-test-"));
    const command = path.join(directory, "fake-codex.js");
    const ghCommand = path.join(directory, "fake-gh.js");
    const repoRoot = path.join(directory, "repo");
    const remoteRoot = path.join(directory, "remote.git");
    const previousCodexCommand = process.env["OPEN_MAINTAINER_CODEX_COMMAND"];
    const previousGhCommand = process.env["OPEN_MAINTAINER_GH_COMMAND"];
    const previousMountedRoots =
      process.env["OPEN_MAINTAINER_DASHBOARD_REPO_ROOTS"];
    const previousGitAuthorName =
      process.env["OPEN_MAINTAINER_GIT_AUTHOR_NAME"];
    const previousGitAuthorEmail =
      process.env["OPEN_MAINTAINER_GIT_AUTHOR_EMAIL"];
    const previousGhToken = process.env["GH_TOKEN"];
    try {
      await execFileAsync("git", ["init", "-b", "main", repoRoot]);
      await writeFile(
        path.join(repoRoot, "package.json"),
        JSON.stringify({
          name: "cli-dashboard-tool",
          scripts: { test: "bun test" },
        }),
      );
      await mkdir(path.join(repoRoot, "src"), { recursive: true });
      await writeFile(
        path.join(repoRoot, "src/index.ts"),
        "export const ok = true;\n",
      );
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
        {
          cwd: repoRoot,
        },
      );
      await execFileAsync("git", ["init", "--bare", remoteRoot]);
      await execFileAsync("git", ["remote", "add", "origin", remoteRoot], {
        cwd: repoRoot,
      });
      await execFileAsync("git", ["push", "-u", "origin", "main"], {
        cwd: repoRoot,
      });
      await execFileAsync("git", ["checkout", "-b", "feature/context-base"], {
        cwd: repoRoot,
      });
      await execFileAsync(
        "git",
        ["push", "-u", "origin", "feature/context-base"],
        {
          cwd: repoRoot,
        },
      );
      await writeFile(
        command,
        `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.0.0\\n");
  process.exit(0);
}
const cdIndex = process.argv.indexOf("--cd");
const repoRoot = process.argv[cdIndex + 1];
const packageJson = JSON.parse(fs.readFileSync(repoRoot + "/package.json", "utf8"));
if (packageJson.name !== "cli-dashboard-tool") {
  process.stderr.write("Codex did not run inside the uploaded repository worktree.\\n");
  process.exit(3);
}
const schemaIndex = process.argv.indexOf("--output-schema");
const schema = JSON.parse(fs.readFileSync(process.argv[schemaIndex + 1], "utf8"));
const outputIndex = process.argv.indexOf("--output-last-message");
const outputPath = process.argv[outputIndex + 1];
let output;
if (schema.required.includes("summary")) {
  output = {
    summary: "local/cli-dashboard-tool is a Bun TypeScript repository generated through the CLI provider.",
    evidenceMap: [{ claim: "Uses Bun.", evidence: ["package.json"], confidence: "observed" }],
    repositoryMap: [{ path: "src", purpose: "Source files.", evidence: ["uploaded files"], confidence: "observed" }],
    commands: [{ name: "test", command: "bun test", scope: "tests", source: "package.json", purpose: "Run tests.", confidence: "observed" }],
    setup: { requirements: [{ claim: "Install with Bun.", evidence: ["package.json"], confidence: "observed" }], unknowns: [] },
    architecture: { observed: [], inferred: [], unknowns: ["No detailed architecture was detected."] },
    changeRules: { safeEditZones: [], carefulEditZones: [], doNotEditWithoutExplicitInstruction: [], unknowns: ["Ownership was not detected."] },
    testingStrategy: { locations: [], commands: [{ name: "test", command: "bun test", scope: "tests", source: "package.json", purpose: "Run tests.", confidence: "observed" }], namingConventions: [], regressionExpectations: ["Add regression tests for changed behavior."], unknowns: [] },
    validation: { canonicalCommand: { name: "test", command: "bun test", scope: "tests", source: "package.json", purpose: "Run tests.", confidence: "observed" }, scopedCommands: [], unknowns: [] },
    prRules: ["Report validation evidence."],
    knownPitfalls: [],
    generatedFiles: [],
    highRiskAreas: [],
    documentationAlignment: [],
    unknowns: []
  };
} else if (schema.required.includes("agentsMd")) {
  const body = "Use Bun, inspect evidence, keep edits scoped, and report validation results. ".repeat(3);
  output = {
    agentsMd: "# AGENTS.md instructions for local/cli-dashboard-tool\\n\\n" + body,
    claudeMd: "# CLAUDE.md instructions for local/cli-dashboard-tool\\n\\n" + body,
    copilotInstructions: "# Copilot instructions for local/cli-dashboard-tool\\n\\n" + body,
    cursorRule: "---\\ndescription: local cli dashboard tool\\nalwaysApply: true\\n---\\n\\n" + body
  };
} else {
  output = {
    skills: [{
      path: ".agents/skills/cli-dashboard-tool-start-task/SKILL.md",
      name: "cli-dashboard-tool-start-task",
      description: "Use before changing the local CLI dashboard tool.",
      markdown: "---\\nname: cli-dashboard-tool-start-task\\ndescription: Use before changing the local CLI dashboard tool.\\n---\\n\\n# Start Task\\n\\nRead the target file, inspect related tests, keep edits scoped, and report validation evidence."
    }]
  };
}
fs.writeFileSync(outputPath, JSON.stringify(output));
`,
      );
      await chmod(command, 0o755);
      await writeFile(
        ghCommand,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write("Logged in to github.com\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const baseIndex = args.indexOf("--base");
  if (args[baseIndex + 1] !== "feature/context-base") {
    process.stderr.write("wrong base branch: " + args[baseIndex + 1]);
    process.exit(4);
  }
  process.stdout.write("https://github.com/local/cli-dashboard-tool/pull/42\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh command: " + args.join(" "));
process.exit(2);
`,
      );
      await chmod(ghCommand, 0o755);
      process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = command;
      process.env["OPEN_MAINTAINER_GH_COMMAND"] = ghCommand;
      process.env["OPEN_MAINTAINER_DASHBOARD_REPO_ROOTS"] = repoRoot;
      process.env["OPEN_MAINTAINER_GIT_AUTHOR_NAME"] = "Dashboard Bot";
      process.env["OPEN_MAINTAINER_GIT_AUTHOR_EMAIL"] = "dashboard@example.com";
      process.env["GH_TOKEN"] = "test-token";

      const repoResponse = await app.inject({
        method: "POST",
        url: "/repos/local-files",
        payload: {
          name: "cli-dashboard-tool",
          files: [
            {
              path: "package.json",
              content: JSON.stringify({
                name: "cli-dashboard-tool",
                scripts: { test: "bun test" },
              }),
            },
            { path: "src/index.ts", content: "export const ok = true;\n" },
          ],
        },
      });
      expect(repoResponse.statusCode).toBe(200);
      expect(repoResponse.json().repo.defaultBranch).toBe(
        "feature/context-base",
      );
      const repoId = repoResponse.json().repo.id;
      const analysis = await app.inject({
        method: "POST",
        url: `/repos/${repoId}/analyze`,
      });
      expect(analysis.statusCode).toBe(200);
      const provider = await app.inject({
        method: "POST",
        url: "/model-providers",
        payload: {
          kind: "codex-cli",
          displayName: "Codex CLI",
          baseUrl: "http://localhost",
          model: "codex-cli",
          apiKey: "local-cli",
          repoContentConsent: true,
        },
      });
      expect(provider.statusCode).toBe(200);

      const generated = await app.inject({
        method: "POST",
        url: `/repos/${repoId}/generate-context`,
        payload: {
          providerId: provider.json().provider.id,
          context: "both",
          skills: "both",
          async: true,
        },
      });

      expect(generated.statusCode).toBe(202);
      expect(generated.json().run.status).toBe("running");

      let artifacts: Array<{ type: string }> = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const artifactsResponse = await app.inject({
          method: "GET",
          url: `/repos/${repoId}/artifacts`,
        });
        artifacts = artifactsResponse.json().artifacts;
        if (artifacts.length > 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const run = await app.inject({
        method: "GET",
        url: `/runs/${generated.json().run.id}`,
      });

      expect(run.json().run.status).toBe("succeeded");
      expect(artifacts.map((artifact) => artifact.type)).toEqual([
        "AGENTS.md",
        "CLAUDE.md",
        ".open-maintainer.yml",
        ".agents/skills/cli-dashboard-tool-start-task/SKILL.md",
        ".claude/skills/cli-dashboard-tool-start-task/SKILL.md",
        ".open-maintainer/profile.json",
        ".open-maintainer/report.md",
      ]);

      const pr = await app.inject({
        method: "POST",
        url: `/repos/${repoId}/open-context-pr`,
        payload: {},
      });
      expect(pr.statusCode).toBe(200);
      expect(pr.json().contextPr.prUrl).toBe(
        "https://github.com/local/cli-dashboard-tool/pull/42",
      );
      const { stdout: agentsMd } = await execFileAsync(
        "git",
        ["show", "open-maintainer/context-1:AGENTS.md"],
        { cwd: repoRoot },
      );
      expect(agentsMd).toContain("cli-dashboard-tool");
      const { stdout: currentBranch } = await execFileAsync(
        "git",
        ["branch", "--show-current"],
        { cwd: repoRoot },
      );
      expect(currentBranch.trim()).toBe("feature/context-base");
      const { stdout: contextCommitAuthor } = await execFileAsync(
        "git",
        ["show", "-s", "--format=%an <%ae>", "open-maintainer/context-1"],
        { cwd: repoRoot },
      );
      expect(contextCommitAuthor.trim()).toBe(
        "Dashboard Bot <dashboard@example.com>",
      );
    } finally {
      if (previousCodexCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CODEX_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = previousCodexCommand;
      }
      if (previousGhCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_GH_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_GH_COMMAND"] = previousGhCommand;
      }
      if (previousMountedRoots === undefined) {
        Reflect.deleteProperty(
          process.env,
          "OPEN_MAINTAINER_DASHBOARD_REPO_ROOTS",
        );
      } else {
        process.env["OPEN_MAINTAINER_DASHBOARD_REPO_ROOTS"] =
          previousMountedRoots;
      }
      if (previousGitAuthorName === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_GIT_AUTHOR_NAME");
      } else {
        process.env["OPEN_MAINTAINER_GIT_AUTHOR_NAME"] = previousGitAuthorName;
      }
      if (previousGitAuthorEmail === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_GIT_AUTHOR_EMAIL");
      } else {
        process.env["OPEN_MAINTAINER_GIT_AUTHOR_EMAIL"] =
          previousGitAuthorEmail;
      }
      if (previousGhToken === undefined) {
        Reflect.deleteProperty(process.env, "GH_TOKEN");
      } else {
        process.env["GH_TOKEN"] = previousGhToken;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("opens local PRs from existing uncommitted context files", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "api-existing-context-test-"),
    );
    const ghCommand = path.join(directory, "fake-gh.js");
    const repoRoot = path.join(directory, "repo");
    const remoteRoot = path.join(directory, "remote.git");
    const previousGhCommand = process.env["OPEN_MAINTAINER_GH_COMMAND"];
    const previousMountedRoots =
      process.env["OPEN_MAINTAINER_DASHBOARD_REPO_ROOTS"];
    const previousGitAuthorName =
      process.env["OPEN_MAINTAINER_GIT_AUTHOR_NAME"];
    const previousGitAuthorEmail =
      process.env["OPEN_MAINTAINER_GIT_AUTHOR_EMAIL"];
    const previousGhToken = process.env["GH_TOKEN"];
    try {
      await execFileAsync("git", ["init", "-b", "main", repoRoot]);
      await writeFile(
        path.join(repoRoot, "package.json"),
        JSON.stringify({
          name: "existing-context-tool",
          scripts: { test: "bun test" },
        }),
      );
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
      await execFileAsync("git", ["init", "--bare", remoteRoot]);
      await execFileAsync("git", ["remote", "add", "origin", remoteRoot], {
        cwd: repoRoot,
      });
      await execFileAsync("git", ["push", "-u", "origin", "main"], {
        cwd: repoRoot,
      });
      await execFileAsync("git", ["checkout", "-b", "feature/context-base"], {
        cwd: repoRoot,
      });
      await execFileAsync(
        "git",
        ["push", "-u", "origin", "feature/context-base"],
        { cwd: repoRoot },
      );
      await mkdir(path.join(repoRoot, ".open-maintainer"), {
        recursive: true,
      });
      await writeFile(
        path.join(repoRoot, "AGENTS.md"),
        "# AGENTS.md instructions for existing-context-tool\n",
      );
      await writeFile(
        path.join(repoRoot, ".open-maintainer.yml"),
        "generated:\n  artifactVersion: 1\n",
      );
      await execFileAsync("git", ["add", "AGENTS.md", ".open-maintainer.yml"], {
        cwd: repoRoot,
      });
      await writeFile(
        ghCommand,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write("Logged in to github.com\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write("https://github.com/local/existing-context-tool/pull/43\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "edit") {
  const bodyIndex = args.indexOf("--body");
  const body = args[bodyIndex + 1] || "";
  if (body.includes("| Artifact | Version | Source |")) {
    process.stderr.write("old version column is still present");
    process.exit(4);
  }
  if (!body.includes("| Artifact | Source |")) {
    process.stderr.write("new artifact source table is missing");
    process.exit(5);
  }
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  process.stderr.write("expected existing PR to be edited");
  process.exit(6);
}
process.stderr.write("unexpected gh command: " + args.join(" "));
process.exit(2);
`,
      );
      await chmod(ghCommand, 0o755);
      process.env["OPEN_MAINTAINER_GH_COMMAND"] = ghCommand;
      process.env["OPEN_MAINTAINER_DASHBOARD_REPO_ROOTS"] = repoRoot;
      process.env["OPEN_MAINTAINER_GIT_AUTHOR_NAME"] = "Dashboard Bot";
      process.env["OPEN_MAINTAINER_GIT_AUTHOR_EMAIL"] = "dashboard@example.com";
      process.env["GH_TOKEN"] = "test-token";

      const repoResponse = await app.inject({
        method: "POST",
        url: "/repos/local-files",
        payload: {
          name: "existing-context-tool",
          files: [
            {
              path: "package.json",
              content: JSON.stringify({
                name: "existing-context-tool",
                scripts: { test: "bun test" },
              }),
            },
            {
              path: "AGENTS.md",
              content: "# AGENTS.md instructions for existing-context-tool\n",
            },
            {
              path: ".open-maintainer.yml",
              content: "generated:\n  artifactVersion: 1\n",
            },
          ],
        },
      });
      expect(repoResponse.statusCode).toBe(200);
      const repoId = repoResponse.json().repo.id;
      const analysis = await app.inject({
        method: "POST",
        url: `/repos/${repoId}/analyze`,
      });
      expect(analysis.statusCode).toBe(200);
      expect(analysis.json().profile.existingContextFiles).toEqual([
        ".open-maintainer.yml",
        "AGENTS.md",
      ]);

      const pr = await app.inject({
        method: "POST",
        url: `/repos/${repoId}/open-context-pr`,
        payload: {},
      });
      expect(pr.statusCode).toBe(200);
      expect(pr.json().contextPr.prUrl).toBe(
        "https://github.com/local/existing-context-tool/pull/43",
      );
      expect(pr.json().run.artifactVersions).toEqual([1, 2]);
      const { stdout: agentsMd } = await execFileAsync(
        "git",
        ["show", "open-maintainer/context-1:AGENTS.md"],
        { cwd: repoRoot },
      );
      expect(agentsMd).toContain("existing-context-tool");
    } finally {
      if (previousGhCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_GH_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_GH_COMMAND"] = previousGhCommand;
      }
      if (previousMountedRoots === undefined) {
        Reflect.deleteProperty(
          process.env,
          "OPEN_MAINTAINER_DASHBOARD_REPO_ROOTS",
        );
      } else {
        process.env["OPEN_MAINTAINER_DASHBOARD_REPO_ROOTS"] =
          previousMountedRoots;
      }
      if (previousGitAuthorName === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_GIT_AUTHOR_NAME");
      } else {
        process.env["OPEN_MAINTAINER_GIT_AUTHOR_NAME"] = previousGitAuthorName;
      }
      if (previousGitAuthorEmail === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_GIT_AUTHOR_EMAIL");
      } else {
        process.env["OPEN_MAINTAINER_GIT_AUTHOR_EMAIL"] =
          previousGitAuthorEmail;
      }
      if (previousGhToken === undefined) {
        Reflect.deleteProperty(process.env, "GH_TOKEN");
      } else {
        process.env["GH_TOKEN"] = previousGhToken;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists verified GitHub installation webhooks and exposes repos", async () => {
    const payload = JSON.stringify({
      installation: {
        id: 99,
        account: { login: "acme", type: "Organization" },
        repository_selection: "selected",
        permissions: { contents: "write" },
      },
      repositories: [
        { id: 100, name: "tool", full_name: "acme/tool", private: false },
      ],
    });
    const signature = `sha256=${createHmac("sha256", "dev-webhook-secret").update(payload).digest("hex")}`;

    const webhook = await app.inject({
      method: "POST",
      url: "/github/webhook",
      headers: {
        "x-hub-signature-256": signature,
        "content-type": "application/json",
      },
      payload,
    });
    const repos = await app.inject({ method: "GET", url: "/repos" });

    expect(webhook.statusCode).toBe(200);
    expect(
      repos
        .json()
        .repos.some(
          (repo: { fullName: string }) => repo.fullName === "acme/tool",
        ),
    ).toBe(true);
  });

  it("runs analysis, requires consented LLM generation, then creates artifacts", async () => {
    const analysis = await app.inject({
      method: "POST",
      url: "/repos/repo_demo/analyze",
    });
    expect(analysis.statusCode).toBe(200);
    expect(analysis.json().profile.version).toBe(1);
    expect(analysis.json().profile.agentReadiness.score).toBeGreaterThan(0);

    const providerWithoutConsent = await app.inject({
      method: "POST",
      url: "/model-providers",
      payload: {
        kind: "local-openai-compatible",
        displayName: "Local mock",
        baseUrl: "http://localhost:11434/v1",
        model: "llama3.1",
        apiKey: "dev",
        repoContentConsent: false,
      },
    });
    expect(providerWithoutConsent.statusCode).toBe(200);
    const blockedProviderId = providerWithoutConsent.json().provider.id;
    const blocked = await app.inject({
      method: "POST",
      url: "/repos/repo_demo/generate-context",
      payload: { providerId: blockedProviderId },
    });
    expect(blocked.statusCode).toBe(403);
    const retry = await app.inject({
      method: "POST",
      url: `/runs/${blocked.json().run.id}/retry`,
    });
    expect(retry.json().run.status).toBe("queued");

    const providerCalls: string[] = [];
    let providerRequestCount = 0;
    const server = createServer((request, response) => {
      let requestBody = "";
      request.on("data", (chunk) => {
        requestBody += String(chunk);
      });
      request.on("end", () => {
        providerCalls.push(requestBody);
        providerRequestCount += 1;
        const content =
          providerRequestCount === 1
            ? JSON.stringify({
                summary:
                  "demo-org/demo-repo is a Bun TypeScript repository inferred from the analyzed profile.",
                evidenceMap: [
                  {
                    claim: "Bun commands are available.",
                    evidence: ["package.json"],
                    confidence: "observed",
                  },
                ],
                repositoryMap: [
                  {
                    path: "apps",
                    purpose: "Application workspace paths.",
                    evidence: ["architecturePathGroups"],
                    confidence: "inferred",
                  },
                ],
                commands: [
                  {
                    name: "test",
                    command: "bun test",
                    scope: "tests",
                    source: "package.json",
                    purpose: "Run tests.",
                    confidence: "observed",
                  },
                ],
                setup: {
                  requirements: [
                    {
                      claim: "Use Bun for dependency and script commands.",
                      evidence: ["packageManager"],
                      confidence: "observed",
                    },
                  ],
                  unknowns: ["No environment example was detected."],
                },
                architecture: {
                  observed: [],
                  inferred: [
                    {
                      claim: "Application paths appear under apps.",
                      evidence: ["architecturePathGroups"],
                      confidence: "inferred",
                    },
                  ],
                  unknowns: ["Detailed data flow was not detected."],
                },
                changeRules: {
                  safeEditZones: [],
                  carefulEditZones: [
                    {
                      claim:
                        "Lockfiles require dependency-change justification.",
                      evidence: ["lockfiles"],
                      confidence: "inferred",
                    },
                  ],
                  doNotEditWithoutExplicitInstruction: [],
                  unknowns: ["Ownership boundaries were not detected."],
                },
                testingStrategy: {
                  locations: [],
                  commands: [
                    {
                      name: "test",
                      command: "bun test",
                      scope: "tests",
                      source: "package.json",
                      purpose: "Run tests.",
                      confidence: "observed",
                    },
                  ],
                  namingConventions: [],
                  regressionExpectations: [
                    "Add regression tests for behavior changes.",
                  ],
                  unknowns: ["Test naming conventions were not detected."],
                },
                validation: {
                  canonicalCommand: {
                    name: "test",
                    command: "bun test",
                    scope: "tests",
                    source: "package.json",
                    purpose: "Run tests.",
                    confidence: "observed",
                  },
                  scopedCommands: [],
                  unknowns: [],
                },
                prRules: ["Include test evidence in PR notes."],
                knownPitfalls: [],
                generatedFiles: [],
                highRiskAreas: [],
                documentationAlignment: [],
                unknowns: ["No PR template was detected."],
              })
            : providerRequestCount === 2
              ? JSON.stringify({
                  agentsMd:
                    "# AGENTS.md instructions for demo-org/demo-repo\n\nLLM-generated repository instructions with Bun, Fastify, Next.js, and CI context.",
                  claudeMd:
                    "# CLAUDE.md instructions for demo-org/demo-repo\n\nLLM-generated repository instructions with Bun, Fastify, Next.js, and CI context.",
                  copilotInstructions:
                    "# Copilot instructions for demo-org/demo-repo\n\nUse Bun scripts and inspect package manifests before editing.",
                  cursorRule:
                    "---\ndescription: demo repo rules\nalwaysApply: true\n---\n\nUse generated repo evidence and Bun quality gates.",
                })
              : JSON.stringify({
                  skills: [
                    {
                      path: ".agents/skills/demo-repo-start-task/SKILL.md",
                      name: "demo-repo-start-task",
                      description:
                        "Use before making bounded changes in demo-org/demo-repo.",
                      markdown:
                        "---\nname: demo-repo-start-task\ndescription: Use before making bounded changes in demo-org/demo-repo.\n---\n\n# Demo Repo Start Task\n\n## Use when\n- Starting a code or docs change.\n\n## Do not use when\n- Reviewing a PR.\n\n## Read first\n- README.md\n\n## Workflow\n- Inspect the changed surface.\n\n## Validation\n- Run bun test.\n\n## Documentation\n- Check README.md.\n\n## Risk checks\n- Keep generated context scoped.\n\n## Done when\n- Commands run are reported.",
                    },
                    {
                      path: ".agents/skills/demo-repo-testing-workflow/SKILL.md",
                      name: "demo-repo-testing-workflow",
                      description:
                        "Use when selecting validation for demo-org/demo-repo.",
                      markdown:
                        "---\nname: demo-repo-testing-workflow\ndescription: Use when selecting validation for demo-org/demo-repo.\n---\n\n# Demo Repo Testing Workflow\n\n## Use when\n- Tests or validation are changing.\n\n## Do not use when\n- Reviewing a PR.\n\n## Read first\n- package.json\n\n## Workflow\n- Map the changed surface to commands.\n\n## Validation\n- Run bun test.\n\n## Documentation\n- Check README.md.\n\n## Risk checks\n- Do not skip risky behavior tests.\n\n## Done when\n- Validation evidence is reported.",
                    },
                    {
                      path: ".agents/skills/demo-repo-pr-review/SKILL.md",
                      name: "demo-repo-pr-review",
                      description:
                        "Use when reviewing pull requests for demo-org/demo-repo.",
                      markdown:
                        "---\nname: demo-repo-pr-review\ndescription: Use when reviewing pull requests for demo-org/demo-repo.\n---\n\n# Demo Repo PR Review\n\n## Use when\n- Reviewing a completed diff.\n\n## Do not use when\n- Implementing the change.\n\n## Read first\n- The PR diff.\n\n## Workflow\n- Lead with correctness and security findings.\n\n## Validation\n- Check bun test evidence.\n\n## Documentation\n- Check README.md changes.\n\n## Risk checks\n- Watch generated context writes.\n\n## Done when\n- Findings and residual risks are clear.",
                    },
                  ],
                });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected provider test server port");
    }
    const consentedProvider = await app.inject({
      method: "POST",
      url: "/model-providers",
      payload: {
        kind: "local-openai-compatible",
        displayName: "Consented local mock",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "mock-model",
        apiKey: "dev",
        repoContentConsent: true,
      },
    });

    const generated = await app.inject({
      method: "POST",
      url: "/repos/repo_demo/generate-context",
      payload: { providerId: consentedProvider.json().provider.id },
    });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().artifacts).toHaveLength(7);
    expect(generated.json().artifacts[0].content).toContain("LLM-generated");

    const pr = await app.inject({
      method: "POST",
      url: "/repos/repo_demo/open-context-pr",
      payload: {},
    });
    expect(pr.statusCode).toBe(422);
    expect(pr.json().error).toContain("GitHub App credentials");
  });
});

async function expectPostRouteIsRateLimited(url: string): Promise<void> {
  const limitedApp = buildApp({
    authReadiness: async () => authReadinessFixture(),
  });
  await limitedApp.ready();
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await limitedApp.inject({ method: "POST", url });
      expect(response.statusCode).not.toBe(429);
    }

    const response = await limitedApp.inject({ method: "POST", url });
    expect(response.statusCode).toBe(429);
  } finally {
    await limitedApp.close();
  }
}
