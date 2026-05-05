import { describe, expect, it } from "vitest";
import {
  buildRepositoryIgnoreRules,
  isRepositoryPathIgnored,
  parseRepositoryIgnoreFile,
} from "../src";

describe("repository ignore matcher", () => {
  it("matches gitignore-style directory, glob, anchored, and descendant rules", () => {
    const rules = parseRepositoryIgnoreFile(`
dist/
*.log
/generated/schema.json
docs/**/*.tmp
`);

    expect(isRepositoryPathIgnored("dist/index.js", rules)).toBe(true);
    expect(isRepositoryPathIgnored("build.log", rules)).toBe(true);
    expect(isRepositoryPathIgnored("generated/schema.json", rules)).toBe(true);
    expect(isRepositoryPathIgnored("src/generated/schema.json", rules)).toBe(
      false,
    );
    expect(isRepositoryPathIgnored("docs/a/b/cache.tmp", rules)).toBe(true);
    expect(isRepositoryPathIgnored("src/index.ts", rules)).toBe(false);
  });

  it("lets later .open-maintainerignore negation override earlier ignore rules", () => {
    const rules = buildRepositoryIgnoreRules([
      { path: ".gitignore", content: "*.lock\ncoverage/\n" },
      {
        path: ".open-maintainerignore",
        content: "!Cargo.lock\ncoverage/keep.json\n",
      },
    ]);

    expect(isRepositoryPathIgnored("Cargo.lock", rules)).toBe(false);
    expect(isRepositoryPathIgnored("bun.lock", rules)).toBe(true);
    expect(isRepositoryPathIgnored("coverage/output.json", rules)).toBe(true);
    expect(isRepositoryPathIgnored("coverage/keep.json", rules)).toBe(true);
  });
});
