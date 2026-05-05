import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ReviewResultSchema } from "@open-maintainer/shared";
import { describe, expect, it } from "vitest";
import { repoRoot, runCli } from "./helpers/cli";
import { createFakeCodexCli } from "./helpers/fake-model-cli";
import { createGitHubUrlRewrite } from "./helpers/git-url";

const execFileAsync = promisify(execFile);

async function createReviewRepo(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "om-cli-review-"));
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
    JSON.stringify(
      {
        name: "cli-review-fixture",
        type: "module",
        scripts: { test: "vitest run", typecheck: "tsc -b" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(directory, "src", "index.ts"),
    "export function value() {\n  return 1;\n}\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });
  await writeFile(
    path.join(directory, "src", "index.ts"),
    "export function value() {\n  return 2;\n}\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "change value"], {
    cwd: directory,
  });
  return directory;
}

async function attachPullRequestRemote(
  directory: string,
  prNumber: number,
): Promise<{ baseSha: string; headSha: string; remotePath: string }> {
  const remote = await mkdtemp(path.join(tmpdir(), "om-cli-review-remote-"));
  await execFileAsync("git", ["init", "--bare"], { cwd: remote });
  await execFileAsync("git", ["remote", "add", "origin", remote], {
    cwd: directory,
  });
  await execFileAsync("git", ["push", "origin", "main"], { cwd: directory });
  const { stdout: baseSha } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD~1"],
    { cwd: directory },
  );
  const { stdout: headSha } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: directory },
  );
  await execFileAsync(
    "git",
    ["update-ref", `refs/pull/${prNumber}/head`, headSha.trim()],
    { cwd: remote },
  );
  return {
    baseSha: baseSha.trim(),
    headSha: headSha.trim(),
    remotePath: remote,
  };
}

async function createFakeGhCli(input: {
  prNumber: number;
  baseSha: string;
  headSha: string;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollup?: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    detailsUrl: string;
  }>;
}): Promise<{ env: Record<string, string>; callsPath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "om-fake-gh-"));
  const command = path.join(directory, "gh");
  const callsPath = path.join(directory, "calls.jsonl");
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const callsPath = process.env.OPEN_MAINTAINER_FAKE_GH_CALLS;
function write(value) {
  process.stdout.write(JSON.stringify(value));
}
function record(kind, endpoint, inputPath) {
  const input = inputPath ? JSON.parse(fs.readFileSync(inputPath, "utf8")) : null;
  fs.appendFileSync(callsPath, JSON.stringify({ kind, endpoint, input }) + "\\n");
}
if (args[0] === "repo" && args[1] === "view") {
  write({ owner: { login: "Open-Maintainer" }, name: "cli-review-fixture" });
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  write({
    number: ${input.prNumber},
    title: "Review fixture PR",
    body: "Acceptance criteria: keep the value intentional.",
    url: "https://github.com/Open-Maintainer/cli-review-fixture/pull/${input.prNumber}",
    author: { login: "maintainer" },
    isDraft: ${JSON.stringify(input.isDraft ?? false)},
    mergeable: ${JSON.stringify(input.mergeable ?? "MERGEABLE")},
    mergeStateStatus: ${JSON.stringify(input.mergeStateStatus ?? "CLEAN")},
    reviewDecision: ${JSON.stringify(input.reviewDecision ?? "REVIEW_REQUIRED")},
    baseRefName: "main",
    headRefName: "feature",
    baseRefOid: "${input.baseSha}",
    headRefOid: "${input.headSha}",
    comments: [],
    statusCheckRollup: ${JSON.stringify(input.statusCheckRollup ?? [{ name: "Tests", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://example.test/check" }])}
  });
  process.exit(0);
}
if (args[0] === "label" && args[1] === "create") {
  fs.appendFileSync(callsPath, JSON.stringify({ kind: "label_create", args }) + "\\n");
  write({ name: args[2] });
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "edit") {
  fs.appendFileSync(callsPath, JSON.stringify({ kind: "issue_edit", args }) + "\\n");
  write({ number: Number(args[2]) });
  process.exit(0);
}
if (args[0] === "api") {
  const endpoint = args[1];
  const inputIndex = args.indexOf("--input");
  const methodIndex = args.indexOf("--method");
  const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
  if (method === "GET") {
    write([]);
    process.exit(0);
  }
  record(method, endpoint, inputIndex >= 0 ? args[inputIndex + 1] : null);
  write({ ok: true });
  process.exit(0);
}
console.error("unexpected gh args: " + args.join(" "));
process.exit(1);
`,
  );
  await chmod(command, 0o755);
  return {
    callsPath,
    env: {
      OPEN_MAINTAINER_FAKE_GH_CALLS: callsPath,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
    },
  };
}

describe("CLI review", () => {
  it("writes markdown output without GitHub credentials", async () => {
    const fixture = await createReviewRepo();
    const outputPath = ".open-maintainer/review.md";
    const fakeCodex = await createFakeCodexCli();

    const result = await runCli(
      [
        "review",
        fixture,
        "--base-ref",
        "HEAD~1",
        "--head-ref",
        "HEAD",
        "--pr-number",
        "44",
        "--output-path",
        outputPath,
        "--model",
        "codex",
        "--allow-model-content-transfer",
      ],
      fakeCodex.env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Review: .open-maintainer/review.md");
    const markdown = await readFile(path.join(fixture, outputPath), "utf8");
    expect(markdown).toContain("## OpenMaintainer Review #44");
    expect(markdown).toContain("### Contribution Triage");
    expect(markdown).toContain("Category: **Ready For Review**");
    expect(markdown).toContain("### Required Validation For This PR");
    expect(markdown).toContain("src/index.ts");
  });

  it("previews review output files without writing them in dry-run mode", async () => {
    const fixture = await createReviewRepo();
    const outputPath = ".open-maintainer/review.md";
    const fakeCodex = await createFakeCodexCli();

    const result = await runCli(
      [
        "review",
        fixture,
        "--base-ref",
        "HEAD~1",
        "--head-ref",
        "HEAD",
        "--output-path",
        outputPath,
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--dry-run",
      ],
      fakeCodex.env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Open Maintainer review");
    expect(result.stdout).toContain(
      "Review: .open-maintainer/review.md (planned)",
    );
    expect(result.stdout).toContain("Dry run: no review file written.");
    await expect(
      readFile(path.join(fixture, outputPath), "utf8"),
    ).rejects.toThrow();
  });

  it("prints ReviewResult JSON", async () => {
    const fixture = await createReviewRepo();
    const fakeCodex = await createFakeCodexCli();

    const result = await runCli(
      [
        "review",
        fixture,
        "--base-ref",
        "HEAD~1",
        "--head-ref",
        "HEAD",
        "--json",
        "--model",
        "codex",
        "--allow-model-content-transfer",
      ],
      fakeCodex.env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const review = ReviewResultSchema.parse(JSON.parse(result.stdout));
    expect(review.changedFiles.map((file) => file.path)).toEqual([
      "src/index.ts",
    ]);
    expect(review.contributionTriage.category).toBe("ready_for_review");
    expect(review.modelProvider).toBe("Codex CLI");
  });

  it("prints actionable errors for missing refs", async () => {
    const fixture = await createReviewRepo();

    const result = await runCli([
      "review",
      fixture,
      "--base-ref",
      "missing-ref",
      "--head-ref",
      "HEAD",
      "--model",
      "codex",
      "--allow-model-content-transfer",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Unable to assemble review diff for missing-ref...HEAD",
    );
    expect(result.stderr).toContain("Verify --base-ref and --head-ref");
  });

  it("requires explicit content-transfer consent for provider review", async () => {
    const fixture = await createReviewRepo();

    const result = await runCli([
      "review",
      fixture,
      "--base-ref",
      "HEAD~1",
      "--head-ref",
      "HEAD",
      "--model",
      "codex",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "--model requires --allow-model-content-transfer",
    );
  });

  it("requires a model provider before review operation execution", async () => {
    const fixture = await createReviewRepo();

    const result = await runCli([
      "review",
      fixture,
      "--base-ref",
      "HEAD~1",
      "--head-ref",
      "HEAD",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "review requires --model codex or --model claude",
    );
  });

  it("keeps review-specific provider flags as backwards-compatible aliases", async () => {
    const fixture = await createReviewRepo();
    const fakeCodex = await createFakeCodexCli();

    const result = await runCli(
      [
        "review",
        fixture,
        "--base-ref",
        "HEAD~1",
        "--head-ref",
        "HEAD",
        "--json",
        "--review-provider",
        "codex",
        "--review-model",
        "gpt-test",
        "--allow-model-content-transfer",
      ],
      fakeCodex.env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const review = ReviewResultSchema.parse(JSON.parse(result.stdout));
    expect(review.modelProvider).toBe("Codex CLI");
  });

  it("rejects conflicting review provider flag aliases", async () => {
    const fixture = await createReviewRepo();

    const result = await runCli([
      "review",
      fixture,
      "--base-ref",
      "HEAD~1",
      "--head-ref",
      "HEAD",
      "--model",
      "codex",
      "--review-provider",
      "claude",
      "--allow-model-content-transfer",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--model and --review-provider disagree");
  });

  it("rejects conflicting review model override aliases", async () => {
    const fixture = await createReviewRepo();

    const result = await runCli([
      "review",
      fixture,
      "--base-ref",
      "HEAD~1",
      "--head-ref",
      "HEAD",
      "--model",
      "codex",
      "--llm-model",
      "gpt-a",
      "--review-model",
      "gpt-b",
      "--allow-model-content-transfer",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--llm-model and --review-model disagree");
  });

  it("fetches a pull request with gh and posts summary plus inline review comments", async () => {
    const fixture = await createReviewRepo();
    const prNumber = 12;
    const refs = await attachPullRequestRemote(fixture, prNumber);
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli({ prNumber, ...refs });

    const result = await runCli(
      [
        "review",
        fixture,
        "--pr",
        String(prNumber),
        "--model",
        "codex",
        "--allow-model-content-transfer",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_FINDING: "1",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Review generated for pull request #12.");
    expect(result.stdout).toContain(
      "PR comments posted: summary comment, 1 inline comment.",
    );
    expect(result.stdout).not.toContain("## OpenMaintainer Review #12");
    expect(result.stdout).not.toContain("### Findings");

    const calls = (await readFile(fakeGh.callsPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { endpoint: string; input: unknown });
    expect(calls).toHaveLength(2);
    expect(calls[0].endpoint).toBe(
      "repos/Open-Maintainer/cli-review-fixture/issues/12/comments",
    );
    expect(JSON.stringify(calls[0].input)).toContain(
      "open-maintainer-review-summary",
    );
    expect(calls[1].endpoint).toBe(
      "repos/Open-Maintainer/cli-review-fixture/pulls/12/reviews",
    );
    expect(JSON.stringify(calls[1].input)).toContain(
      "open-maintainer-review-inline",
    );
    expect(JSON.stringify(calls[1].input)).toContain(
      "Add or adjust tests and confirm the changed value is intended.",
    );
  });

  it("previews pull request reviews without posting GitHub comments", async () => {
    const fixture = await createReviewRepo();
    const prNumber = 12;
    const refs = await attachPullRequestRemote(fixture, prNumber);
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli({ prNumber, ...refs });

    const result = await runCli(
      [
        "review",
        fixture,
        "--pr",
        String(prNumber),
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--dry-run",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_FINDING: "1",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Open Maintainer review");
    expect(result.stdout).toContain("Mode: dry-run");
    expect(result.stdout).toContain("Review generated for pull request #12.");
    expect(result.stdout).toContain("Dry run: no PR comments posted.");
    const calls = await readFile(fakeGh.callsPath, "utf8").catch(() => "");
    expect(calls).not.toContain(
      "repos/Open-Maintainer/cli-review-fixture/issues/12/comments",
    );
    expect(calls).not.toContain(
      "repos/Open-Maintainer/cli-review-fixture/pulls/12/reviews",
    );
  });

  it("reviews a GitHub URL pull request from a temporary checkout", async () => {
    const fixture = await createReviewRepo();
    const prNumber = 12;
    const refs = await attachPullRequestRemote(fixture, prNumber);
    const rewrite = await createGitHubUrlRewrite({
      owner: "Open-Maintainer",
      repo: "cli-review-fixture",
      remotePath: refs.remotePath,
    });
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli({ prNumber, ...refs });

    const result = await runCli(
      [
        "review",
        rewrite.url,
        "--pr",
        String(prNumber),
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--dry-run",
      ],
      {
        ...rewrite.env,
        ...fakeCodex.env,
        ...fakeGh.env,
        OPEN_MAINTAINER_FAKE_CODEX_FINDING: "1",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Review generated for pull request #12.");
    expect(result.stdout).toContain("Dry run: no PR comments posted.");
    expect(result.stdout).toContain("GitHub URL workspace");
    expect(result.stdout).toContain(`Source: ${rewrite.url}`);
    expect(result.stdout).toContain(
      "Artifacts: none written because this was a dry run",
    );
    const checkoutPath = extractTemporaryCheckoutPath(result.stdout);
    expect(checkoutPath).toBeTruthy();
    await expect(readFile(checkoutPath as string, "utf8")).rejects.toThrow();
    const calls = await readFile(fakeGh.callsPath, "utf8").catch(() => "");
    expect(calls).not.toContain(
      "repos/Open-Maintainer/cli-review-fixture/issues/12/comments",
    );
    expect(calls).not.toContain(
      "repos/Open-Maintainer/cli-review-fixture/pulls/12/reviews",
    );
  });

  it("applies a filterable contribution triage label to a pull request", async () => {
    const fixture = await createReviewRepo();
    const prNumber = 12;
    const refs = await attachPullRequestRemote(fixture, prNumber);
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli({ prNumber, ...refs });

    const result = await runCli(
      [
        "review",
        fixture,
        "--pr",
        String(prNumber),
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--review-post-summary",
        "--review-apply-triage-label",
        "--review-create-triage-labels",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "triage label open-maintainer/ready-for-review",
    );
    expect(result.stdout).toContain("Created 5 triage labels.");

    const calls = (await readFile(fakeGh.callsPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map(
        (line) =>
          JSON.parse(line) as {
            kind?: string;
            args?: string[];
            endpoint: string;
            input: { labels?: string[]; name?: string } | null;
          },
      );
    expect(
      calls.filter(
        (call) =>
          call.kind === "POST" &&
          call.endpoint === "repos/Open-Maintainer/cli-review-fixture/labels",
      ),
    ).toHaveLength(5);
    expect(
      calls.some(
        (call) =>
          call.kind === "POST" &&
          call.endpoint ===
            "repos/Open-Maintainer/cli-review-fixture/issues/12/labels" &&
          call.input?.labels?.includes("open-maintainer/ready-for-review"),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.kind === "label_create")).toBe(false);
    expect(calls.some((call) => call.kind === "issue_edit")).toBe(false);
  });

  it("refuses to apply a ready triage label when GitHub reports the PR is blocked", async () => {
    const fixture = await createReviewRepo();
    const prNumber = 12;
    const refs = await attachPullRequestRemote(fixture, prNumber);
    const fakeCodex = await createFakeCodexCli();
    const fakeGh = await createFakeGhCli({
      prNumber,
      ...refs,
      isDraft: true,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [
        {
          name: "Tests",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://example.test/check",
        },
      ],
    });

    const result = await runCli(
      [
        "review",
        fixture,
        "--pr",
        String(prNumber),
        "--model",
        "codex",
        "--allow-model-content-transfer",
        "--review-apply-triage-label",
        "--review-create-triage-labels",
      ],
      {
        ...fakeCodex.env,
        ...fakeGh.env,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Refusing to apply open-maintainer/ready-for-review",
    );
    expect(result.stderr).toContain("PR is draft");
    expect(result.stderr).toContain("PR has merge conflicts");
    expect(result.stderr).toContain("blocking checks: Tests");

    const calls = await readFile(fakeGh.callsPath, "utf8").catch(() => "");
    expect(calls).not.toContain('"issue","edit","12"');
  });

  it("requires a pull request target for posting flags", async () => {
    const fixture = await createReviewRepo();

    const result = await runCli([
      "review",
      fixture,
      "--base-ref",
      "HEAD~1",
      "--head-ref",
      "HEAD",
      "--review-post-summary",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Review GitHub write flags require --pr");
  });

  it("requires triage label application before creating triage labels", async () => {
    const fixture = await createReviewRepo();

    const result = await runCli([
      "review",
      fixture,
      "--pr",
      "12",
      "--review-create-triage-labels",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "--review-create-triage-labels requires --review-apply-triage-label",
    );
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
