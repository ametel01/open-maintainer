import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { IssueTriageResultSchema } from "@open-maintainer/shared";
import { describe, expect, it } from "vitest";
import { repoRoot, runCli } from "./helpers/cli";
import { createFakeCodexCli } from "./helpers/fake-model-cli";
import {
  createBareRemoteFromWorktree,
  createGitHubUrlRewrite,
} from "./helpers/git-url";

const execFileAsync = promisify(execFile);

async function createTriageRepo(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "om-cli-triage-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: directory,
  });
  await execFileAsync("git", ["config", "user.name", "Test User"], {
    cwd: directory,
  });
  await execFileAsync(
    "git",
    ["remote", "add", "origin", "https://github.com/acme/triage-fixture.git"],
    { cwd: directory },
  );
  await mkdir(path.join(directory, "src"), { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify(
      {
        name: "triage-fixture",
        type: "module",
        scripts: { test: "vitest run", typecheck: "tsc -b" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(directory, "README.md"),
    "# Triage fixture\n\nUse this repository to test issue triage.\n",
  );
  await writeFile(
    path.join(directory, "src", "index.ts"),
    "export function value() {\n  return 1;\n}\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], {
    cwd: directory,
  });
  return directory;
}

async function writeClosureConfig(
  repoRoot: string,
  closure: Record<string, boolean | number>,
): Promise<void> {
  await writeFile(
    path.join(repoRoot, ".open-maintainer.yml"),
    [
      "version: 1",
      "repo:",
      "  profileVersion: 2",
      "  defaultBranch: main",
      "rules: []",
      "issueTriage:",
      "  closure:",
      ...Object.entries(closure).map(([key, value]) => `    ${key}: ${value}`),
      "generated:",
      "  by: open-maintainer",
      "  artifactVersion: 3",
      '  generatedAt: "2026-04-30T00:00:00.000Z"',
      "",
    ].join("\n"),
  );
}

async function createFakeGhCli(): Promise<{
  env: Record<string, string>;
  callsPath: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "om-fake-gh-triage-"));
  const command = path.join(directory, "gh");
  const callsPath = path.join(directory, "calls.jsonl");
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const callsPath = process.env["OPEN_MAINTAINER_FAKE_GH_CALLS"];
const inputIndex = args.indexOf("--input");
const input = inputIndex >= 0 ? JSON.parse(fs.readFileSync(args[inputIndex + 1], "utf8")) : null;
fs.appendFileSync(callsPath, JSON.stringify({ args, input }) + "\\n");
function write(value) {
  process.stdout.write(JSON.stringify(value));
}
function rejectEnvTokenIfRequested() {
  if (
    process.env["OPEN_MAINTAINER_FAKE_GH_REJECT_ENV_TOKEN"] === "1" &&
    process.env["GH_TOKEN"]
  ) {
    console.error("gh: Resource not accessible by personal access token (HTTP 403)");
    process.exit(1);
  }
}
if (args[0] === "issue" && args[1] === "edit") {
  if (process.env["OPEN_MAINTAINER_FAKE_GH_LABEL_APPLY_FAIL"] === "1") {
    console.error("gh: Resource not accessible by personal access token (HTTP 403)");
    process.exit(1);
  }
  write({ number: Number(args[2]) });
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "comment") {
  if (process.env["OPEN_MAINTAINER_FAKE_GH_COMMENT_FAIL"] === "1") {
    console.error("gh: Resource not accessible by personal access token (HTTP 403)");
    process.exit(1);
  }
  process.stdout.write("https://github.com/acme/triage-fixture/issues/" + args[2] + "#issuecomment-900");
  process.exit(0);
}
if (args[0] === "label" && args[1] === "create") {
  write({ name: args[2] });
  process.exit(0);
}
if (args[0] !== "api") {
  console.error("unexpected gh args: " + args.join(" "));
  process.exit(1);
}
const endpoint = args[1];
const methodIndex = args.indexOf("--method");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
if (method === "POST" && /^repos\\/acme\\/triage-fixture\\/issues\\/\\d+\\/comments$/.test(endpoint)) {
  rejectEnvTokenIfRequested();
  if (process.env["OPEN_MAINTAINER_FAKE_GH_COMMENT_FAIL"] === "1") {
    console.error("gh: Resource not accessible by personal access token (HTTP 403)");
    process.exit(1);
  }
  write({ id: 900, html_url: "https://github.com/acme/triage-fixture/issues/42#issuecomment-900" });
  process.exit(0);
}
if (method === "POST" && endpoint === "repos/acme/triage-fixture/labels") {
  rejectEnvTokenIfRequested();
  write({ name: input.name });
  process.exit(0);
}
if (method === "POST" && /^repos\\/acme\\/triage-fixture\\/issues\\/\\d+\\/labels$/.test(endpoint)) {
  rejectEnvTokenIfRequested();
  if (process.env["OPEN_MAINTAINER_FAKE_GH_LABEL_APPLY_FAIL"] === "1") {
    console.error("gh: Resource not accessible by personal access token (HTTP 403)");
    process.exit(1);
  }
  write((input.labels ?? []).map((name) => ({ name })));
  process.exit(0);
}
if (method === "PATCH" && endpoint === "repos/acme/triage-fixture/issues/comments/901") {
  if (process.env["OPEN_MAINTAINER_FAKE_GH_COMMENT_FAIL"] === "1") {
    console.error("gh: Resource not accessible by personal access token (HTTP 403)");
    process.exit(1);
  }
  write({ id: 901, html_url: "https://github.com/acme/triage-fixture/issues/42#issuecomment-901" });
  process.exit(0);
}
if (method === "PATCH" && /^repos\\/acme\\/triage-fixture\\/issues\\/(42|43|44)$/.test(endpoint)) {
  const number = Number(endpoint.split("/").at(-1));
  write({ number, state: "closed" });
  process.exit(0);
}
if (method !== "GET") {
  console.error("unexpected mutation: " + args.join(" "));
  process.exit(1);
}
if (endpoint === "repos/acme/triage-fixture/issues") {
  const labelledFirstPage = process.env["OPEN_MAINTAINER_FAKE_GH_LABELLED_FIRST_PAGE"] === "1";
  const requestedLabelsArg = args.find((arg) => arg.startsWith("labels="));
  const requestedLabels = requestedLabelsArg ? requestedLabelsArg.replace("labels=", "").split(",").filter(Boolean) : [];
  if (labelledFirstPage && args.includes("page=1")) {
    write(Array.from({ length: 100 }, (_, index) => ({
      number: 91 + index,
      title: "Already labelled " + (index + 1),
      labels: [{ name: index % 2 === 0 ? "bug" : "triaged" }],
      pull_request: null
    })));
    process.exit(0);
  }
  if (labelledFirstPage && args.includes("page=2")) {
    write([
      { number: 42, title: "Triage one issue locally", labels: [], pull_request: null },
      { number: 43, title: "Bug: dashboard provider form accepts blank base URL", labels: [], pull_request: null },
      { number: 44, title: "Ready batch issue", labels: [], pull_request: null },
      { number: 45, title: "Rotate GitHub App webhook credentials safely", labels: [], pull_request: null },
      { number: 46, title: "Best crypto casino bonus partnership", labels: [], pull_request: null }
    ]);
    process.exit(0);
  }
  const labels = requestedLabels.map((name) => ({ name }));
  write([
    { number: 42, title: "Triage one issue locally", labels, pull_request: null },
    { number: 43, title: "Bug: dashboard provider form accepts blank base URL", labels, pull_request: null },
    { number: 44, title: "Ready batch issue", labels, pull_request: null },
    { number: 45, title: "Rotate GitHub App webhook credentials safely", labels, pull_request: null },
    { number: 46, title: "Best crypto casino bonus partnership", labels, pull_request: null },
    { number: 47, title: "Malformed provider output fixture", labels, pull_request: null },
    { number: 48, title: "Beyond requested limit", labels, pull_request: null }
  ]);
  process.exit(0);
}
if (endpoint === "repos/acme/triage-fixture/issues/42") {
  write({
    number: 42,
    title: "Triage one issue locally",
    body: "## Feature request\\nThe command should triage one issue locally and inspect \`apps/cli/src/index.ts\`.\\n\\n## Acceptance criteria\\n- The command is non-mutating by default",
    html_url: "https://github.com/acme/triage-fixture/issues/42",
    user: { login: "author" },
    labels: [{ name: "enhancement" }],
    state: "open",
    created_at: "2026-05-03T00:00:00.000Z",
    updated_at: process.env["OPEN_MAINTAINER_FAKE_ISSUE_42_UPDATED_AT"] ?? "2026-05-03T00:01:00.000Z"
  });
  process.exit(0);
}
if (endpoint === "repos/acme/triage-fixture/issues/43") {
  write({
    number: 43,
    title: "Bug: dashboard provider form accepts blank base URL",
    body: "## Bug report\\nThe dashboard provider form accepted an empty base URL, but I do not have a minimal reproduction yet.\\n\\n## Expected behavior\\nThe form should reject blank provider URLs before saving.",
    html_url: "https://github.com/acme/triage-fixture/issues/43",
    user: { login: "author" },
    labels: [{ name: "bug" }],
    state: "open",
    created_at: "2026-05-03T00:00:00.000Z",
    updated_at: "2026-05-03T00:01:00.000Z"
  });
  process.exit(0);
}
if (endpoint === "repos/acme/triage-fixture/issues/44") {
  write({
    number: 44,
    title: "Choose stale issue closure policy",
    body: "## Decision needed\\nMaintainers need to decide whether stale author-input issues can be closed automatically.\\n\\n## Acceptance criteria\\n- Policy choices are documented before implementation\\n- Closure remains opt-in",
    html_url: "https://github.com/acme/triage-fixture/issues/44",
    user: { login: "author" },
    labels: [{ name: "enhancement" }],
    state: "open",
    created_at: "2026-05-03T00:00:00.000Z",
    updated_at: "2026-05-03T00:01:00.000Z"
  });
  process.exit(0);
}
if (endpoint === "repos/acme/triage-fixture/issues/45") {
  write({
    number: 45,
    title: "Rotate GitHub App webhook credentials safely",
    body: "## Security task\\nUpdate webhook credential rotation around \`GITHUB_WEBHOOK_SECRET\` and \`packages/github/src/index.ts\`.\\n\\n## Acceptance criteria\\n- Existing webhook verification tests keep passing\\n- Manual security review is required before release",
    html_url: "https://github.com/acme/triage-fixture/issues/45",
    user: { login: "security-reviewer" },
    labels: [],
    state: "open",
    created_at: "2026-05-03T00:00:00.000Z",
    updated_at: "2026-05-03T00:01:00.000Z"
  });
  process.exit(0);
}
if (endpoint === "repos/acme/triage-fixture/issues/46") {
  write({
    number: 46,
    title: "Best crypto casino bonus partnership",
    body: "Hello maintainer, we can promote your repository with guaranteed traffic. Visit our unrelated landing page for a sponsorship package.",
    html_url: "https://github.com/acme/triage-fixture/issues/46",
    user: { login: "promo-account" },
    labels: [],
    state: "open",
    created_at: "2026-05-03T00:00:00.000Z",
    updated_at: "2026-05-03T00:01:00.000Z"
  });
  process.exit(0);
}
if (endpoint === "repos/acme/triage-fixture/issues/47") {
  write({
    number: 47,
    title: "Malformed provider output fixture",
    body: "## Fixture\\nThis realistic-looking issue intentionally drives a provider output validation failure in tests.",
    html_url: "https://github.com/acme/triage-fixture/issues/47",
    user: { login: "maintainer" },
    labels: [{ name: "test-fixture" }],
    state: "open",
    created_at: "2026-05-03T00:00:00.000Z",
    updated_at: "2026-05-03T00:01:00.000Z"
  });
  process.exit(0);
}
if (endpoint === "repos/acme/triage-fixture/issues/42/comments") {
  write([{
    id: 100,
    body: "Please include .open-maintainer/triage/issues/42.json in the artifact output.",
    html_url: "https://github.com/acme/triage-fixture/issues/42#issuecomment-100",
    user: { login: "maintainer" },
    created_at: "2026-05-03T00:02:00.000Z",
    updated_at: "2026-05-03T00:02:00.000Z"
  }]);
  process.exit(0);
}
if (endpoint === "repos/acme/triage-fixture/issues/42/comments?per_page=100") {
  if (process.env["OPEN_MAINTAINER_FAKE_EXISTING_TRIAGE_COMMENT"] === "1") {
    write([{
      id: 901,
      body: "<!-- open-maintainer:issue-triage -->\\nOld triage comment"
    }]);
  } else {
    write([]);
  }
  process.exit(0);
}
if (/^repos\\/acme\\/triage-fixture\\/issues\\/(43|44|45|46|47)\\/comments$/.test(endpoint)) {
  write([]);
  process.exit(0);
}
if (endpoint === "repos/acme/triage-fixture/labels?per_page=100") {
  write([
    { name: "needs-author-input" },
    { name: "ready-for-review" },
    { name: "agent-ready" }
  ]);
  process.exit(0);
}
if (endpoint === "repos/acme/triage-fixture/issues/42/labels?per_page=100") {
  write([{ name: "needs-author-input" }]);
  process.exit(0);
}
if (/^repos\\/acme\\/triage-fixture\\/issues\\/(43|44|45|46|47)\\/labels\\?per_page=100$/.test(endpoint)) {
  write([]);
  process.exit(0);
}
if (endpoint === "search/issues") {
  write({ items: [] });
  process.exit(0);
}
console.error("unexpected gh endpoint: " + endpoint);
process.exit(1);
`,
  );
  await chmod(command, 0o755);
  return {
    callsPath,
    env: {
      OPEN_MAINTAINER_FAKE_GH_CALLS: callsPath,
      PATH: `${directory}:${process.env["PATH"] ?? ""}`,
    },
  };
}

describe("CLI issue triage", () => {
  it("requires explicit model content-transfer consent", async () => {
    const fixture = await createTriageRepo();

    const result = await runCli([
      "triage",
      "issue",
      fixture,
      "--number",
      "42",
      "--model",
      "codex",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--allow-model-content-transfer");
  });

  it("runs single-issue triage and writes a preview artifact", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
      ],
      { ...fakeCodex.env, ...fakeGh.env },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Classification: needs_author_input");
    expect(result.stdout).toContain("Agent readiness: not_agent_ready");
    expect(result.stdout).toContain(
      "Artifact: .open-maintainer/triage/issues/42.json",
    );
    expect(result.stdout).toContain("Label actions: skipped");
    expect(result.stdout).toContain("GitHub writes: skipped");
    const artifact = JSON.parse(
      await readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    );
    const triage = IssueTriageResultSchema.parse(artifact.result);
    expect(triage.issueNumber).toBe(42);
    expect(triage.classification).toBe("needs_author_input");
    expect(
      triage.writeActions.every((action) => action.status === "skipped"),
    ).toBe(true);
    expect(artifact.input.evidence.referencedSurfaces).toContain(
      "apps/cli/src/index.ts",
    );
    expect(
      triage.writeActions.some(
        (action) =>
          action.type === "apply_label" &&
          action.status === "skipped" &&
          action.reason.includes("Label is missing"),
      ),
    ).toBe(true);
    expect(triage.commentPreview.body).toContain(
      "<!-- open-maintainer:issue-triage -->",
    );
    expect(triage.commentPreview.body).toContain("Reproduction Steps");
    expect(triage.commentPreview.body.toLowerCase()).not.toContain("used ai");
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).not.toContain('"POST"');
    expect(ghCalls).not.toContain('"PATCH"');
  });

  it("previews single-issue triage without local artifacts or GitHub writes", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--apply-labels",
        "--create-labels",
        "--post-comment",
        "--close-allowed",
        "--dry-run",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "ready",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Open Maintainer issue triage");
    expect(result.stdout).toContain("Mode: dry-run");
    expect(result.stdout).toContain(
      "Artifact: .open-maintainer/triage/issues/42.json (planned)",
    );
    expect(result.stdout).toContain("Dry run: no issue labels applied.");
    expect(result.stdout).toContain("Dry run: no issue triage comment posted.");
    expect(result.stdout).toContain("Dry run: no issue closure applied.");
    await expect(
      readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    ).rejects.toThrow();
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).not.toContain('"POST"');
    expect(ghCalls).not.toContain('"PATCH"');
  });

  it("previews single-issue triage for a GitHub URL checkout", async () => {
    const fixture = await createTriageRepo();
    const remote = await createBareRemoteFromWorktree(fixture);
    const rewrite = await createGitHubUrlRewrite({
      owner: "acme",
      repo: "triage-fixture",
      remotePath: remote,
    });
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        rewrite.url,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--dry-run",
      ],
      { ...rewrite.env, ...fakeCodex.env, ...fakeGh.env },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Open Maintainer issue triage");
    expect(result.stdout).toContain("Mode: dry-run");
    expect(result.stdout).toContain(
      "Artifact: .open-maintainer/triage/issues/42.json (planned)",
    );
    expect(result.stdout).toContain("GitHub URL workspace");
    expect(result.stdout).toContain(`Source: ${rewrite.url}`);
    expect(result.stdout).toContain(
      "Artifacts: none written because this was a dry run",
    );
    const checkoutPath = extractTemporaryCheckoutPath(result.stdout);
    expect(checkoutPath).toBeTruthy();
    await expect(readFile(checkoutPath as string, "utf8")).rejects.toThrow();
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).not.toContain('"POST"');
    expect(ghCalls).not.toContain('"PATCH"');
  });

  it("requires label application before creating missing labels", async () => {
    const fixture = await createTriageRepo();

    const result = await runCli([
      "triage",
      "issue",
      fixture,
      "--number",
      "42",
      "--model",
      "codex",
      "--allow-model-content-transfer",
      "--create-labels",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--create-labels requires --apply-labels");
  });

  it("creates missing issue labels and applies labels only when requested", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--apply-labels",
        "--create-labels",
      ],
      { ...fakeCodex.env, ...fakeGh.env },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const artifact = JSON.parse(
      await readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    );
    const triage = IssueTriageResultSchema.parse(artifact.result);
    expect(
      triage.writeActions.some(
        (action) =>
          action.type === "create_label" &&
          action.status === "applied" &&
          action.target === "needs-reproduction",
      ),
    ).toBe(true);
    expect(
      triage.writeActions.some(
        (action) =>
          action.type === "apply_label" &&
          action.status === "skipped" &&
          action.target === "needs-author-input",
      ),
    ).toBe(true);
    expect(
      triage.writeActions.some(
        (action) =>
          action.type === "apply_label" &&
          action.status === "applied" &&
          action.target === "needs-reproduction",
      ),
    ).toBe(true);
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).toContain("repos/acme/triage-fixture/labels");
    expect(ghCalls).toContain('"needs-reproduction"');
    expect(ghCalls).toContain("repos/acme/triage-fixture/issues/42/labels");
    expect(ghCalls).not.toContain('"issue","edit"');
    expect(ghCalls).not.toContain("/pulls/");
  });

  it("records issue label write failures without losing triage output", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--apply-labels",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "ready",
        OPEN_MAINTAINER_FAKE_GH_LABEL_APPLY_FAIL: "1",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Classification: ready_for_maintainer_review",
    );
    expect(result.stdout).toContain("Label actions: failed");
    expect(result.stdout).toContain("GitHub writes: failed");
    const artifact = JSON.parse(
      await readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    );
    const triage = IssueTriageResultSchema.parse(artifact.result);
    expect(
      triage.writeActions.some(
        (action) =>
          action.type === "apply_label" &&
          action.status === "failed" &&
          action.reason.includes("Resource not accessible"),
      ),
    ).toBe(true);
  });

  it("does not pass local GH_TOKEN to gh writes by default", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--apply-labels",
        "--create-labels",
        "--post-comment",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        CI: "false",
        GITHUB_ACTIONS: "false",
        GH_TOKEN: "read-only-env-token",
        OPEN_MAINTAINER_FAKE_GH_REJECT_ENV_TOKEN: "1",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("GitHub writes: applied");
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).toContain("repos/acme/triage-fixture/issues/42/labels");
    expect(ghCalls).toContain("repos/acme/triage-fixture/issues/42/comments");
  });

  it("posts a marked deterministic issue triage comment only when requested", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--post-comment",
      ],
      { ...fakeCodex.env, ...fakeGh.env },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const artifact = JSON.parse(
      await readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    );
    const triage = IssueTriageResultSchema.parse(artifact.result);
    expect(
      triage.writeActions.some(
        (action) =>
          action.type === "post_comment" && action.status === "applied",
      ),
    ).toBe(true);
    expect(triage.commentPreview.body).toContain("Requested Author Actions");
    expect(triage.commentPreview.body.toLowerCase()).not.toContain(
      "authorship",
    );
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).toContain("repos/acme/triage-fixture/issues/42/comments");
    expect(ghCalls).not.toContain('"issue","comment"');
  });

  it("records issue comment write failures without losing batch triage output", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issues",
        fixture,
        "--state",
        "open",
        "--limit",
        "2",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--post-comment",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_GH_COMMENT_FAIL: "1",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Scanned 2 open issues");
    expect(result.stdout).toContain("GitHub writes: failed");
    expect(result.stdout).not.toContain("#42 Triage one issue locally: error:");
    expect(result.stdout).not.toContain(
      "#43 Bug: dashboard provider form accepts blank base URL: error:",
    );
    const artifact = JSON.parse(
      await readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    );
    const triage = IssueTriageResultSchema.parse(artifact.result);
    expect(
      triage.writeActions.some(
        (action) =>
          action.type === "post_comment" &&
          action.status === "failed" &&
          action.reason.includes("Resource not accessible"),
      ),
    ).toBe(true);
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).toContain("repos/acme/triage-fixture/issues/42/comments");
  });

  it("updates an existing marked issue triage comment instead of duplicating", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--post-comment",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_EXISTING_TRIAGE_COMMENT: "1",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const artifact = JSON.parse(
      await readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    );
    const triage = IssueTriageResultSchema.parse(artifact.result);
    expect(
      triage.writeActions.some(
        (action) =>
          action.type === "update_comment" && action.status === "applied",
      ),
    ).toBe(true);
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).toContain("repos/acme/triage-fixture/issues/comments/901");
    expect(ghCalls).toContain("PATCH");
  });

  it("skips issue closure without both CLI and config approval", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const withoutFlag = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "spam",
      },
    );

    expect(withoutFlag.exitCode).toBe(0);
    expect(withoutFlag.stdout).toContain(
      "Closure action: skipped issue:42 (Closure requires explicit --close-allowed.)",
    );

    const withoutConfig = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--close-allowed",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "spam",
      },
    );

    expect(withoutConfig.exitCode).toBe(0);
    expect(withoutConfig.stdout).toContain(
      "Closure action: skipped issue:42 (Closure requires .open-maintainer.yml issueTriage.closure config.)",
    );
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).not.toContain('"PATCH"');
  });

  it("closes possible spam only after posting the configured public comment", async () => {
    const fixture = await createTriageRepo();
    await writeClosureConfig(fixture, {
      allowPossibleSpam: true,
      maxClosuresPerRun: 1,
      requireCommentBeforeClose: true,
    });
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--post-comment",
        "--close-allowed",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "spam",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Classification: possibly_spam");
    expect(result.stdout).toContain("Closure action: applied issue:42");
    const artifact = JSON.parse(
      await readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    );
    const triage = IssueTriageResultSchema.parse(artifact.result);
    expect(
      triage.writeActions.some(
        (action) =>
          action.type === "post_comment" && action.status === "applied",
      ),
    ).toBe(true);
    expect(
      triage.writeActions.some(
        (action) =>
          action.type === "close_issue" && action.status === "applied",
      ),
    ).toBe(true);
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).toContain("repos/acme/triage-fixture/issues/42/comments");
    expect(ghCalls).toContain("repos/acme/triage-fixture/issues/42");
    expect(ghCalls).toContain("PATCH");
  });

  it("requires the configured public comment before issue closure", async () => {
    const fixture = await createTriageRepo();
    await writeClosureConfig(fixture, {
      allowPossibleSpam: true,
      maxClosuresPerRun: 1,
      requireCommentBeforeClose: true,
    });
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--close-allowed",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "spam",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Closure action: skipped issue:42 (Closure requires a posted or updated public triage comment.)",
    );
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).not.toContain('"PATCH"');
  });

  it("does not close fresh needs-author-input issues", async () => {
    const fixture = await createTriageRepo();
    await writeClosureConfig(fixture, {
      allowStaleAuthorInput: true,
      staleAuthorInputDays: 14,
      maxClosuresPerRun: 1,
      requireCommentBeforeClose: true,
    });
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--post-comment",
        "--close-allowed",
      ],
      { ...fakeCodex.env, ...fakeGh.env },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Closure action: skipped issue:42 (needs_author_input issue is not stale enough to close.)",
    );
    const artifact = JSON.parse(
      await readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    );
    const triage = IssueTriageResultSchema.parse(artifact.result);
    expect(
      triage.writeActions.some(
        (action) =>
          action.type === "close_issue" &&
          action.status === "skipped" &&
          action.reason.includes("not stale enough"),
      ),
    ).toBe(true);
  });

  it("closes stale needs-author-input issues when guardrails pass", async () => {
    const fixture = await createTriageRepo();
    await writeClosureConfig(fixture, {
      allowStaleAuthorInput: true,
      staleAuthorInputDays: 14,
      maxClosuresPerRun: 1,
      requireCommentBeforeClose: true,
    });
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--post-comment",
        "--close-allowed",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_ISSUE_42_UPDATED_AT: "2026-04-01T00:01:00.000Z",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Closure action: applied issue:42");
    const artifact = JSON.parse(
      await readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    );
    const triage = IssueTriageResultSchema.parse(artifact.result);
    expect(
      triage.writeActions.some(
        (action) =>
          action.type === "close_issue" && action.status === "applied",
      ),
    ).toBe(true);
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).toContain("repos/acme/triage-fixture/issues/42");
    expect(ghCalls).toContain("PATCH");
  });

  it("enforces the configured closure cap across batch triage", async () => {
    const fixture = await createTriageRepo();
    await writeClosureConfig(fixture, {
      allowPossibleSpam: true,
      maxClosuresPerRun: 1,
      requireCommentBeforeClose: false,
    });
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issues",
        fixture,
        "--state",
        "open",
        "--limit",
        "2",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--close-allowed",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "spam",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const issue42 = IssueTriageResultSchema.parse(
      JSON.parse(
        await readFile(
          path.join(fixture, ".open-maintainer/triage/issues/42.json"),
          "utf8",
        ),
      ).result,
    );
    const issue43 = IssueTriageResultSchema.parse(
      JSON.parse(
        await readFile(
          path.join(fixture, ".open-maintainer/triage/issues/43.json"),
          "utf8",
        ),
      ).result,
    );
    expect(
      issue42.writeActions.some(
        (action) =>
          action.type === "close_issue" && action.status === "applied",
      ),
    ).toBe(true);
    expect(
      issue43.writeActions.some(
        (action) =>
          action.type === "close_issue" &&
          action.status === "skipped" &&
          action.reason.includes("Closure cap reached"),
      ),
    ).toBe(true);
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(
      ghCalls
        .split("\n")
        .filter((line) => line.includes("repos/acme/triage-fixture/issues/42"))
        .filter((line) => line.includes('"PATCH"')).length,
    ).toBe(1);
    expect(
      ghCalls
        .split("\n")
        .filter((line) => line.includes("repos/acme/triage-fixture/issues/43"))
        .filter((line) => line.includes('"PATCH"')).length,
    ).toBe(0);
  });

  it("runs bounded batch triage with grouped reports and per-issue errors", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issues",
        fixture,
        "--state",
        "open",
        "--limit",
        "3",
        "--label",
        "enhancement",
        "--model",
        "codex",
        "--allow-model-content-transfer",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "mixed",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Scanned 3 open issues");
    expect(
      result.stdout.indexOf("## Ready for maintainer review"),
    ).toBeLessThan(result.stdout.indexOf("## Needs author input"));
    expect(result.stdout).toContain("#44 Choose stale issue closure policy");
    expect(result.stdout).toContain(
      "#43 Bug: dashboard provider form accepts blank base URL: error:",
    );
    const jsonPath = result.stdout
      .split("\n")
      .find((line) => line.startsWith("JSON report: "))
      ?.replace("JSON report: ", "");
    const markdownPath = result.stdout
      .split("\n")
      .find((line) => line.startsWith("Markdown report: "))
      ?.replace("Markdown report: ", "");
    expect(jsonPath).toBeTruthy();
    expect(markdownPath).toBeTruthy();
    const report = JSON.parse(
      await readFile(path.join(fixture, jsonPath as string), "utf8"),
    );
    expect(report.limit).toBe(3);
    expect(report.label).toBe("enhancement");
    expect(
      report.issues.map((issue: { issueNumber: number }) => issue.issueNumber),
    ).toEqual([42, 43, 44]);
    expect(
      report.issues.find(
        (issue: { issueNumber: number }) => issue.issueNumber === 43,
      ).status,
    ).toBe("failed");
    expect(
      report.issues.find(
        (issue: { issueNumber: number }) => issue.issueNumber === 44,
      ).classification,
    ).toBe("ready_for_maintainer_review");
    const markdown = await readFile(
      path.join(fixture, markdownPath as string),
      "utf8",
    );
    expect(markdown).toContain("## Ready for maintainer review");
    expect(markdown).toContain("## Errors");
    expect(
      await readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    ).toContain("needs_author_input");
    await expect(
      readFile(
        path.join(fixture, ".open-maintainer/triage/issues/45.json"),
        "utf8",
      ),
    ).rejects.toThrow();
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).toContain(
      'repos/acme/triage-fixture/issues","--method","GET"',
    );
    expect(ghCalls).toContain("state=open");
    expect(ghCalls).toContain("per_page=100");
    expect(ghCalls).toContain("labels=enhancement");
    expect(ghCalls).not.toContain('"POST"');
    expect(ghCalls).not.toContain('"PATCH"');
  });

  it("previews batch triage without run reports or GitHub writes", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issues",
        fixture,
        "--state",
        "open",
        "--limit",
        "2",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--apply-labels",
        "--post-comment",
        "--dry-run",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "ready",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Open Maintainer issue triage batch");
    expect(result.stdout).toContain("Mode: dry-run");
    expect(result.stdout).toContain("Scanned 2 open issues");
    expect(result.stdout).toContain(
      "JSON report: .open-maintainer/triage/runs/",
    );
    expect(result.stdout).toContain("(planned)");
    expect(result.stdout).toContain(
      "Dry run: no triage artifacts, reports, or GitHub writes applied.",
    );
    await expect(
      readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    ).rejects.toThrow();
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).not.toContain('"POST"');
    expect(ghCalls).not.toContain('"PATCH"');
  });

  it("previews batch issue triage for a GitHub URL checkout", async () => {
    const fixture = await createTriageRepo();
    const remote = await createBareRemoteFromWorktree(fixture);
    const rewrite = await createGitHubUrlRewrite({
      owner: "acme",
      repo: "triage-fixture",
      remotePath: remote,
    });
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issues",
        rewrite.url,
        "--limit",
        "5",
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--dry-run",
      ],
      {
        ...rewrite.env,
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "all-classifications",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Open Maintainer issue triage batch");
    expect(result.stdout).toContain("Mode: dry-run");
    expect(result.stdout).toContain("Scanned 5 open issues");
    expect(result.stdout).toContain("#46 Best crypto casino bonus partnership");
    expect(result.stdout).toContain("GitHub URL workspace");
    expect(result.stdout).toContain(`Source: ${rewrite.url}`);
    const checkoutPath = extractTemporaryCheckoutPath(result.stdout);
    expect(checkoutPath).toBeTruthy();
    await expect(readFile(checkoutPath as string, "utf8")).rejects.toThrow();
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).not.toContain('"POST"');
    expect(ghCalls).not.toContain('"PATCH"');
  });

  it("skips already labelled issues and keeps paging until the batch limit is filled", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issues",
        fixture,
        "--state",
        "open",
        "--limit",
        "5",
        "--model",
        "codex",
        "--allow-model-content-transfer",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_GH_LABELLED_FIRST_PAGE: "1",
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "all-classifications",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Scanned 5 open issues");
    expect(result.stdout).toContain("#42 Triage one issue locally");
    expect(result.stdout).toContain("#46 Best crypto casino bonus partnership");
    expect(result.stdout).not.toContain("#91 Already labelled one");
    expect(result.stdout).not.toContain("#95 Already labelled five");
    const jsonPath = result.stdout
      .split("\n")
      .find((line) => line.startsWith("JSON report: "))
      ?.replace("JSON report: ", "");
    expect(jsonPath).toBeTruthy();
    const report = JSON.parse(
      await readFile(path.join(fixture, jsonPath as string), "utf8"),
    );
    expect(
      report.issues.map((issue: { issueNumber: number }) => issue.issueNumber),
    ).toEqual([42, 43, 44, 45, 46]);
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).toContain("page=1");
    expect(ghCalls).toContain("page=2");
  });

  it("covers every issue triage classification with realistic mock issues", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issues",
        fixture,
        "--state",
        "open",
        "--limit",
        "6",
        "--model",
        "codex",
        "--allow-model-content-transfer",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "all-classifications",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Scanned 6 open issues");
    expect(result.stdout).toContain("#42 Triage one issue locally: score 91");
    expect(result.stdout).toContain(
      "#43 Bug: dashboard provider form accepts blank base URL: score 38",
    );
    expect(result.stdout).toContain(
      "#44 Choose stale issue closure policy: score 62",
    );
    expect(result.stdout).toContain(
      "#45 Rotate GitHub App webhook credentials safely: score 34",
    );
    expect(result.stdout).toContain(
      "#46 Best crypto casino bonus partnership: score 12",
    );
    expect(result.stdout).toContain(
      "#47 Malformed provider output fixture: error:",
    );

    const jsonPath = result.stdout
      .split("\n")
      .find((line) => line.startsWith("JSON report: "))
      ?.replace("JSON report: ", "");
    expect(jsonPath).toBeTruthy();
    const report = JSON.parse(
      await readFile(path.join(fixture, jsonPath as string), "utf8"),
    );
    expect(
      report.issues
        .filter((issue: { status: string }) => issue.status === "succeeded")
        .map((issue: { classification: string }) => issue.classification)
        .sort(),
    ).toEqual([
      "needs_author_input",
      "needs_human_design",
      "not_actionable",
      "possibly_spam",
      "ready_for_maintainer_review",
    ]);
    expect(
      report.issues.find(
        (issue: { issueNumber: number }) => issue.issueNumber === 47,
      ).status,
    ).toBe("failed");
    expect(
      IssueTriageResultSchema.parse(
        JSON.parse(
          await readFile(
            path.join(fixture, ".open-maintainer/triage/issues/45.json"),
            "utf8",
          ),
        ).result,
      ).signals,
    ).toContain("not_actionable");
    const ghCalls = await readFile(fakeGh.callsPath, "utf8");
    expect(ghCalls).toContain(
      'repos/acme/triage-fixture/issues","--method","GET"',
    );
    expect(ghCalls).toContain("per_page=100");
    expect(ghCalls).not.toContain('"POST"');
    expect(ghCalls).not.toContain('"PATCH"');
  });

  it("generates an agent-safe task brief from an agent-ready local artifact", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const triage = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "ready",
      },
    );
    expect(triage.exitCode).toBe(0);

    const result = await runCli([
      "triage",
      "brief",
      fixture,
      "--number",
      "42",
      "--output-path",
      ".open-maintainer/triage/issues/42-brief.md",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Task brief: generated");
    expect(result.stdout).toContain("## Validation");
    const artifact = JSON.parse(
      await readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    );
    const parsed = IssueTriageResultSchema.parse(artifact.result);
    expect(parsed.taskBrief.status).toBe("generated");
    expect(parsed.taskBrief.goal).toContain("#42");
    expect(parsed.taskBrief.likelyFiles).toContain("apps/cli/src/index.ts");
    expect(
      parsed.taskBrief.validationCommands.map((command) => command.command),
    ).toContain("vitest run");
    const markdown = await readFile(
      path.join(fixture, ".open-maintainer/triage/issues/42-brief.md"),
      "utf8",
    );
    expect(markdown).toContain("Open Maintainer Agent Task Brief");
  });

  it("previews task briefs without updating artifacts or writing markdown", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const triage = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "ready",
      },
    );
    expect(triage.exitCode).toBe(0);

    const before = await readFile(
      path.join(fixture, ".open-maintainer/triage/issues/42.json"),
      "utf8",
    );
    const result = await runCli([
      "triage",
      "brief",
      fixture,
      "--number",
      "42",
      "--output-path",
      ".open-maintainer/triage/issues/42-brief.md",
      "--dry-run",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Open Maintainer triage brief");
    expect(result.stdout).toContain("Mode: dry-run");
    expect(result.stdout).toContain(
      "Artifact: .open-maintainer/triage/issues/42.json (unchanged)",
    );
    expect(result.stdout).toContain(
      "Markdown: .open-maintainer/triage/issues/42-brief.md (planned)",
    );
    expect(result.stdout).toContain(
      "Dry run: no task brief artifact or markdown file written.",
    );
    const after = await readFile(
      path.join(fixture, ".open-maintainer/triage/issues/42.json"),
      "utf8",
    );
    expect(after).toBe(before);
    await expect(
      readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42-brief.md"),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it("requires an override before briefing non-agent-ready issues", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const triage = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
      ],
      { ...fakeCodex.env, ...fakeGh.env },
    );
    expect(triage.exitCode).toBe(0);

    const withoutOverride = await runCli([
      "triage",
      "brief",
      fixture,
      "--number",
      "42",
    ]);

    expect(withoutOverride.exitCode).toBe(1);
    expect(withoutOverride.stderr).toContain("--allow-non-agent-ready");

    const withOverride = await runCli([
      "triage",
      "brief",
      fixture,
      "--number",
      "42",
      "--allow-non-agent-ready",
    ]);

    expect(withOverride.exitCode).toBe(0);
    expect(withOverride.stdout).toContain("Task brief: generated");
    const artifact = JSON.parse(
      await readFile(
        path.join(fixture, ".open-maintainer/triage/issues/42.json"),
        "utf8",
      ),
    );
    const parsed = IssueTriageResultSchema.parse(artifact.result);
    expect(parsed.taskBrief.status).toBe("generated");
    expect(parsed.taskBrief.safetyNotes.join(" ")).toContain("Override path");
  });

  it("rejects invalid issue triage model JSON", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "invalid-json",
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid issue triage model output");
  });

  it("rejects issue triage model output without evidence citations", async () => {
    const fixture = await createTriageRepo();
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli();

    const result = await runCli(
      [
        "triage",
        "issue",
        fixture,
        "--number",
        "42",
        "--model",
        "codex",
        "--allow-model-content-transfer",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE: "no-evidence",
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid issue triage model output");
    expect(result.stderr).toContain("evidence");
  });
});

function extractTemporaryCheckoutPath(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .find((item) => item.includes("Temporary checkout:"));
  return (
    line
      ?.replace(/^.*Temporary checkout: /, "")
      .replace(/ \(removed\).*$/, "")
      .trim() ?? null
  );
}
