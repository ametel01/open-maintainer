# Open Maintainer Feature Runbook

This runbook is the hands-on validation guide for the features implemented
through `v0.4.x`. It is written so you can copy commands from the repository
root and evaluate release readiness yourself.

Repository analysis is offline and deterministic. Context generation and PR
review are LLM-backed only and require explicit credentials and consent.

## Feature Status

Implemented and testable:

- CLI audit, readiness report, deterministic repository analysis, and concrete
  next actions.
- v0.2 readiness-quality categories: setup clarity, architecture clarity,
  testing, CI, docs, risk handling, generated-file handling, and agent
  instructions.
- Repo profiling for commands, CI, docs, ownership hints, generated files,
  lockfiles, environment variables, issue templates, PR templates, risk paths,
  package boundaries, ignore files, and test files.
- Context artifact generation for Codex and Claude instruction families,
  including deterministic Contribution Quality Requirements in generated
  `AGENTS.md` and `CLAUDE.md`.
- Context preservation by default, with explicit `--force` overwrite.
- Explicit model-backed write consent through `--allow-write`.
- Doctor checks for missing required context and drift.
- Drift explanations for commands, CI, docs, templates, context artifacts,
  lock/config files, package boundaries, and risk paths.
- Dry-run context PR summary from the CLI.
- GitHub Action audit mode with no default repository mutation, Step Summary
  output, drift warnings, optional failure on drift, optional PR comments,
  scheduled stale-context checks, and opt-in refresh PRs.
- Rule-grounded PR review beta for local Git refs, including summaries,
  walkthroughs, changed-surface analysis, expected validation, docs impact,
  contribution-triage signals, cited findings, merge readiness, residual risk,
  and JSON output.
- CLI PR review posting through `gh`, with marked summary comments and capped
  duplicate-aware inline comments from a locally authenticated maintainer
  machine.
- Dashboard PR review previews, review run history, guarded posting controls,
  contribution-triage display, and false-positive feedback capture.
- Self-hosted dashboard foundation with API, worker, web, Postgres, Redis,
  provider setup, repository analysis, artifact preview, run history, and
  context PR plumbing.
- GitHub App foundation: webhook signature verification, installation metadata,
  repository fetching helpers, branch naming, and context PR body rendering.
- Issue triage beta for local CLI and explicit Action runs, including
  single-issue triage, bounded batch reports, local artifacts, opt-in
  labels/comments/closure, and second-step agent task briefs.

Not implemented yet:

- Agent orchestration.
- Hosted product.

## Prerequisites

- Bun 1.1 or newer.
- Git.
- Docker Compose for dashboard and stack checks.
- Optional: Codex CLI installed and logged in for `--model codex`.
- Optional: Claude Code CLI installed and logged in for `--model claude`.
- Optional: GitHub CLI authentication or `GH_TOKEN` for real context PRs.
- Optional: GitHub pull request permissions for opt-in review comments.

Start from the repository root:

```sh
cd /Users/alexmetelli/source/open-maintainer
bun install --frozen-lockfile
```

## Fast Release Check

Run the non-Docker release checks:

```sh
bun lint
bun typecheck
bun test
bun run build
bun run smoke:mvp
bun run cli doctor .
```

Expected high-signal output:

```text
MVP smoke passed: <before>/100 -> <after>/100
Agent Readiness: 100/100
all required artifacts are present
```

Run the Docker Compose release check:

```sh
docker compose up --build -d
bun run smoke:compose
docker compose down --volumes --remove-orphans
```

Expected output:

```text
Docker Compose smoke passed.
```

## v0.2 Readiness Quality

Run the representative readiness-quality fixture test:

```sh
bun test tests/v02-readiness.test.ts
```

This validates:

- `tests/fixtures/high-readiness-ts`: 100/100 readiness.
- `tests/fixtures/low-context-ts`: low-readiness guidance.
- `tests/fixtures/missing-context-ts`: missing Open Maintainer context guidance.
- Drift findings that identify changed surfaces instead of only reporting a
  profile hash mismatch.

Inspect each fixture manually:

```sh
bun run cli audit tests/fixtures/high-readiness-ts --no-profile-write --report-path /tmp/open-maintainer-high.md
bun run cli audit tests/fixtures/low-context-ts --no-profile-write --report-path /tmp/open-maintainer-low.md
bun run cli audit tests/fixtures/missing-context-ts --no-profile-write --report-path /tmp/open-maintainer-missing-context.md

sed -n '1,180p' /tmp/open-maintainer-high.md
sed -n '1,180p' /tmp/open-maintainer-low.md
sed -n '1,180p' /tmp/open-maintainer-missing-context.md
```

The high-readiness report should show all categories complete. The low and
missing-context reports should include concrete missing items and evidence.

## CLI Audit And Report

Human-readable CLI commands render colored banners, boxed summaries, and action
tables. Use `NO_COLOR=1` or `OPEN_MAINTAINER_NO_COLOR=1` when copying output to
plain logs. `--json` output stays machine-readable and unstyled.

Use a disposable copy when testing write behavior:

```sh
RUN_ROOT="$(mktemp -d)"
cp -R tests/fixtures/low-context-ts "$RUN_ROOT/widget-api"
TARGET_REPO="$RUN_ROOT/widget-api"
```

Audit the repository:

```sh
bun run cli audit "$TARGET_REPO"
```

Expected output includes:

```text
Agent Readiness: <score>/100
Profile: .open-maintainer/profile.json
Report: .open-maintainer/report.md
Next steps:
```

Inspect the generated report:

```sh
sed -n '1,220p' "$TARGET_REPO/.open-maintainer/report.md"
```

Check threshold behavior:

```sh
bun run cli audit "$TARGET_REPO" --fail-on-score-below 100
```

Expected result: non-zero exit because the low-context fixture is intentionally
below 100 before context generation.

Preview the same command without writing profile or report files:

```sh
bun run cli audit "$TARGET_REPO" --dry-run
```

Expected output includes `Mode: dry-run`, planned profile/report paths, and a
`Dry run: no audit files written.` safety line.

## LLM Context Generation

Generate the Codex artifact family with explicit model-write consent:

```sh
bun run cli generate "$TARGET_REPO" \
  --model codex \
  --allow-write \
  --context codex \
  --skills codex
```

Preview context generation before writing artifacts:

```sh
bun run cli generate "$TARGET_REPO" \
  --model codex \
  --allow-write \
  --context codex \
  --skills codex \
  --dry-run
```

Expected output lists the planned `write`, `overwrite`, `skip`, or `remove`
actions and ends with `Dry run: no context artifacts written.`.

List generated files:

```sh
find "$TARGET_REPO" \
  -path "$TARGET_REPO/node_modules" -prune -o \
  -type f \
  | sed "s#^$TARGET_REPO/##" \
  | sort
```

Expected generated files include:

```text
AGENTS.md
.agents/skills/<repo>-start-task/SKILL.md
.agents/skills/<repo>-testing-workflow/SKILL.md
.agents/skills/<repo>-pr-review/SKILL.md
.open-maintainer/profile.json
.open-maintainer/report.md
.open-maintainer.yml
```

Generated `AGENTS.md` and `CLAUDE.md` include a deterministic
`Contribution Quality Requirements` section. That section asks contributors for
clear reproduction or acceptance criteria, scoped PRs, validation evidence, docs
updates for public behavior changes, high-risk rationale, and the boundary that
Open Maintainer evaluates reviewability rather than whether the author used AI.

Run audit again and verify the score improves:

```sh
bun run cli audit "$TARGET_REPO"
```

Run doctor:

```sh
bun run cli doctor "$TARGET_REPO"
```

Expected output:

```text
all required artifacts are present
```

When using `--fix`, add `--dry-run` first to preview removable obsolete
generated artifacts, stale local operational artifacts, and profile refreshes
without changing the checkout:

```sh
bun run cli doctor "$TARGET_REPO" --fix --dry-run
```

Print the dry-run context PR summary:

```sh
bun run cli pr "$TARGET_REPO" --create
```

Expected output includes a branch name and readiness score. This CLI command
does not push a branch.

## Init Shortcut

`init` runs audit and then generates missing artifacts:

```sh
INIT_ROOT="$(mktemp -d)"
cp -R tests/fixtures/low-context-ts "$INIT_ROOT/widget-api"

bun run cli init "$INIT_ROOT/widget-api" \
  --model codex \
  --allow-write \
  --context codex \
  --skills codex

bun run cli doctor "$INIT_ROOT/widget-api"
```

Expected output:

```text
Initialized Open Maintainer context at score <score>/100.
all required artifacts are present
```

## Safety And Consent

Model-backed generation fails without explicit consent:

```sh
CONSENT_ROOT="$(mktemp -d)"
cp -R tests/fixtures/low-context-ts "$CONSENT_ROOT/widget-api"

bun run cli generate "$CONSENT_ROOT/widget-api" \
  --model codex \
  --context codex \
  --skills codex
```

Expected result: non-zero exit with an error requiring `--allow-write`.

Model-backed generation preserves existing files by default:

```sh
bun run cli generate "$TARGET_REPO" \
  --model codex \
  --allow-write \
  --context codex \
  --skills codex
```

Expected output includes `skip:` entries for existing files.

Use `--force` only when overwriting generated artifacts is intentional:

```sh
bun run cli generate "$TARGET_REPO" \
  --model codex \
  --allow-write \
  --context codex \
  --skills codex \
  --force
```

## LLM Provider Selection

Confirm the selected CLI is available:

```sh
codex --version
claude --version
```

Optionally choose backend models:

```sh
export OPEN_MAINTAINER_CODEX_MODEL="gpt-5.5"
export OPEN_MAINTAINER_CLAUDE_MODEL="claude-sonnet-4-6"
```

Current Codex model choices:

| Model | Recommended use |
| --- | --- |
| `gpt-5.5` | Current frontier model for complex coding, research, and real-world work. |
| `gpt-5.4` | Strong model for everyday coding. |
| `gpt-5.4-mini` | Small, fast, and cost-efficient model for simpler coding tasks. |
| `gpt-5.3-codex` | Coding-optimized model. |
| `gpt-5.3-codex-spark` | Ultra-fast coding model. |
| `gpt-5.2` | Optimized for professional work and long-running agents. |

Generate Codex context with explicit consent:

```sh
LLM_ROOT="$(mktemp -d)"
cp -R tests/fixtures/low-context-ts "$LLM_ROOT/widget-api"

bun run cli generate "$LLM_ROOT/widget-api" \
  --model codex \
  --context codex \
  --skills codex \
  --allow-write
```

Generate Claude Code context with explicit consent:

```sh
bun run cli generate "$LLM_ROOT/widget-api" \
  --model claude \
  --context claude \
  --skills claude \
  --allow-write \
  --force
```

Generate both instruction families with one model backend:

```sh
bun run cli generate "$LLM_ROOT/widget-api" \
  --model codex \
  --context both \
  --skills both \
  --allow-write \
  --force
```

Override the backend model for one run:

```sh
bun run cli generate "$LLM_ROOT/widget-api" \
  --model codex \
  --llm-model "gpt-5.5" \
  --context codex \
  --skills codex \
  --allow-write \
  --force
```

## Drift Detection

Create a disposable repo, generate context, then change a command:

```sh
DRIFT_ROOT="$(mktemp -d)"
cp -R tests/fixtures/low-context-ts "$DRIFT_ROOT/widget-api"

bun run cli generate "$DRIFT_ROOT/widget-api" \
  --model codex \
  --allow-write \
  --context codex \
  --skills codex

node -e '
const fs = require("node:fs");
const path = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.scripts.typecheck = "tsc --noEmit";
fs.writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
' "$DRIFT_ROOT/widget-api/package.json"

bun run cli doctor "$DRIFT_ROOT/widget-api"
```

Expected output includes:

```text
drift: command package.json script typecheck was added: "tsc --noEmit"
```

Run the broader drift regression tests:

```sh
bun test tests/cli-doctor.test.ts
```

Those tests cover command, CI, docs, template, context artifact, lock/config,
package-boundary, and risk-path drift.

## GitHub Action

Validate the local action metadata and workflow behavior:

```sh
bun test tests/action-mvp.test.ts
```

The action supports:

- `mode: audit`
- `mode: refresh`
- `fail-on-score-below`
- `report-path`
- `fail-on-drift`
- `comment-on-pr`
- `github-token`
- `generation-provider`
- `generation-model`
- `allow-model-content-transfer`
- `context-target`
- `skills-target`
- `refresh-branch`
- `refresh-title`
- `force`
- `issue-number`
- `issue-state`
- `issue-limit`
- `issue-label`
- `issue-apply-labels`
- `issue-create-labels`
- `issue-post-comment`
- `issue-close-allowed`

Audit-only workflow shape:

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

Expected behavior:

- `mode: audit` is non-mutating by default.
- Every run writes a GitHub Step Summary with readiness, drift, changed surface,
  likely tests, likely docs impact, missing validation evidence, and refresh
  recommendation sections.
- Pull request runs include a readiness delta when the base can be fetched.
- Scheduled and manual runs do not require `github.event.pull_request` fields.
- `fail-on-drift: "true"` fails scheduled stale-context checks when drift is
  detected.

Optional PR comments reuse the Step Summary body and require write permission:

```yaml
permissions:
  contents: read
  issues: write
  pull-requests: read

steps:
  - uses: actions/checkout@v6
  - uses: open-maintainer/action@v1
    with:
      mode: audit
      comment-on-pr: "true"
```

Opt-in model-backed refresh PRs require write permissions and consent:

```yaml
permissions:
  contents: write
  pull-requests: write

steps:
  - uses: actions/checkout@v6
  - uses: open-maintainer/action@v1
    with:
      mode: refresh
      generation-provider: codex
      allow-model-content-transfer: "true"
      context-target: codex
      skills-target: codex
```

Expected refresh behavior:

- No branch is pushed and no PR is opened unless `mode: refresh` is set.
- The action never pushes to the default branch.
- The default branch is `open-maintainer/context-refresh`.
- Existing generated Open Maintainer files can be refreshed.
- Existing maintainer-owned context files are preserved unless `force: "true"`
  is set.
- Repeated runs update the existing refresh PR for the branch.

Model-backed refresh requires explicit provider selection and consent:

```yaml
steps:
  - uses: actions/checkout@v6
  - uses: open-maintainer/action@v1
    with:
      mode: refresh
      generation-provider: codex
      generation-model: gpt-5.5
      allow-model-content-transfer: "true"
      context-target: both
      skills-target: both
```

Without `allow-model-content-transfer: "true"`, `generation-provider: codex`
or `generation-provider: claude` fails before generation starts.

### Action Issue Triage

Action issue triage is separate from PR review and does not run on pull request
events. Use it from `issues`, `schedule`, or `workflow_dispatch` workflows.
It requires explicit repository-content transfer consent because issue evidence
and repository context are sent to the selected model CLI.

Read-only single-issue example:

```yaml
permissions:
  contents: read
  issues: read

steps:
  - uses: actions/checkout@v6
  - uses: open-maintainer/action@v1
    with:
      mode: issue-triage
      issue-number: "82"
      generation-provider: codex
      allow-model-content-transfer: "true"
```

Opt-in write example:

```yaml
permissions:
  contents: read
  issues: write

steps:
  - uses: actions/checkout@v6
  - uses: open-maintainer/action@v1
    with:
      mode: issue-triage
      issue-state: open
      issue-limit: "5"
      generation-provider: codex
      allow-model-content-transfer: "true"
      issue-apply-labels: "true"
      issue-create-labels: "true"
      issue-post-comment: "true"
```

Expected behavior:

- Default issue triage writes only console output, the Step Summary, and local
  `.open-maintainer/triage` artifacts in the runner.
- `issue-apply-labels`, `issue-create-labels`, `issue-post-comment`, and
  `issue-close-allowed` are independent explicit write gates.
- `issue-create-labels` fails unless `issue-apply-labels` is also true.
- `issue-close-allowed` still requires repository closure config in
  `.open-maintainer.yml`.
- The action rejects `mode: issue-triage` on `pull_request` events.

## v0.5 Issue Triage And Task Briefs

The first useful local path is a single issue triage run. It requires a local
model CLI and explicit repository-content transfer consent:

```sh
bun run cli triage issue . \
  --number 82 \
  --model codex \
  --allow-model-content-transfer
```

The bounded batch path uses the same consent gate:

```sh
bun run cli triage issues . \
  --state open \
  --limit 5 \
  --model codex \
  --allow-model-content-transfer
```

Expected local outputs:

- Per-issue artifacts: `.open-maintainer/triage/issues/<number>.json`
- Batch reports: `.open-maintainer/triage/runs/<run-id>.json`
- Batch Markdown reports: `.open-maintainer/triage/runs/<run-id>.md`
- Console summaries for classification, agent readiness, label actions,
  comment actions, closure actions, and artifact paths.

Treat `.open-maintainer/triage/` as local operational history. The artifacts
record model/provider metadata, evidence, recommended author actions, rendered
comment previews, write actions, and task brief payloads. They are intended for
maintainer inspection and release evidence, not for automatic GitHub writes.

Default issue triage does not apply labels, create labels, post comments, close
issues, dispatch agents, create branches, run validation, or open pull requests.
GitHub writes require explicit flags:

```sh
bun run cli triage issue . \
  --number 82 \
  --model codex \
  --allow-model-content-transfer \
  --apply-labels \
  --create-labels \
  --post-comment
```

Add `--dry-run` to preview both local artifact writes and any requested GitHub
label/comment/closure actions without applying them:

```sh
bun run cli triage issue . \
  --number 82 \
  --model codex \
  --allow-model-content-transfer \
  --apply-labels \
  --post-comment \
  --dry-run
```

For batch triage, `--dry-run` also suppresses `.open-maintainer/triage/runs/`
report writes while still printing planned report paths.

Selective closure is narrower: pass `--close-allowed` and configure supported
`issueTriage.closure` keys in `.open-maintainer.yml`. Only `possible_spam` and
stale `needs_author_input` issues are eligible, and closure caps plus comment
requirements are recorded in each artifact's write actions.

Agent task briefs are a second step from an existing local triage artifact. They
do not refetch GitHub evidence or call the model provider:

```sh
bun run cli triage brief . --number 82
```

By default briefs are generated only for `agent_ready` issues. Use
`--allow-non-agent-ready` only after a maintainer accepts the risks; the brief
records the override and escalation boundaries.
Add `--dry-run` to preview the brief markdown without updating the local triage
artifact or writing `--output-path`.

## v0.4.x Rule-Grounded PR Review And Contribution Triage

Create a disposable Git repository with a real base/head diff:

```sh
REVIEW_ROOT="$(mktemp -d)"
cp -R tests/fixtures/high-readiness-ts "$REVIEW_ROOT/review-fixture"
REVIEW_REPO="$REVIEW_ROOT/review-fixture"

git -C "$REVIEW_REPO" init -b main
git -C "$REVIEW_REPO" config user.email "review@example.com"
git -C "$REVIEW_REPO" config user.name "Review Tester"
git -C "$REVIEW_REPO" add .
git -C "$REVIEW_REPO" commit -m "initial fixture"

printf '\nexport const reviewValue = 42;\n' >> "$REVIEW_REPO/src/index.ts"
git -C "$REVIEW_REPO" add src/index.ts
git -C "$REVIEW_REPO" commit -m "change fixture"
```

Generate a check-output-only review with explicit repository-content transfer
consent:

```sh
bun run cli review "$REVIEW_REPO" \
  --base-ref HEAD~1 \
  --head-ref HEAD \
  --pr-number 123 \
  --model codex \
  --allow-model-content-transfer \
  --output-path .open-maintainer/review.md

sed -n '1,220p' "$REVIEW_REPO/.open-maintainer/review.md"
```

Expected review sections include:

```text
## Summary
## Walkthrough
## Contribution Triage
## Findings
## Required Validation For This PR
## Merge Readiness
## Residual Risk
```

Print compact numbered feedback for an agent loop:

```sh
bun run cli review "$REVIEW_REPO" \
  --base-ref HEAD~1 \
  --head-ref HEAD \
  --model codex \
  --allow-model-content-transfer \
  --format agent-feedback
```

Expected compact output starts with `Open Maintainer agent feedback`, includes
finding type definitions, and renders findings as stable numbered comments.

Contribution triage appears inside the review output and uses categorical,
evidence-based outcomes such as `ready_for_review`, `needs_author_input`,
`needs_maintainer_design`, `not_agent_ready`, or `possible_spam`. Open
Maintainer evaluates reviewability, scope, evidence, validation, and repo
alignment. It does not evaluate whether the author used AI. Issue triage, issue
labels/comments, duplicate handling, stale handling, auto-close, and agent task
briefs are outside this PR review path.

Print the machine-readable review result:

```sh
bun run cli review "$REVIEW_REPO" \
  --base-ref HEAD~1 \
  --head-ref HEAD \
  --model codex \
  --allow-model-content-transfer \
  --json
```

Expected JSON includes a `contributionTriage` object. Model-backed reviews set
`status: "evaluated"` with one categorical result. Legacy or deterministic
review-shaped objects without model classification use `status:
"not_evaluated"` and do not assign a category.

Model-backed review requires explicit repository-content transfer consent:

```sh
bun run cli review "$REVIEW_REPO" \
  --base-ref HEAD~1 \
  --head-ref HEAD \
  --model codex \
  --llm-model gpt-5.5 \
  --allow-model-content-transfer \
  --output-path .open-maintainer/review.md
```

`review` uses the same `--model` and `--llm-model` flag names as context
generation. Existing scripts that use `--review-provider` or `--review-model`
continue to work as aliases.

Review a real GitHub PR from the local checkout with locally authenticated
`gh` and model CLI credentials. This fetches PR metadata and refs, generates a
model-backed review, updates one marked summary comment, opens a capped inline
review with finding recommendations, and can apply one filterable contribution
triage label. Normal PR posting output stays concise and reports whether
comments or labels were posted; add `--output-path` or `--json` when you need
the full generated review:

```sh
bun run cli review . \
  --pr 123 \
  --model codex \
  --llm-model gpt-5.5 \
  --allow-model-content-transfer \
  --review-apply-triage-label \
  --review-create-triage-labels
```

The label is derived from the LLM contribution-triage category and is intended
for GitHub PR list filtering. Missing Open Maintainer labels are created only
when `--review-create-triage-labels` is present. GitHub PR state is supplied to
the model prompt, and the CLI refuses to apply `open-maintainer/ready-for-review`
when GitHub reports objective blockers such as draft status, merge conflicts,
dirty merge state, requested changes, or failed/pending checks.

Preview the same PR review without GitHub writes:

```sh
bun run cli review . \
  --pr 123 \
  --model claude \
  --allow-model-content-transfer \
  --dry-run
```

`--review-post-summary`, `--review-inline-comments`, and
`--review-inline-cap` can narrow posting behavior when `--pr` is used.
Posting flags without `--pr` fail before any GitHub write because there is no
target pull request.

Run focused review tests:

```sh
bun test packages/review
bun test tests/cli-review.test.ts
```

Run the Action audit/refresh coverage:

```sh
bun test tests/action-mvp.test.ts
```

## API, Providers, GitHub Helpers, And Context PRs

Run API contract and dashboard action tests:

```sh
bun test apps/api/tests/api.test.ts
```

Run provider guard tests:

```sh
bun test packages/ai/tests/provider.test.ts
```

Run GitHub helper and webhook tests:

```sh
bun test packages/github/tests/webhook.test.ts
```

Run context rendering tests:

```sh
bun test packages/context/tests/render.test.ts
```

Together these validate:

- `/health`, repository registration, analysis, provider actions, artifact
  generation, PR review preview, contribution-triage round trips, finding
  feedback, run history, retryable failures, guarded posting controls, and
  local PR plumbing.
- Provider consent guards and CLI provider execution shape.
- Webhook signature verification and installation metadata mapping.
- Bounded repository content fetching.
- Context branch naming, PR body rendering, preservation of existing context
  files, and existing PR updates.
- Context artifact schema, profile fingerprints, renderer output, and
  model-output parsing, including deterministic Contribution Quality
  Requirements rendering.

## Self-Hosted Dashboard Stack

Create `.env` if it does not exist:

```sh
test -f .env || cp .env.example .env
```

Start the stack:

```sh
docker compose up --build -d
```

Open:

```text
http://localhost:3000
```

Run health diagnostics:

```sh
bun run diagnostics
```

Check launch-time auth readiness:

```sh
curl -sSf http://localhost:4000/auth/ready | jq
```

With `OPEN_MAINTAINER_STRICT_STARTUP_AUTH=false`, this endpoint may report
`authReady: false` while the dashboard still starts in degraded mode. With
strict mode enabled, the API must pass `gh`, `codex`, and `claude` auth checks
before web and worker services are allowed to start.

Run the compose smoke gate:

```sh
bun run smoke:compose
```

Expected output:

```text
Docker Compose smoke passed.
```

Check provider CLIs inside the API container when testing LLM-backed dashboard
generation or review:

```sh
docker exec open-maintainer-api-1 codex --version
docker exec open-maintainer-api-1 claude --version
```

Context PR creation from the dashboard requires authenticated GitHub CLI inside
the API container. Set these values in `.env`:

```sh
GH_TOKEN=github_pat_xxx
OPEN_MAINTAINER_GIT_AUTHOR_NAME="Open Maintainer"
OPEN_MAINTAINER_GIT_AUTHOR_EMAIL="open-maintainer@users.noreply.github.com"
OPEN_MAINTAINER_STRICT_STARTUP_AUTH=false
```

Recommended minimum fine-grained GitHub token permissions for dashboard context
PR writes:

- `Contents`: Read and write.
- `Pull requests`: Read and write.
- Optional: `Issues`: Read and write for comment-posting surfaces.

If your org enforces SSO, authorize the token for that organization.

Recreate the API container after changing `.env`:

```sh
docker compose up -d --force-recreate api
docker exec open-maintainer-api-1 gh auth status
```

For OAuth-backed model CLIs, authenticate on the host and rely on mounted auth
directories:

```sh
codex login
claude login
docker compose up -d --force-recreate api
```

If `GET /auth/ready` shows `codexAuth` or `claudeAuth` as `missing`, renew the
host login session and recreate the API container.

Dashboard PR review preview requires a registered local repository worktree.
After selecting and analyzing a repository, use the `PR Review` panel to enter
base/head refs and preview a review. The dashboard shows the full review before
any GitHub write, displays contribution-triage signals, records the review run
in history, and captures finding feedback such as false positives with optional
reasons.

Stop the stack:

```sh
docker compose down --volumes --remove-orphans
```

## GitHub App Setup

Create a GitHub App with these MVP permissions:

- Repository metadata: read.
- Repository contents: write.
- Pull requests: write.

Configure the webhook URL:

```text
http://localhost:4000/github/webhook
```

Set matching values in `.env`:

```sh
GITHUB_APP_ID=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_PRIVATE_KEY_BASE64=
GITHUB_WEBHOOK_SECRET=
```

Local webhook and installation behavior is covered by:

```sh
bun test packages/github/tests/webhook.test.ts apps/api/tests/api.test.ts
```

## Troubleshooting Checks

Print CLI help:

```sh
bun run cli --help
bun run cli audit --help
bun run cli generate --help
bun run cli doctor --help
bun run cli pr --help
```

Check current repository readiness:

```sh
bun run cli audit . --no-profile-write --report-path /tmp/open-maintainer-current.md
sed -n '1,220p' /tmp/open-maintainer-current.md
bun run cli doctor .
```

Check Docker service status:

```sh
docker compose ps
docker compose logs --no-color api worker web
```

Clean up disposable fixture copies:

```sh
rm -rf "$RUN_ROOT" "$INIT_ROOT" "$CONSENT_ROOT" "$LLM_ROOT" "$DRIFT_ROOT" "$REVIEW_ROOT"
```
