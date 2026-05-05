import { describe, expect, it } from "vitest";
import {
  parseOpenMaintainerConfig,
  parseOpenMaintainerConfigWithDiagnostics,
  stringifyOpenMaintainerConfig,
} from "../src";

describe(".open-maintainer.yml config", () => {
  it("round-trips valid MVP config", () => {
    const source = stringifyOpenMaintainerConfig({
      version: 1,
      repo: { profileVersion: 2, defaultBranch: "main" },
      rules: ["Run bun test before finishing."],
      generated: {
        by: "open-maintainer",
        artifactVersion: 3,
        generatedAt: "2026-04-30T00:00:00.000Z",
      },
    });

    expect(parseOpenMaintainerConfig(source).generated.artifactVersion).toBe(3);
  });

  it("parses supported issue triage closure guardrails", () => {
    const config = parseOpenMaintainerConfig(`
version: 1
repo:
  profileVersion: 2
  defaultBranch: main
rules: []
issueTriage:
  closure:
    allowPossibleSpam: true
    allowStaleAuthorInput: true
    staleAuthorInputDays: 21
    maxClosuresPerRun: 3
    requireCommentBeforeClose: true
generated:
  by: open-maintainer
  artifactVersion: 3
  generatedAt: "2026-04-30T00:00:00.000Z"
`);

    expect(config.issueTriage?.closure.maxClosuresPerRun).toBe(3);
    expect(config.issueTriage?.closure.staleAuthorInputDays).toBe(21);
  });

  it("rejects invalid issue triage closure config values", () => {
    expect(() =>
      parseOpenMaintainerConfig(`
version: 1
repo:
  profileVersion: 2
  defaultBranch: main
issueTriage:
  closure:
    maxClosuresPerRun: -1
generated:
  by: open-maintainer
  artifactVersion: 3
  generatedAt: "2026-04-30T00:00:00.000Z"
`),
    ).toThrow();
  });

  it("returns diagnostics for unknown keys while preserving valid config", () => {
    const result = parseOpenMaintainerConfigWithDiagnostics(`
version: 1
repo:
  profileVersion: 2
  defaultBranch: main
  extra: ignored
rules:
  - Run bun test.
retention:
  localArtifactsMaxAgeDays: 7
  typo: ignored
unknownTopLevel: true
generated:
  by: open-maintainer
  artifactVersion: 3
  generatedAt: "2026-04-30T00:00:00.000Z"
`);

    expect(result.config.retention?.localArtifactsMaxAgeDays).toBe(7);
    expect(result.config.rules).toEqual(["Run bun test."]);
    expect(result.diagnostics.map((item) => item.path)).toEqual([
      "unknownTopLevel",
      "repo.extra",
      "retention.typo",
    ]);
  });

  it("ignores invalid optional sections and hard-fails invalid required config", () => {
    const result = parseOpenMaintainerConfigWithDiagnostics(`
version: 1
repo:
  profileVersion: 2
  defaultBranch: main
issueTriage:
  closure:
    maxClosuresPerRun: -1
retention:
  localArtifactsMaxAgeDays: "soon"
generated:
  by: open-maintainer
  artifactVersion: 3
  generatedAt: "2026-04-30T00:00:00.000Z"
`);

    expect(result.config.issueTriage).toBeUndefined();
    expect(result.config.retention).toBeUndefined();
    expect(result.diagnostics.map((item) => item.path)).toEqual([
      "issueTriage",
      "retention",
    ]);

    expect(() =>
      parseOpenMaintainerConfigWithDiagnostics(`
version: 2
repo:
  profileVersion: 2
  defaultBranch: main
generated:
  by: open-maintainer
  artifactVersion: 3
  generatedAt: "2026-04-30T00:00:00.000Z"
`),
    ).toThrow();
  });
});
