import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ModelProviderConfig,
  ModelProviderKind,
} from "@open-maintainer/shared";
import {
  ModelProviderConfigSchema,
  newId,
  nowIso,
} from "@open-maintainer/shared";

export type CompletionInput = {
  system: string;
  user: string;
};

export type CompletionOutput = {
  text: string;
  model: string;
  tokenUsage?: {
    input: number;
    output: number;
  };
};

export type CompletionOptions = {
  outputSchema?: unknown;
};

export const DEFAULT_CODEX_CLI_MODEL = "gpt-5.5";

export type BuildProviderOptions = {
  cwd?: string;
};

export interface ModelProvider {
  complete(
    input: CompletionInput,
    options?: CompletionOptions,
  ): Promise<CompletionOutput>;
}

export type CodexCliProviderOptions = {
  command?: string;
  cwd: string;
  model?: string;
  outputSchema?: unknown;
  timeoutMs?: number;
};

export type ClaudeCliProviderOptions = {
  command?: string;
  cwd: string;
  model?: string;
  outputSchema?: unknown;
  timeoutMs?: number;
};

export type ProviderSettingsInput = {
  kind: ModelProviderKind;
  displayName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  repoContentConsent: boolean;
};

export function createProviderConfig(
  input: ProviderSettingsInput,
): ModelProviderConfig {
  const timestamp = nowIso();
  return ModelProviderConfigSchema.parse({
    id: newId("model_provider"),
    kind: input.kind,
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    model: input.model,
    encryptedApiKey: encryptForLocalDev(input.apiKey),
    repoContentConsent: input.repoContentConsent,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function assertGenerationAllowed(
  provider: ModelProviderConfig | null,
): asserts provider is ModelProviderConfig {
  if (!provider) {
    throw new Error(
      "Generation is blocked until a model provider is configured.",
    );
  }
  if (!provider.repoContentConsent) {
    throw new Error(
      "Generation is blocked until repo-content consent is enabled for this provider.",
    );
  }
}

export function assertProviderConsent(
  provider: ModelProviderConfig,
): asserts provider is ModelProviderConfig {
  if (!provider.repoContentConsent) {
    throw new Error(
      "Generation is blocked until repo-content consent is enabled for this provider.",
    );
  }
}

export function buildProvider(
  config: ModelProviderConfig,
  options: BuildProviderOptions = {},
): ModelProvider {
  const cwd = options.cwd ?? process.cwd();
  if (config.kind === "codex-cli") {
    return {
      complete(input, options) {
        return buildCodexCliProvider({
          command: codexCommand(),
          cwd,
          model: resolveCodexCliModel(config.model),
          ...(options?.outputSchema
            ? { outputSchema: options.outputSchema }
            : {}),
        }).complete(input);
      },
    };
  }
  if (config.kind === "claude-cli") {
    return {
      complete(input, options) {
        return buildClaudeCliProvider({
          command: claudeCommand(),
          cwd,
          ...(config.model === "claude-cli" ? {} : { model: config.model }),
          ...(options?.outputSchema
            ? { outputSchema: options.outputSchema }
            : {}),
        }).complete(input);
      },
    };
  }

  return {
    async complete(input) {
      const response = await fetch(
        `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${decryptForLocalDev(config.encryptedApiKey)}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: "system", content: input.system },
              { role: "user", content: input.user },
            ],
            stream: false,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`Provider request failed with HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: data.choices?.[0]?.message?.content ?? "",
        model: config.model,
        tokenUsage: {
          input: data.usage?.prompt_tokens ?? 0,
          output: data.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

export async function assertProviderExecutableAvailable(
  config: ModelProviderConfig,
): Promise<void> {
  if (config.kind === "codex-cli") {
    await runProcess({
      label: "Codex CLI",
      command: codexCommand(),
      args: ["--version"],
      stdin: "",
      timeoutMs: 10_000,
    });
  }
  if (config.kind === "claude-cli") {
    await runProcess({
      label: "Claude CLI",
      command: claudeCommand(),
      args: ["--version"],
      stdin: "",
      timeoutMs: 10_000,
    });
  }
}

export function buildCodexCliProvider(
  options: CodexCliProviderOptions,
): ModelProvider {
  return {
    async complete(input, completeOptions) {
      const workdir = await mkdtemp(
        path.join(tmpdir(), "open-maintainer-codex-"),
      );
      const outputPath = path.join(workdir, "last-message.txt");
      const schemaPath = path.join(workdir, "schema.json");
      const outputSchema =
        completeOptions?.outputSchema ?? options.outputSchema;
      try {
        const args = [
          "exec",
          "--sandbox",
          "read-only",
          "--ephemeral",
          "--skip-git-repo-check",
          "--cd",
          options.cwd,
          "--output-last-message",
          outputPath,
        ];
        if (options.model) {
          args.push("--model", options.model);
        }
        if (outputSchema) {
          await writeFile(schemaPath, JSON.stringify(outputSchema));
          args.push("--output-schema", schemaPath);
        }
        args.push("-");

        const prompt = [
          input.system,
          "",
          "Return the final answer only. If an output schema is provided, return JSON that satisfies it.",
          "",
          input.user,
        ].join("\n");
        const result = await runProcess({
          label: "Codex CLI",
          command: options.command ?? codexCommand(),
          args,
          stdin: prompt,
          timeoutMs: options.timeoutMs ?? 300_000,
        });
        const text = await readFile(outputPath, "utf8").catch(
          () => result.stdout,
        );
        return {
          text: text.trim(),
          model: options.model ?? DEFAULT_CODEX_CLI_MODEL,
        };
      } finally {
        await rm(workdir, { recursive: true, force: true });
      }
    },
  };
}

export function resolveCodexCliModel(model: string | null | undefined): string {
  const normalized = model?.trim();
  return normalized && normalized !== "codex-cli"
    ? normalized
    : DEFAULT_CODEX_CLI_MODEL;
}

export function buildClaudeCliProvider(
  options: ClaudeCliProviderOptions,
): ModelProvider {
  return {
    async complete(input, completeOptions) {
      const outputSchema =
        completeOptions?.outputSchema ?? options.outputSchema;
      const args = [
        "--print",
        "--permission-mode",
        "dontAsk",
        "--add-dir",
        options.cwd,
        "--output-format",
        "json",
      ];
      if (options.model) {
        args.push("--model", options.model);
      }
      if (outputSchema) {
        args.push("--json-schema", JSON.stringify(outputSchema));
      }

      const prompt = [
        input.system,
        "",
        "Return the final answer only. If an output schema is provided, return JSON that satisfies it.",
        "",
        input.user,
      ].join("\n");
      args.push(prompt);
      const result = await runProcess({
        label: "Claude CLI",
        command: options.command ?? claudeCommand(),
        args,
        stdin: "",
        cwd: options.cwd,
        timeoutMs: options.timeoutMs ?? 300_000,
      });
      return {
        text: extractClaudeOutput(result.stdout),
        model: options.model ?? "claude-cli",
      };
    },
  };
}

export async function testProviderConnection(
  provider: ModelProvider,
): Promise<CompletionOutput> {
  return provider.complete({
    system: "You are testing connectivity for Open Maintainer.",
    user: "Reply with only: ok",
  });
}

export function redactSecret(value: string): string {
  if (value.length <= 8) {
    return "[redacted]";
  }
  return `${value.slice(0, 4)}...[redacted]...${value.slice(-4)}`;
}

function encryptForLocalDev(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function decryptForLocalDev(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function codexCommand(): string {
  return process.env["OPEN_MAINTAINER_CODEX_COMMAND"] ?? "codex";
}

function claudeCommand(): string {
  return process.env["OPEN_MAINTAINER_CLAUDE_COMMAND"] ?? "claude";
}

function extractClaudeOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      structured_output?: unknown;
      result?: unknown;
    };
    if (parsed.structured_output !== undefined) {
      return JSON.stringify(parsed.structured_output);
    }
    if (typeof parsed.result === "string") {
      return parsed.result;
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

async function runProcess(input: {
  label: string;
  command: string;
  args: string[];
  stdin: string;
  cwd?: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${input.label} timed out after ${input.timeoutMs}ms.`));
    }, input.timeoutMs);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timeout);
      const errorWithCode = error as NodeJS.ErrnoException;
      reject(
        errorWithCode.code === "ENOENT"
          ? new Error(`Executable not found in $PATH: "${input.command}"`)
          : error,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(formatProcessFailure(input.label, code)));
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
    child.stdin.end(input.stdin);
  });
}

function formatProcessFailure(label: string, code: number | null): string {
  const codeText = code === null ? "unknown" : String(code);
  return `${label} exited with code ${codeText}. CLI output was omitted because it can contain repository content.`;
}
