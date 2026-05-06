# Open Maintainer

Open-source, self-hostable maintenance tooling for GitHub repositories that turns repo reality into durable AI-agent context, rule-grounded PR review, and agent-safe issue triage.

[![CI](https://github.com/Open-Maintainer/open-maintainer/actions/workflows/ci.yml/badge.svg)](https://github.com/Open-Maintainer/open-maintainer/actions/workflows/ci.yml)
[![Docker Compose Smoke](https://github.com/Open-Maintainer/open-maintainer/actions/workflows/compose-smoke.yml/badge.svg)](https://github.com/Open-Maintainer/open-maintainer/actions/workflows/compose-smoke.yml)
[![CodeQL](https://github.com/Open-Maintainer/open-maintainer/actions/workflows/codeql.yml/badge.svg)](https://github.com/Open-Maintainer/open-maintainer/actions/workflows/codeql.yml)
[![Open Maintainer Audit](https://github.com/Open-Maintainer/open-maintainer/actions/workflows/open-maintainer-audit.yml/badge.svg)](https://github.com/Open-Maintainer/open-maintainer/actions/workflows/open-maintainer-audit.yml)

## Overview

Most repositories encode engineering practice in maintainer memory: setup rules, test commands, risky paths, generated files, review expectations, and agent instructions are scattered or implicit.

Open Maintainer scans a repository, records evidence-backed repo facts, generates reviewable context artifacts, detects context drift, and uses that context to help maintainers review PRs and triage issues without silently mutating GitHub state.

It is built for OSS maintainers, small engineering teams, and AI-heavy teams that want transparent, versioned repo context instead of opaque automation.

## Features

- Audit repository structure, language, tooling, CI, docs, risk paths, generated files, and agent readiness.
- Generate `AGENTS.md`, `CLAUDE.md`, `.open-maintainer.yml`, repo profiles, reports, and repo-local skills.
- Detect stale or missing generated context with `doctor`.
- Review pull requests against repo-specific rules, changed files, expected validation, and generated context.
- Triage GitHub issues into maintainer actions and agent-safe task briefs.
- Run as a local CLI, GitHub Action, or self-hosted dashboard with API, worker, Postgres, Redis, and GitHub App foundations.
- Preserve existing context files by default and require explicit consent before repository content is sent to a model provider.

## Requirements

- Bun 1.1 or newer. CI currently uses Bun 1.3.13.
- Git.
- Docker Compose for the self-hosted dashboard stack.
- Optional: Codex CLI or Claude Code CLI for model-backed generation, review, and triage.
- Optional: GitHub CLI authentication or `GH_TOKEN` for GitHub PR and issue writes.
- Optional: GitHub App credentials for installation and webhook testing.

## Installation

Open Maintainer is currently used from a source checkout.

```sh
git clone https://github.com/Open-Maintainer/open-maintainer.git
cd open-maintainer
bun install --frozen-lockfile
```

## Quick Start

Run a read-only audit against the current repository:

```sh
bun run cli audit . --no-profile-write --report-path /tmp/open-maintainer-report.md
bun run cli doctor .
```

Expected output includes:

```text
Agent Readiness: 100/100
Profile: skipped (--no-profile-write)
Report: ../../../../tmp/open-maintainer-report.md
all required artifacts are present
```

To audit another repository, pass its path or GitHub URL:

```sh
bun run cli audit /path/to/repo
bun run cli audit https://github.com/OWNER/REPO
```

## Usage

Analyze a repository and write `.open-maintainer/profile.json` plus `.open-maintainer/report.md`:

```sh
bun run cli audit /path/to/repo
```

For GitHub URL inputs, Open Maintainer creates a temporary checkout, runs the same CLI logic, copies relative artifacts under `.open-maintainer/url-repos/OWNER/REPO`, and removes the checkout:

```sh
bun run cli audit https://github.com/OWNER/REPO
```

Generate Codex context and skills after explicitly allowing model-backed writes:

```sh
bun run cli generate /path/to/repo \
  --model codex \
  --context codex \
  --skills codex \
  --allow-write
```

Generate both Codex and Claude context families:

```sh
bun run cli generate /path/to/repo \
  --model codex \
  --context both \
  --skills both \
  --allow-write
```

Check for missing or stale generated context:

```sh
bun run cli doctor /path/to/repo
```

Produce a local rule-grounded PR review:

```sh
bun run cli review /path/to/repo \
  --base-ref origin/main \
  --head-ref HEAD \
  --model codex \
  --allow-model-content-transfer \
  --output-path .open-maintainer/review.md
```

Print compact numbered feedback intended for an agent loop:

```sh
bun run cli review /path/to/repo \
  --base-ref origin/main \
  --head-ref HEAD \
  --model codex \
  --allow-model-content-transfer \
  --format agent-feedback
```

Review a GitHub PR without posting comments:

```sh
bun run cli review https://github.com/OWNER/REPO \
  --pr 123 \
  --model codex \
  --allow-model-content-transfer \
  --dry-run
```

Triage one issue from a GitHub URL:

```sh
bun run cli triage issue https://github.com/OWNER/REPO \
  --number 82 \
  --model codex \
  --allow-model-content-transfer \
  --dry-run
```

Triage a bounded issue batch from a GitHub URL:

```sh
bun run cli triage issues https://github.com/OWNER/REPO \
  --limit 5 \
  --model codex \
  --allow-model-content-transfer \
  --dry-run
```

Print command help:

```sh
bun run cli help
bun run cli help generate
```

### CLI Flags

Run `bun run cli help <command>` for full command help. README coverage tracks the supported flags so docs drift is caught in tests.

- `audit`: `--fail-on-score-below`, `--report-path`, `--no-profile-write`, `--dry-run`.
- `generate`: `--context`, `--skills`, `--model`, `--llm-model`, `--allow-write`, `--force`, `--refresh-generated`, `--dry-run`.
- `init`: `--fail-on-score-below`, `--report-path`, `--no-profile-write`, `--model`, `--context`, `--skills`, `--llm-model`, `--allow-write`, `--force`, `--refresh-generated`, `--dry-run`.
- `doctor`: `--fix`, `--dry-run`.
- `review`: `--pr`, `--base-ref`, `--head-ref`, `--pr-number`, `--output-path`, `--format`, `--json`, `--dry-run`, `--model`, `--llm-model`, `--allow-model-content-transfer`, `--review-provider`, `--review-model`, `--review-post-summary`, `--review-inline-comments`, `--review-inline-cap`, `--review-apply-triage-label`, `--review-create-triage-labels`.
- `triage`: `--number`, `--state`, `--limit`, `--label`, `--include-label`, `--exclude-label`, `--only`, `--min-confidence`, `--format`, `--output`, `--apply`, `--apply-labels`, `--create-missing-preset-labels`, `--create-labels`, `--post-comment`, `--close-allowed`, `--dry-run`, `--allow-non-agent-ready`, `--output-path`, `--model`, `--allow-model-content-transfer`, `--llm-model`, `--json`.
- `pr`: `--create`, `--dry-run`.

## Configuration

Open Maintainer writes repository policy and generated metadata to `.open-maintainer.yml`.

Minimal shape:

```yaml
version: 1
repo:
  profileVersion: 1
  defaultBranch: main
rules:
  - Run the repository quality gates before merging.
generated:
  by: open-maintainer
  artifactVersion: 2
  generatedAt: "2026-05-04T00:00:00.000Z"
```

Issue triage can add optional guardrails for labels, comments, batch selection, and selective closure:

```yaml
issueTriage:
  mode: advisory
  closure:
    allowPossibleSpam: false
    allowStaleAuthorInput: false
    maxClosuresPerRun: 0
    requireCommentBeforeClose: true
  labels:
    preferUpstream: true
    createMissingPresetLabels: false
```

Optional local artifact retention can remove stale operational artifacts from `.open-maintainer/triage/**`, `.open-maintainer/reviews/**`, and `.open-maintainer/runs/**` through `doctor --fix` without treating generated context artifacts as retention targets:

```yaml
retention:
  localArtifactsMaxAgeDays: 30
```

`audit` and `doctor` surface `.open-maintainer.yml` diagnostics. Unknown optional keys warn and are ignored; invalid required safety metadata fails the command.

Add `.open-maintainerignore` beside `.gitignore` to exclude repository content from analyzer scans, local review diffs, and dashboard uploads. It uses gitignore-style rules, including later `!` negation, while hard safety skips such as binary files and dependency/build directories still apply.

Existing generated context is preserved by default. Use `--refresh-generated` to refresh only Open Maintainer generated files, or `--force` only when overwriting generated artifacts is intentional.

## GitHub Action

The default action mode is non-mutating. It audits readiness, checks context drift, and writes a GitHub Step Summary.

```yaml
name: Open Maintainer

on:
  pull_request:
  schedule:
    - cron: "17 9 * * 1"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: open-maintainer/action@v1
        with:
          mode: audit
          fail-on-score-below: "60"
          fail-on-drift: "true"
```

Opt-in refresh PRs and issue triage require explicit mode, permissions, provider selection, and `allow-model-content-transfer: "true"` before repository content is sent to a model CLI.

## Self-Hosted Dashboard

Start the local dashboard, API, worker, Postgres, and Redis stack:

```sh
cp .env.example .env
bun install --frozen-lockfile
docker compose up --build
```

Open the dashboard at `http://localhost:3000`. The API listens on `http://localhost:4000`.

Run stack checks after services are up:

```sh
bun run diagnostics
bun run smoke:compose
```

The API exposes launch-time auth readiness at `GET /auth/ready` and supports strict startup mode through `OPEN_MAINTAINER_STRICT_STARTUP_AUTH=true`. By default, strict mode is off: the API starts, web and worker wait for API health, and `/auth/ready` reports `authReady: false` with per-tool error details when auth is missing. In strict mode, API startup fails until all required CLI auth checks pass (`gh`, `codex`, and `claude`).

For real dashboard GitHub writes (`Open PR with gh`), use a token with minimum fine-grained repository permissions:

- `Contents`: Read and write.
- `Pull requests`: Read and write.
- Optional: `Issues`: Read and write when using summary/issue comment posting surfaces.

If your organization enforces SSO, authorize the token for that org.

For OAuth-backed LLM CLIs, authenticate on the host and keep the mounted auth directories available to the API container:

- `codex login` and `claude login` on the host.
- Compose mounts `${HOME}/.codex`, `${HOME}/.claude`, and `${HOME}/.config` into the API container.

If OAuth sessions expire, re-authenticate on the host and recreate the API container:

```sh
docker compose up -d --force-recreate api
```

For real GitHub App testing, configure `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY_BASE64`, and `GITHUB_WEBHOOK_SECRET` in `.env`.

## Architecture

Open Maintainer is a Bun and TypeScript monorepo:

- `apps/cli`: local audit, generation, doctor, PR review, issue triage, and context PR commands.
- `apps/api`: Fastify API for health, repository analysis, uploads, GitHub settings, and dashboard workflows.
- `apps/web`: Next/React dashboard.
- `apps/worker`: background worker process.
- `packages/analyzer`: repository scanning and readiness profiling.
- `packages/context`: generated artifact planning, rendering, and drift detection.
- `packages/review`: rule-grounded PR review input assembly and rendering.
- `packages/triage`: issue triage workflow, labels, comments, and task briefs.
- `packages/github`, `packages/ai`, `packages/db`, `packages/config`, and `packages/shared`: integration, provider, persistence, config, and shared contracts.

The product loop is:

```text
audit repository
-> generate context and policy
-> detect drift
-> review PRs against context
-> triage issues into agent-safe tasks
-> keep GitHub writes explicit and auditable
```

## Documentation

- [Product requirements](docs/PRODUCT_PRD.md)
- [Roadmap](docs/ROADMAP.md)
- [MVP release review](docs/MVP_RELEASE_REVIEW.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Self-hosted stack configuration](.env.example)
- [GitHub Action definition](action.yml)

## Project Status

Open Maintainer is in active development.

Shipped or beta surfaces include repository audit, readiness reporting, context generation, drift detection, GitHub Action audit/refresh flows, rule-grounded PR review, issue triage, and the self-hosted dashboard foundation.

Agent orchestration, durable self-hosted hardening, org policy, and hosted packaging are planned or experimental tracks. See [Roadmap](docs/ROADMAP.md) for the current milestone sequence and completion criteria.

## Quality Gates

Use focused checks while iterating. The broad non-Docker gate is:

```sh
bun lint
bun typecheck
bun test
bun run build
bun run smoke:mvp
```

When Docker is available, also run:

```sh
docker compose up --build -d
bun run smoke:compose
docker compose down --volumes --remove-orphans
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, local development commands, quality gates, PR expectations, and safety notes.

## Security

Do not open public issues for vulnerabilities or secrets. See [SECURITY.md](SECURITY.md) for responsible disclosure.

Repository content is sent to model providers only after explicit consent flags such as `--allow-write` or `--allow-model-content-transfer`. GitHub writes are opt-in, reviewable, and tied to maintainer-controlled commands, Action inputs, or dashboard controls.

## License

Licensed under the [MIT License](LICENSE).
