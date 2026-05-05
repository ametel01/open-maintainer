import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assembleLocalReviewInput } from "../src";

const execFileAsync = promisify(execFile);

describe("local git review context", () => {
  it("assembles bounded review input from local refs", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "review-git-"));
    try {
      await git(repoRoot, ["init", "-b", "main"]);
      await writeFile(path.join(repoRoot, "README.md"), "# Tool\n");
      await mkdir(path.join(repoRoot, "src"));
      await writeFile(
        path.join(repoRoot, "src/index.ts"),
        "export const value = 1;\n",
      );
      await git(repoRoot, ["add", "."]);
      await git(repoRoot, [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Open Maintainer",
        "commit",
        "-m",
        "Initial",
      ]);
      const baseSha = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
      await git(repoRoot, ["checkout", "-b", "feature"]);
      await writeFile(
        path.join(repoRoot, "src/index.ts"),
        "export const value = 2;\n",
      );
      await writeFile(path.join(repoRoot, "src/feature.ts"), "export {};\n");
      await mkdir(path.join(repoRoot, "dist"));
      await writeFile(path.join(repoRoot, "dist/generated.js"), "ignored\n");
      await writeFile(path.join(repoRoot, "image.png"), "binary-ish\n");
      await git(repoRoot, ["add", "."]);
      await git(repoRoot, [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Open Maintainer",
        "commit",
        "-m",
        "Change source",
      ]);
      const headSha = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();

      const input = await assembleLocalReviewInput({
        repoRoot,
        repoId: "repo_1",
        baseRef: baseSha,
        headRef: headSha,
        maxFiles: 10,
      });

      expect(input.owner).toBe("local");
      expect(input.baseSha).toBe(baseSha);
      expect(input.headSha).toBe(headSha);
      expect(input.changedFiles.map((file) => file.path).sort()).toEqual([
        "src/feature.ts",
        "src/index.ts",
      ]);
      expect(
        input.changedFiles.find((file) => file.path === "src/index.ts"),
      ).toEqual(
        expect.objectContaining({
          status: "modified",
          additions: 1,
          deletions: 1,
        }),
      );
      expect(input.skippedFiles).toEqual([
        { path: "dist/generated.js", reason: "filtered" },
        { path: "image.png", reason: "filtered" },
      ]);
      expect(input.commits).toHaveLength(1);
      expect(input.checkStatuses).toEqual([]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("skips files that exceed local review limits", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "review-git-limits-"));
    try {
      await git(repoRoot, ["init", "-b", "main"]);
      await mkdir(path.join(repoRoot, "src"));
      await writeFile(path.join(repoRoot, "src/a.ts"), "a\n");
      await git(repoRoot, ["add", "."]);
      await git(repoRoot, [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Open Maintainer",
        "commit",
        "-m",
        "Initial",
      ]);
      const baseSha = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
      await writeFile(path.join(repoRoot, "src/a.ts"), "a".repeat(1000));
      await writeFile(path.join(repoRoot, "src/b.ts"), "b\n");
      await git(repoRoot, ["add", "."]);
      await git(repoRoot, [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Open Maintainer",
        "commit",
        "-m",
        "Change",
      ]);
      const headSha = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();

      const input = await assembleLocalReviewInput({
        repoRoot,
        repoId: "repo_1",
        baseRef: baseSha,
        headRef: headSha,
        maxFiles: 1,
        maxFileBytes: 200,
      });

      expect(input.changedFiles).toHaveLength(1);
      expect(input.skippedFiles).toEqual([
        { path: "src/a.ts", reason: "max_file_bytes" },
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("applies .open-maintainerignore after .gitignore for local review diffs", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "review-git-ignore-"));
    try {
      await git(repoRoot, ["init", "-b", "main"]);
      await writeFile(path.join(repoRoot, ".gitignore"), "*.lock\n");
      await writeFile(
        path.join(repoRoot, ".open-maintainerignore"),
        "generated/\n!Cargo.lock\n",
      );
      await writeFile(path.join(repoRoot, "Cargo.lock"), "lock = 1\n");
      await mkdir(path.join(repoRoot, "generated"), { recursive: true });
      await writeFile(path.join(repoRoot, "generated/output.ts"), "old\n");
      await writeFile(path.join(repoRoot, "src.ts"), "old\n");
      await git(repoRoot, ["add", "-f", "."]);
      await git(repoRoot, [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Open Maintainer",
        "commit",
        "-m",
        "Initial",
      ]);
      const baseSha = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
      await writeFile(path.join(repoRoot, "Cargo.lock"), "lock = 2\n");
      await writeFile(path.join(repoRoot, "generated/output.ts"), "new\n");
      await writeFile(path.join(repoRoot, "src.ts"), "new\n");
      await git(repoRoot, ["add", "-f", "."]);
      await git(repoRoot, [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Open Maintainer",
        "commit",
        "-m",
        "Change",
      ]);
      const headSha = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();

      const input = await assembleLocalReviewInput({
        repoRoot,
        repoId: "repo_1",
        baseRef: baseSha,
        headRef: headSha,
      });

      expect(input.changedFiles.map((file) => file.path).sort()).toEqual([
        "Cargo.lock",
        "src.ts",
      ]);
      expect(input.skippedFiles).toContainEqual({
        path: "generated/output.ts",
        reason: "filtered",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
