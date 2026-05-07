import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function createFakeCodexCli(): Promise<{
  command: string;
  env: Record<string, string>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "om-fake-codex-"));
  const command = path.join(directory, "fake-codex.js");
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.0.0\\n");
  process.exit(0);
}

const cdIndex = process.argv.indexOf("--cd");
const schemaIndex = process.argv.indexOf("--output-schema");
const outputIndex = process.argv.indexOf("--output-last-message");
const repoRoot = cdIndex >= 0 ? process.argv[cdIndex + 1] : process.cwd();
const schema = JSON.parse(fs.readFileSync(process.argv[schemaIndex + 1], "utf8"));
const outputPath = process.argv[outputIndex + 1];
const repoName = path.basename(repoRoot);
const slug = repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
const repeated = "Use repository evidence, run the detected validation command, and keep generated context scoped. ";
let promptText = "";
let output;

if (schema.required.includes("pullRequests")) {
  output = { pullRequests: [] };
} else if (schema.required.includes("classification")) {
  if (process.env["OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE"] === "invalid-json") {
    output = "not an issue triage object";
  } else {
    const noEvidence = process.env["OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE"] === "no-evidence";
    const spam = process.env["OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE"] === "spam";
    const ready = process.env["OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE"] === "ready";
    output = {
      classification: spam ? "possibly_spam" : ready ? "ready_for_maintainer_review" : "needs_author_input",
      qualityScore: spam ? 18 : ready ? 91 : 42,
      spamRisk: spam ? "high" : "low",
      agentReadiness: ready ? "agent_ready" : "not_agent_ready",
      confidence: spam ? 0.82 : ready ? 0.9 : 0.71,
      signals: spam ? ["possibly_spam"] : ready ? ["ready_for_maintainer_review", "agent_ready"] : ["needs_author_input", "missing_reproduction"],
      evidence: noEvidence ? [] : [
        {
          signal: spam ? "possibly_spam" : ready ? "ready_for_maintainer_review" : "needs_author_input",
          issueTextQuote: "The command should triage one issue locally.",
          reason: "Primary issue text describes the requested local triage behavior."
        },
        ...(spam || ready ? [] : [{
          signal: "missing_reproduction",
          issueTextQuote: "The command should triage one issue locally.",
          reason: "The issue needs reproduction or validation details."
        }])
      ],
      missingInfo: ready ? [] : ["reproduction_steps"],
      possibleDuplicates: [],
      maintainerSummary: spam ? "Treat as possible spam under maintainer-configured guardrails." : ready ? "Generate an agent task brief for the scoped CLI change." : "Request author input before maintainer review.",
      suggestedAuthorRequest: ready ? null : "Add a concrete acceptance criterion and validation command."
    };
  }
} else if (schema.required.includes("findings")) {
  const findings = process.env["OPEN_MAINTAINER_FAKE_CODEX_FINDING"] === "1"
    ? [{
        severity: "major",
        category: "correctness",
        title: "Return value change needs a fix",
        file: "src/index.ts",
        line: 2,
        evidence: [{
          id: "patch:1",
          kind: "patch",
          summary: "The changed function now returns a different value."
        }],
        impact: "Callers can observe the changed return value.",
        recommendation: "Add or adjust tests and confirm the changed value is intended."
      }]
    : [];
  output = {
    summary: {
      overview: "Model-backed review summary for " + repoName + ".",
      changedSurfaces: ["offline-test"],
      riskLevel: "low",
      validationSummary: "Fake provider observed no failing checks.",
      docsSummary: "Fake provider observed no required docs changes."
    },
    findings,
    contributionTriage: {
      category: "ready_for_review",
      recommendation: "Proceed with normal maintainer review.",
      evidence: [{
        id: "precheck:contribution:1",
        kind: "precheck",
        summary: "PR intent and changed files are available for review."
      }],
      missingInformation: [],
      requiredActions: []
    },
    mergeReadiness: {
      status: "ready",
      reason: "Fake provider found no cited findings.",
      requiredActions: []
    },
    residualRisk: [{
      risk: "Fake provider output is synthetic.",
      reason: "The fake CLI is used only for offline tests.",
      suggestedFollowUp: "Run a real provider review before relying on review quality."
    }]
  };
} else if (schema.required.includes("summary")) {
  output = {
    summary: "local/" + repoName + " is generated from model-analyzed repository facts.",
    evidenceMap: [{ claim: "Package metadata was inspected.", evidence: ["package.json"], confidence: "observed" }],
    repositoryMap: [{ path: "src", purpose: "Source files.", evidence: ["src"], confidence: "inferred" }],
    commands: [{ name: "test", command: "vitest run", scope: "tests", source: "package.json", purpose: "Run tests.", confidence: "observed" }],
    setup: { requirements: [{ claim: "Install dependencies with the detected package manager.", evidence: ["package.json"], confidence: "inferred" }], unknowns: [] },
    architecture: { observed: [], inferred: [], unknowns: ["Detailed architecture was not detected."] },
    changeRules: { safeEditZones: [], carefulEditZones: [], doNotEditWithoutExplicitInstruction: [], unknowns: [] },
    testingStrategy: { locations: [], commands: [{ name: "test", command: "vitest run", scope: "tests", source: "package.json", purpose: "Run tests.", confidence: "observed" }], namingConventions: [], regressionExpectations: ["Add focused regression tests for changed behavior."], unknowns: [] },
    validation: { canonicalCommand: { name: "test", command: "vitest run", scope: "tests", source: "package.json", purpose: "Run tests.", confidence: "observed" }, scopedCommands: [], unknowns: [] },
    prRules: ["Report validation evidence."],
    knownPitfalls: [],
    generatedFiles: [],
    highRiskAreas: [],
    documentationAlignment: [],
    unknowns: []
  };
} else if (schema.required.includes("agentsMd")) {
  output = {
    agentsMd: "# AGENTS.md instructions for local/" + repoName + "\\n\\n" + repeated + repeated,
    claudeMd: "# CLAUDE.md instructions for local/" + repoName + "\\n\\n" + repeated + repeated,
    copilotInstructions: "# Copilot instructions for local/" + repoName + "\\n\\n" + repeated + repeated,
    cursorRule: "---\\ndescription: local " + slug + " rules\\nalwaysApply: true\\n---\\n\\n" + repeated + repeated
  };
} else {
  const skill = (role, title) => ({
    path: ".agents/skills/" + slug + "-" + role + "/SKILL.md",
    name: slug + "-" + role,
    description: "Use this " + title + " workflow in " + repoName + ".",
    markdown: "---\\nname: " + slug + "-" + role + "\\ndescription: Use this " + title + " workflow in " + repoName + ".\\n---\\n\\n# " + title + "\\n\\n## Use when\\n- Working in this repo.\\n\\n## Do not use when\\n- The task is unrelated.\\n\\n## Read first\\n- README.md\\n\\n## Workflow\\n- Inspect evidence before editing.\\n\\n## Validation\\n- Run vitest run.\\n\\n## Documentation\\n- Check README.md.\\n\\n## Risk checks\\n- Keep changes scoped.\\n\\n## Done when\\n- Evidence is reported."
  });
  output = { skills: [skill("start-task", "Start Task"), skill("testing-workflow", "Testing Workflow"), skill("pr-review", "PR Review")] };
}

process.stdin.resume();
process.stdin.on("data", (chunk) => {
  promptText += chunk.toString();
});
process.stdin.on("end", () => {
  if (schema.required.includes("pullRequests")) {
    const numbers = [
      ...new Set(
        [...promptText.matchAll(/"number":\\s*(\\d+)/g)].map((match) =>
          Number(match[1]),
        ),
      ),
    ].filter((number) => Number.isInteger(number) && number > 0);
    output = {
      pullRequests: numbers.map((number) => ({
        number,
        labels: ["open-maintainer/llm-authored"],
        reason: "Synthetic fake provider detected LLM authorship evidence.",
      })),
    };
  }
  if (
    schema.required.includes("classification") &&
    process.env["OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE"] === "mixed"
  ) {
    if (promptText.includes('"issueNumber": 43') || promptText.includes('"number": 43')) {
      output = {
        ...output,
        evidence: [],
      };
    }
    if (promptText.includes('"issueNumber": 44') || promptText.includes('"number": 44')) {
      output = {
        ...output,
        classification: "ready_for_maintainer_review",
        qualityScore: 88,
        spamRisk: "low",
        agentReadiness: "agent_ready",
        confidence: 0.88,
        signals: ["ready_for_maintainer_review", "agent_ready"],
        maintainerSummary: "Proceed to maintainer review.",
        missingInfo: [],
        possibleDuplicates: [],
        suggestedAuthorRequest: null
      };
    }
  }
  if (
    schema.required.includes("classification") &&
    process.env["OPEN_MAINTAINER_FAKE_CODEX_ISSUE_TRIAGE"] === "all-classifications"
  ) {
    const issueMatch =
      promptText.match(/"issueNumber":\\s*(\\d+)/) ??
      promptText.match(/"number":\\s*(\\d+)/);
    const issueNumber = issueMatch ? Number(issueMatch[1]) : 0;
    const byIssue = {
      42: {
        classification: "ready_for_maintainer_review",
        qualityScore: 91,
        spamRisk: "low",
        agentReadiness: "agent_ready",
        confidence: 0.91,
        signals: ["ready_for_maintainer_review", "agent_ready"],
        maintainerSummary: "Generate an agent task brief for the scoped CLI change.",
        missingInfo: [],
        suggestedAuthorRequest: null
      },
      43: {
        classification: "needs_author_input",
        qualityScore: 38,
        spamRisk: "low",
        agentReadiness: "not_agent_ready",
        confidence: 0.73,
        signals: ["needs_author_input", "missing_reproduction", "missing_expected_actual"],
        maintainerSummary: "Request author input before maintainer review.",
        missingInfo: ["reproduction_steps", "expected_behavior", "actual_behavior"],
        suggestedAuthorRequest: "Add a reproducible example and the command that demonstrates the failure."
      },
      44: {
        classification: "needs_human_design",
        qualityScore: 62,
        spamRisk: "low",
        agentReadiness: "needs_human_design",
        confidence: 0.82,
        signals: ["needs_human_design"],
        maintainerSummary: "Get maintainer design direction before assigning implementation.",
        missingInfo: ["acceptance_criteria"],
        suggestedAuthorRequest: null
      },
      45: {
        classification: "not_actionable",
        qualityScore: 34,
        spamRisk: "low",
        agentReadiness: "not_agent_ready",
        confidence: 0.8,
        signals: ["not_actionable", "needs_author_input"],
        maintainerSummary: "Escalate to human maintainer review instead of agent handoff.",
        missingInfo: ["proof_of_concept"],
        suggestedAuthorRequest: "Describe the security boundary and required manual review path."
      },
      46: {
        classification: "possibly_spam",
        qualityScore: 12,
        spamRisk: "high",
        agentReadiness: "not_agent_ready",
        confidence: 0.86,
        signals: ["possibly_spam"],
        maintainerSummary: "Treat as possible spam under maintainer-configured guardrails.",
        missingInfo: ["affected_files_or_commands"],
        suggestedAuthorRequest: "Replace promotional content with a concrete bug, feature, or docs request."
      }
    };
    const scenario = byIssue[issueNumber];
    if (issueNumber === 47) {
      output = {
        ...output,
        evidence: [],
      };
    } else if (scenario) {
      output = {
        classification: scenario.classification,
        qualityScore: scenario.qualityScore,
        spamRisk: scenario.spamRisk,
        agentReadiness: scenario.agentReadiness,
        confidence: scenario.confidence,
        signals: scenario.signals,
        evidence: [{
          signal: scenario.signals[0],
          issueTextQuote: "The mock issue includes realistic triage evidence for classification coverage.",
          reason: "Primary issue text drives the synthetic validation scenario."
        }],
        missingInfo: scenario.missingInfo,
        possibleDuplicates: [],
        maintainerSummary: scenario.maintainerSummary,
        suggestedAuthorRequest: scenario.suggestedAuthorRequest
      };
    }
  }
  fs.writeFileSync(outputPath, JSON.stringify(output));
});
`,
  );
  await chmod(command, 0o755);
  return {
    command,
    env: { OPEN_MAINTAINER_CODEX_COMMAND: command },
  };
}

export const codexGenerateArgs = ["--model", "codex", "--allow-write"] as const;
