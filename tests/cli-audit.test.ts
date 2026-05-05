import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { repoRoot, runCli } from "./helpers/cli";
import {
  codexGenerateArgs,
  createFakeCodexCli,
} from "./helpers/fake-model-cli";
import {
  createArtifactRoot,
  createBareRemoteFromWorktree,
  createGitHubUrlRewrite,
} from "./helpers/git-url";

const fixtureRoot = path.join(repoRoot, "tests/fixtures/low-context-ts");
const execFileAsync = promisify(execFile);

describe("CLI audit", () => {
  it("prints concrete next steps for missing readiness items", async () => {
    const workdir = await mkdtemp(
      path.join(tmpdir(), "open-maintainer-audit-"),
    );
    await cp(fixtureRoot, workdir, { recursive: true });

    const result = await runCli(["audit", workdir]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Agent Readiness:");
    expect(result.stdout).toContain("Report: .open-maintainer/report.md");
    expect(result.stdout).toContain("Next steps:");
    expect(result.stdout).toContain(
      "- Add a `docs/` directory with architecture, operations, or runbook notes.",
    );
    expect(result.stdout).toContain(
      "- Add `.github/workflows/ci.yml` running the repository's install and validation commands.",
    );
    expect(result.stdout).toContain(
      "- Add `AGENTS.md` or `CLAUDE.md` with repo-specific agent instructions.",
    );
    expect(result.stdout).toContain(".agents/skills/");
    expect(result.stdout).toContain("-start-task/SKILL.md");
    expect(result.stdout).toContain(
      "- Add `.open-maintainer.yml` with repository policy and generated-context metadata.",
    );
    expect(result.stdout).toContain(
      "- Add `CONTRIBUTING.md` with PR workflow, review rules, and validation commands.",
    );
  });

  it("previews audit outputs without writing files in dry-run mode", async () => {
    const workdir = await mkdtemp(
      path.join(tmpdir(), "open-maintainer-audit-dry-run-"),
    );
    await cp(fixtureRoot, workdir, { recursive: true });

    const result = await runCli(["audit", workdir, "--dry-run"], {
      OPEN_MAINTAINER_FORCE_COLOR: "1",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("\x1b[");
    expect(result.stdout).toContain("+");
    expect(result.stdout).toContain("Open Maintainer audit");
    expect(result.stdout).toContain("Mode: dry-run");
    expect(result.stdout).toContain(
      "Profile: .open-maintainer/profile.json (planned)",
    );
    expect(result.stdout).toContain(
      "Report: .open-maintainer/report.md (planned)",
    );
    expect(result.stdout).toContain("Dry run: no audit files written.");
    await expect(
      readFile(path.join(workdir, ".open-maintainer/profile.json"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(workdir, ".open-maintainer/report.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("audits a GitHub URL checkout and copies artifacts before cleanup", async () => {
    const workdir = await mkdtemp(
      path.join(tmpdir(), "open-maintainer-audit-url-source-"),
    );
    await cp(fixtureRoot, workdir, { recursive: true });
    await initializeGitWorktree(workdir);
    const remote = await createBareRemoteFromWorktree(workdir);
    const rewrite = await createGitHubUrlRewrite({
      owner: "acme",
      repo: "low-context-url",
      remotePath: remote,
    });
    const artifactRoot = await createArtifactRoot();

    const result = await runCli(["audit", rewrite.gitUrl], {
      ...rewrite.env,
      OPEN_MAINTAINER_REMOTE_ARTIFACT_ROOT: artifactRoot,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Open Maintainer audit");
    expect(result.stdout).toContain("GitHub URL workspace");
    expect(result.stdout).toContain(`Source: ${rewrite.url}`);
    expect(result.stdout).toContain("Temporary checkout:");
    expect(result.stdout).toContain("(removed)");
    expect(result.stdout).toContain("Artifacts copied to:");
    expect(result.stdout).toContain("- .open-maintainer");
    const checkoutPath = extractTemporaryCheckoutPath(result.stdout);
    expect(checkoutPath).toBeTruthy();
    await expect(readFile(checkoutPath as string, "utf8")).rejects.toThrow();
    const profile = JSON.parse(
      await readFile(
        path.join(
          artifactRoot,
          "acme",
          "low-context-url",
          ".open-maintainer/profile.json",
        ),
        "utf8",
      ),
    ) as { owner: string; name: string };
    expect(profile.owner).toBe("acme");
    expect(profile.name).toBe("low-context-url");
    await expect(
      readFile(
        path.join(
          artifactRoot,
          "acme",
          "low-context-url",
          ".open-maintainer/report.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("# Open Maintainer Report: acme/low-context-url");
  });

  it("re-audits after init generates context artifacts", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "open-maintainer-init-"));
    await cp(fixtureRoot, workdir, { recursive: true });
    const fakeCodex = await createFakeCodexCli();

    const result = await runCli(
      [
        "init",
        workdir,
        ...codexGenerateArgs,
        "--context",
        "codex",
        "--skills",
        "codex",
      ],
      fakeCodex.env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const profile = JSON.parse(
      await readFile(
        path.join(workdir, ".open-maintainer/profile.json"),
        "utf8",
      ),
    ) as { existingContextFiles: string[] };
    expect(profile.existingContextFiles).toContain("AGENTS.md");
    expect(profile.existingContextFiles).toContain(".open-maintainer.yml");
  });

  it("previews init without writing audit or generated context artifacts", async () => {
    const workdir = await mkdtemp(
      path.join(tmpdir(), "open-maintainer-init-dry-run-"),
    );
    await cp(fixtureRoot, workdir, { recursive: true });
    const fakeCodex = await createFakeCodexCli();

    const result = await runCli(
      [
        "init",
        workdir,
        ...codexGenerateArgs,
        "--context",
        "codex",
        "--skills",
        "codex",
        "--dry-run",
      ],
      fakeCodex.env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Open Maintainer init");
    expect(result.stdout).toContain("Open Maintainer generate");
    expect(result.stdout).toContain("Dry run: no context artifacts written.");
    expect(result.stdout).toContain("Dry run: no init files written.");
    await expect(
      readFile(path.join(workdir, "AGENTS.md"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(workdir, ".open-maintainer/profile.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("refreshes generated context while preserving maintainer-owned files", async () => {
    const workdir = await mkdtemp(
      path.join(tmpdir(), "open-maintainer-refresh-generated-"),
    );
    await cp(fixtureRoot, workdir, { recursive: true });
    const fakeCodex = await createFakeCodexCli();

    const initial = await runCli(
      [
        "generate",
        workdir,
        ...codexGenerateArgs,
        "--context",
        "codex",
        "--skills",
        "codex",
      ],
      fakeCodex.env,
    );
    expect(initial.exitCode).toBe(0);

    const agentsPath = path.join(workdir, "AGENTS.md");
    await writeFile(agentsPath, "# Maintainer-owned instructions\n");
    const configPath = path.join(workdir, ".open-maintainer.yml");
    const staleGeneratedConfig = `${await readFile(configPath, "utf8")}\n# stale generated note\n`;
    await writeFile(configPath, staleGeneratedConfig);

    const refresh = await runCli(
      [
        "generate",
        workdir,
        ...codexGenerateArgs,
        "--context",
        "codex",
        "--skills",
        "codex",
        "--refresh-generated",
      ],
      fakeCodex.env,
    );

    expect(refresh.exitCode).toBe(0);
    expect(refresh.stderr).toBe("");
    expect(refresh.stdout).toContain("skip: AGENTS.md");
    expect(refresh.stdout).toContain(
      "existing maintainer-owned file preserved",
    );
    expect(refresh.stdout).toContain("overwrite: .open-maintainer.yml");
    expect(refresh.stdout).toContain("existing generated file");
    expect(await readFile(agentsPath, "utf8")).toBe(
      "# Maintainer-owned instructions\n",
    );
    expect(await readFile(configPath, "utf8")).not.toContain(
      "# stale generated note",
    );
  });

  it("previews generate without writing context artifacts", async () => {
    const workdir = await mkdtemp(
      path.join(tmpdir(), "open-maintainer-generate-dry-run-"),
    );
    await cp(fixtureRoot, workdir, { recursive: true });
    const fakeCodex = await createFakeCodexCli();

    const result = await runCli(
      [
        "generate",
        workdir,
        ...codexGenerateArgs,
        "--context",
        "codex",
        "--skills",
        "codex",
        "--dry-run",
      ],
      fakeCodex.env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Open Maintainer generate");
    expect(result.stdout).toContain("Mode: dry-run");
    expect(result.stdout).toContain("Artifact write plan");
    expect(result.stdout).toContain("planned actions:");
    expect(result.stdout).toContain("write: AGENTS.md");
    expect(result.stdout).toContain("file is absent");
    expect(result.stdout).not.toContain("| Action | Target");
    expect(result.stdout).toContain("Dry run: no context artifacts written.");
    await expect(
      readFile(path.join(workdir, "AGENTS.md"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(workdir, ".open-maintainer.yml"), "utf8"),
    ).rejects.toThrow();
  });

  it("prints the context PR dry-run summary with explicit dry-run mode", async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), "open-maintainer-pr-"));
    await cp(fixtureRoot, workdir, { recursive: true });

    const result = await runCli(["pr", workdir, "--create", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Open Maintainer context PR");
    expect(result.stdout).toContain("Mode: dry-run");
    expect(result.stdout).toContain("Dry-run context PR summary");
    expect(result.stdout).toContain("Agent Readiness:");
  });

  it("includes drift findings and remediation in the report", async () => {
    const workdir = await mkdtemp(
      path.join(tmpdir(), "open-maintainer-audit-drift-"),
    );
    await cp(fixtureRoot, workdir, { recursive: true });
    const fakeCodex = await createFakeCodexCli();

    const generate = await runCli(
      [
        "generate",
        workdir,
        ...codexGenerateArgs,
        "--context",
        "codex",
        "--skills",
        "codex",
      ],
      fakeCodex.env,
    );
    expect(generate.exitCode).toBe(0);

    const packageJsonPath = path.join(workdir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    packageJson.scripts.typecheck = "tsc --noEmit";
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );

    const audit = await runCli(["audit", workdir]);

    expect(audit.exitCode).toBe(0);
    expect(audit.stderr).toBe("");
    const report = await readFile(
      path.join(workdir, ".open-maintainer/report.md"),
      "utf8",
    );
    expect(report).toContain("## Drift");
    expect(report).toContain(
      "Commands: package.json script typecheck was added. Evidence: package.json.",
    );
    expect(report).toContain(
      "Next action: review the changed command and refresh generated context if validation expectations changed.",
    );
  });
});

async function initializeGitWorktree(workdir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: workdir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: workdir,
  });
  await execFileAsync("git", ["config", "user.name", "Test User"], {
    cwd: workdir,
  });
  await execFileAsync("git", ["add", "."], { cwd: workdir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workdir });
}

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
