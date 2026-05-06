import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertGenerationAllowed,
  assertProviderExecutableAvailable,
  buildClaudeCliProvider,
  buildCodexCliProvider,
  buildProvider,
  createProviderConfig,
  testProviderConnection,
} from "../src";

let server: ReturnType<typeof createServer> | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

describe("AI providers", () => {
  it("validates provider config and guards generation consent", () => {
    const provider = createProviderConfig({
      kind: "openai-compatible",
      displayName: "Local",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.1",
      apiKey: "dev-key",
      repoContentConsent: false,
    });

    expect(() => assertGenerationAllowed(null)).toThrow(/blocked/);
    expect(() => assertGenerationAllowed(provider)).toThrow(/consent/);
  });

  it("checks selected CLI providers before generation", async () => {
    const previousCodexCommand = process.env["OPEN_MAINTAINER_CODEX_COMMAND"];
    process.env["OPEN_MAINTAINER_CODEX_COMMAND"] =
      "open-maintainer-missing-codex-test-command";
    try {
      const provider = createProviderConfig({
        kind: "codex-cli",
        displayName: "Codex CLI",
        baseUrl: "http://localhost",
        model: "codex-cli",
        apiKey: "local-cli",
        repoContentConsent: true,
      });

      await expect(assertProviderExecutableAvailable(provider)).rejects.toThrow(
        /Executable not found/,
      );
    } finally {
      if (previousCodexCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CODEX_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = previousCodexCommand;
      }
    }
  });

  it("tests a local OpenAI-compatible mock without repo content", async () => {
    const bodies: string[] = [];
    server = createServer((request, response) => {
      request.on("data", (chunk) => bodies.push(String(chunk)));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        );
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected local test server port");
    }
    const config = createProviderConfig({
      kind: "local-openai-compatible",
      displayName: "Mock",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "mock-model",
      apiKey: "test",
      repoContentConsent: true,
    });

    const result = await testProviderConnection(buildProvider(config));

    expect(result.text).toBe("ok");
    expect(bodies.join("\n")).not.toContain("repo profile");
    expect(bodies.join("\n")).not.toContain("source code");
  });

  it("passes cwd and per-call output schemas to dashboard-built CLI providers", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "build-provider-codex-test-"),
    );
    const repoRoot = path.join(directory, "repo");
    const command = path.join(directory, "fake-codex.js");
    const argsPath = path.join(directory, "args.json");
    const previousCodexCommand = process.env["OPEN_MAINTAINER_CODEX_COMMAND"];
    try {
      await writeFile(
        command,
        `#!/usr/bin/env node
const fs = require("node:fs");
const argsPath = ${JSON.stringify(argsPath)};
fs.writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)));
const outputIndex = process.argv.indexOf("--output-last-message");
const outputPath = process.argv[outputIndex + 1];
fs.writeFileSync(outputPath, JSON.stringify({ ok: true }));
`,
      );
      await chmod(command, 0o755);
      process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = command;
      const provider = createProviderConfig({
        kind: "codex-cli",
        displayName: "Codex CLI",
        baseUrl: "http://localhost",
        model: "codex-cli",
        apiKey: "local-cli",
        repoContentConsent: true,
      });

      const result = await buildProvider(provider).complete(
        { system: "Return JSON.", user: "Use schema." },
        {
          outputSchema: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
        },
      );
      const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];

      expect(JSON.parse(result.text)).toEqual({ ok: true });
      expect(args).toContain("--output-schema");
      expect(
        args.slice(args.indexOf("--model"), args.indexOf("--model") + 2),
      ).toEqual(["--model", "gpt-5.5"]);
      expect(
        args.slice(args.indexOf("--cd"), args.indexOf("--cd") + 2),
      ).toEqual(["--cd", process.cwd()]);

      await buildProvider(provider, { cwd: repoRoot }).complete(
        { system: "Return JSON.", user: "Use schema." },
        {
          outputSchema: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
        },
      );
      const argsWithCwd = JSON.parse(
        await readFile(argsPath, "utf8"),
      ) as string[];
      expect(
        argsWithCwd.slice(
          argsWithCwd.indexOf("--cd"),
          argsWithCwd.indexOf("--cd") + 2,
        ),
      ).toEqual(["--cd", repoRoot]);
    } finally {
      if (previousCodexCommand === undefined) {
        Reflect.deleteProperty(process.env, "OPEN_MAINTAINER_CODEX_COMMAND");
      } else {
        process.env["OPEN_MAINTAINER_CODEX_COMMAND"] = previousCodexCommand;
      }
    }
  });

  it("runs Codex CLI provider through a schema-constrained output file", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "codex-provider-test-"),
    );
    const command = path.join(directory, "fake-codex.js");
    await writeFile(
      command,
      `#!/usr/bin/env node
const fs = require("node:fs");
const outputIndex = process.argv.indexOf("--output-last-message");
const outputPath = process.argv[outputIndex + 1];
fs.writeFileSync(outputPath, JSON.stringify({ ok: true, source: "codex" }));
`,
    );
    await chmod(command, 0o755);

    const result = await buildCodexCliProvider({
      command,
      cwd: directory,
      outputSchema: {
        type: "object",
        required: ["ok", "source"],
        properties: { ok: { type: "boolean" }, source: { type: "string" } },
      },
    }).complete({ system: "Return JSON.", user: "Use schema." });

    expect(JSON.parse(result.text)).toEqual({ ok: true, source: "codex" });
    expect(result.model).toBe("gpt-5.5");
  });

  it("omits CLI failure output because it can contain repository content", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "codex-provider-failure-test-"),
    );
    const command = path.join(directory, "fake-codex.js");
    await writeFile(
      command,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", (chunk) => process.stderr.write(chunk));
process.stdin.on("end", () => process.exit(1));
`,
    );
    await chmod(command, 0o755);

    await expect(
      buildCodexCliProvider({ command, cwd: directory }).complete({
        system: "Return JSON.",
        user: "secret repository prompt",
      }),
    ).rejects.toThrow(
      "Codex CLI exited with code 1. CLI output was omitted because it can contain repository content.",
    );
    await expect(
      buildCodexCliProvider({ command, cwd: directory }).complete({
        system: "Return JSON.",
        user: "secret repository prompt",
      }),
    ).rejects.not.toThrow("secret repository prompt");
  });

  it("runs Claude CLI provider through schema-constrained print mode", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "claude-provider-test-"),
    );
    const command = path.join(directory, "fake-claude.js");
    await writeFile(
      command,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, source: "claude" }));
`,
    );
    await chmod(command, 0o755);

    const result = await buildClaudeCliProvider({
      command,
      cwd: directory,
      outputSchema: {
        type: "object",
        required: ["ok", "source"],
        properties: { ok: { type: "boolean" }, source: { type: "string" } },
      },
    }).complete({ system: "Return JSON.", user: "Use schema." });

    expect(JSON.parse(result.text)).toEqual({ ok: true, source: "claude" });
    expect(result.model).toBe("claude-cli");
  });

  it("returns malformed Claude JSON output for caller validation", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "claude-provider-bad-json-test-"),
    );
    const command = path.join(directory, "fake-claude.js");
    await writeFile(
      command,
      `#!/usr/bin/env node
process.stdout.write("{not valid json");
`,
    );
    await chmod(command, 0o755);

    const result = await buildClaudeCliProvider({
      command,
      cwd: directory,
    }).complete({ system: "Return JSON.", user: "Use schema." });

    expect(result.text).toBe("{not valid json");
  });
});
