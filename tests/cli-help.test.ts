import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot, runCli } from "./helpers/cli";

describe("CLI help", () => {
  it("prints root help without requiring a repository path", async () => {
    for (const args of [["--help"], ["-h"], ["help"]]) {
      const result = await runCli(args);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("open-maintainer <command> <repo>");
      expect(result.stdout).toContain("open-maintainer help <command>");
      expect(result.stdout).toContain("https://github.com/OWNER/REPO");
    }
  });

  it("prints command help before resolving repository paths", async () => {
    for (const command of [
      "audit",
      "generate",
      "init",
      "doctor",
      "review",
      "triage",
      "pr",
    ]) {
      for (const helpToken of ["--help", "-h", "help"]) {
        const result = await runCli([command, helpToken]);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(`open-maintainer ${command}`);
        expect(result.stdout).not.toContain("ENOENT");
      }
    }
  });

  it("documents issue triage safety defaults", async () => {
    const result = await runCli(["help", "triage"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("open-maintainer triage issue <repo>");
    expect(result.stdout).toContain("open-maintainer triage issues <repo>");
    expect(result.stdout).toContain("open-maintainer triage brief <repo>");
    expect(result.stdout).toContain("--number <n>");
    expect(result.stdout).toContain("--state open|closed|all");
    expect(result.stdout).toContain("--limit <n>");
    expect(result.stdout).toContain("--apply-labels");
    expect(result.stdout).toContain("--create-labels");
    expect(result.stdout).toContain("--post-comment");
    expect(result.stdout).toContain("--close-allowed");
    expect(result.stdout).toContain("--allow-non-agent-ready");
    expect(result.stdout).toContain("--output-path <path>");
    expect(result.stdout).toContain("--model codex|claude");
    expect(result.stdout).toContain("--allow-model-content-transfer");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("non-mutating");
  });

  it("prints targeted help through the help command", async () => {
    const result = await runCli(["help", "generate"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("open-maintainer generate <repo>");
    expect(result.stdout).toContain("--context codex|claude|both");
    expect(result.stdout).toContain("--skills codex|claude|both");
    expect(result.stdout).toContain("--allow-write");
    expect(result.stdout).toContain("--refresh-generated");
  });

  it("documents review safety defaults", async () => {
    const result = await runCli(["help", "review"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("open-maintainer review <repo>");
    expect(result.stdout).toContain("--base-ref <ref>");
    expect(result.stdout).toContain("--pr <number>");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("--model codex|claude");
    expect(result.stdout).toContain("--llm-model <model>");
    expect(result.stdout).toContain("--allow-model-content-transfer");
    expect(result.stdout).toContain("--review-provider codex|claude");
    expect(result.stdout).toContain("Alias for --model");
    expect(result.stdout).toContain("--review-apply-triage-label");
    expect(result.stdout).toContain("--review-create-triage-labels");
    expect(result.stdout).toContain("Local ref review is non-mutating");
    expect(result.stdout).toContain(
      "open-maintainer review https://github.com/OWNER/REPO",
    );
  });

  it("documents URL-backed audit and triage examples", async () => {
    const audit = await runCli(["help", "audit"]);
    expect(audit.exitCode).toBe(0);
    expect(audit.stdout).toContain(
      "open-maintainer audit https://github.com/OWNER/REPO",
    );

    const triage = await runCli(["help", "triage"]);
    expect(triage.exitCode).toBe(0);
    expect(triage.stdout).toContain(
      "open-maintainer triage issue https://github.com/OWNER/REPO",
    );
    expect(triage.stdout).toContain(
      "open-maintainer triage issues https://github.com/OWNER/REPO",
    );
  });

  it("keeps README command flags aligned with CLI help", async () => {
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

    for (const command of [
      "audit",
      "generate",
      "init",
      "doctor",
      "review",
      "triage",
      "pr",
    ]) {
      const result = await runCli(["help", command]);
      expect(result.exitCode).toBe(0);

      const flags = new Set(result.stdout.match(/--[a-z0-9-]+/g) ?? []);
      for (const flag of flags) {
        expect(readme, `${command} ${flag}`).toContain(flag);
      }
    }
  });

  it("rejects missing and invalid option values", async () => {
    const missing = await runCli(["audit", ".", "--report-path"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("Missing value for --report-path.");

    const invalid = await runCli([
      "audit",
      ".",
      "--fail-on-score-below",
      "not-a-number",
    ]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain(
      "Invalid value for --fail-on-score-below.",
    );
  });
});
