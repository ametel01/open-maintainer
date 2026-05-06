import type {
  AuthReadiness,
  ReviewResult,
  RunRecord,
} from "@open-maintainer/shared";
import { LocalRepoPicker } from "./LocalRepoPicker";
import {
  type RunWithContext,
  type SearchParams,
  findPrUrl,
  loadDashboardViewModel,
} from "./dashboard-view-model";

type DashboardProps = {
  searchParams?: Promise<SearchParams>;
};

export default async function Dashboard({ searchParams }: DashboardProps) {
  const params: SearchParams = searchParams ? await searchParams : {};
  const view = await loadDashboardViewModel({ searchParams: params });
  const {
    health,
    authReadiness,
    repos,
    repo,
    profile,
    artifacts,
    runs,
    latestReview,
    providers,
    selectedProvider,
    defaultArtifactSelection,
    readiness,
    prStatus,
    contextActionLabel,
  } = view;
  const { localRepoError, actionError, providerError } = view.errors;
  const authWarning = authReadinessMessage(authReadiness);

  return (
    <main>
      <div className="shell">
        <header className="topbar">
          <div>
            <p className="muted">Self-hosted context PR workflow</p>
            <h1>Open Maintainer</h1>
          </div>
          <span className={health?.status === "ok" ? "badge" : "badge warn"}>
            {health?.status ?? "setup needed"}
          </span>
        </header>

        <section className="grid" aria-label="Service health">
          <StatusCard label="API" value={health?.api} />
          <StatusCard label="Postgres" value={health?.database} />
          <StatusCard label="Redis" value={health?.redis} />
          <StatusCard label="Worker" value={health?.worker} />
          <StatusCard
            label="Auth"
            value={
              authReadiness?.authReady
                ? "ok"
                : authReadiness
                  ? "missing"
                  : undefined
            }
          />
        </section>
        {authWarning ? <p className="error">{authWarning}</p> : null}

        <section className="columns">
          <div className="panel">
            <div className="panel-heading">
              <h2>Repository</h2>
              <span className="count">{repos.length} installed</span>
            </div>
            <LocalRepoPicker error={localRepoError} />
            {repos.length ? (
              <div className="repo-links" aria-label="Installed repos">
                {repos.map((installedRepo) => (
                  <a
                    className={
                      installedRepo.id === repo?.id
                        ? "repo-link active"
                        : "repo-link"
                    }
                    href={`/?repo=${encodeURIComponent(installedRepo.id)}`}
                    key={installedRepo.id}
                  >
                    {installedRepo.fullName}
                  </a>
                ))}
              </div>
            ) : null}
            {repo ? (
              <div className="list">
                <div className="row">
                  <div>
                    <strong>{repo.fullName}</strong>
                    <p className="muted">
                      Default branch: {repo.defaultBranch}
                    </p>
                  </div>
                  <span className="badge">
                    {repo.private ? "private" : "public"}
                  </span>
                </div>
                <div className="actions">
                  <form action="/repo-actions" method="post">
                    <input type="hidden" name="repoId" value={repo.id} />
                    <input type="hidden" name="actionType" value="analyze" />
                    <button type="submit">Run analysis</button>
                  </form>
                  <form action="/repo-actions" method="post">
                    <input type="hidden" name="repoId" value={repo.id} />
                    <input
                      type="hidden"
                      name="actionType"
                      value="generateContext"
                    />
                    {selectedProvider ? (
                      <input
                        type="hidden"
                        name="providerId"
                        value={selectedProvider.id}
                      />
                    ) : null}
                    <div className="generate-options">
                      <label>
                        <span>Context</span>
                        <select
                          name="context"
                          defaultValue={defaultArtifactSelection}
                        >
                          <option value="codex">Codex</option>
                          <option value="claude">Claude</option>
                          <option value="both">Both</option>
                        </select>
                      </label>
                      <label>
                        <span>Skills</span>
                        <select
                          name="skills"
                          defaultValue={defaultArtifactSelection}
                        >
                          <option value="codex">Codex</option>
                          <option value="claude">Claude</option>
                          <option value="both">Both</option>
                        </select>
                      </label>
                    </div>
                    <button type="submit">Generate context</button>
                  </form>
                  <form action="/repo-actions" method="post">
                    <input type="hidden" name="repoId" value={repo.id} />
                    <input
                      type="hidden"
                      name="actionType"
                      value="openContextPr"
                    />
                    <button type="submit">{contextActionLabel}</button>
                  </form>
                </div>
                {actionError ? (
                  <p className="error">{actionErrorMessage(actionError)}</p>
                ) : null}
              </div>
            ) : (
              <SetupMessage />
            )}
          </div>

          <div className="panel">
            <div className="panel-heading">
              <h2>Provider Consent</h2>
              <span
                className={
                  providers.some((provider) => provider.repoContentConsent)
                    ? "badge"
                    : "badge warn"
                }
              >
                {providers.some((provider) => provider.repoContentConsent)
                  ? "ready"
                  : "blocked"}
              </span>
            </div>
            <form
              action="/provider-actions"
              className="provider-form"
              method="post"
            >
              {repo ? (
                <input type="hidden" name="repoId" value={repo.id} />
              ) : null}
              <label htmlFor="providerType">Provider</label>
              <select
                id="providerType"
                name="providerType"
                defaultValue="codex"
              >
                <option value="codex">Codex CLI</option>
                <option value="claude">Claude CLI</option>
              </select>
              <label htmlFor="providerModel">Model</label>
              <input
                id="providerModel"
                name="model"
                placeholder="gpt-5.5 for Codex"
                type="text"
              />
              <label className="checkbox-row">
                <input name="repoContentConsent" type="checkbox" />
                <span>Allow repository content for generation and review</span>
              </label>
              <button type="submit">Use provider</button>
              {providerError ? (
                <p className="error">{providerErrorMessage(providerError)}</p>
              ) : null}
            </form>
            {providers.length ? (
              <div className="list">
                {providers.map((provider) => (
                  <div className="row compact" key={provider.id}>
                    <div>
                      <strong>{provider.displayName}</strong>
                      <p className="muted">
                        {provider.kind} / {provider.model}
                      </p>
                    </div>
                    <div className="row-actions">
                      <span
                        className={
                          provider.repoContentConsent ? "badge" : "badge warn"
                        }
                      >
                        {provider.repoContentConsent
                          ? provider.id === selectedProvider?.id
                            ? "selected"
                            : "consented"
                          : "no consent"}
                      </span>
                      {provider.id !== selectedProvider?.id ? (
                        <form action="/provider-actions" method="post">
                          {repo ? (
                            <input
                              type="hidden"
                              name="repoId"
                              value={repo.id}
                            />
                          ) : null}
                          <input
                            type="hidden"
                            name="providerId"
                            value={provider.id}
                          />
                          <button type="submit">Use</button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">
                No model provider is configured. Generation is blocked until a
                provider exists and repo-content consent is enabled.
              </p>
            )}
            <p className="note">
              Connectivity tests use a harmless non-repo prompt.
            </p>
          </div>
        </section>

        <section className="columns" style={{ marginTop: 16 }}>
          <div className="panel">
            <div className="panel-heading">
              <h2>Repo Profile</h2>
              {profile ? (
                <span className="badge">v{profile.version}</span>
              ) : null}
            </div>
            {profile ? (
              <div className="profile-stack">
                <div className="metric-row">
                  <div className="metric">
                    <span className="metric-label">Readiness</span>
                    <strong>{formatReadinessScore(readiness?.score)}</strong>
                  </div>
                  <div className="metric">
                    <span className="metric-label">Package manager</span>
                    <strong>{profile.packageManager ?? "unknown"}</strong>
                  </div>
                </div>
                {readiness?.missingItems.length ? (
                  <div>
                    <h3>Missing items</h3>
                    <ul className="plain-list">
                      {readiness.missingItems.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : readiness?.score === undefined ? (
                  <p className="muted">
                    Readiness score has not been populated by the backend yet.
                  </p>
                ) : (
                  <p className="muted">No missing readiness items reported.</p>
                )}
                <div className="profile-facts">
                  <FactList
                    label="Languages"
                    values={profile.primaryLanguages}
                  />
                  <FactList label="Frameworks" values={profile.frameworks} />
                  <FactList
                    label="Risk areas"
                    values={profile.detectedRiskAreas}
                  />
                </div>
              </div>
            ) : (
              <p className="muted">Run analysis to create repo_profile:v1.</p>
            )}
          </div>
          <div className="panel">
            <div className="panel-heading">
              <h2>Artifacts</h2>
              <span className="count">{artifacts.length} generated</span>
            </div>
            {artifacts.length ? (
              <div className="artifact-list">
                {artifacts.map((artifact) => (
                  <div className="artifact" key={artifact.id}>
                    <div className="row compact">
                      <div>
                        <strong>{artifact.type}</strong>
                        <p className="muted">
                          v{artifact.version} from profile v
                          {artifact.sourceProfileVersion}
                        </p>
                      </div>
                      <span className="badge">preview</span>
                    </div>
                    <pre className="artifact-preview">{artifact.content}</pre>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">
                Generate context to preview AGENTS.md and .open-maintainer.yml.
              </p>
            )}
          </div>
        </section>

        <section className="columns" style={{ marginTop: 16 }}>
          <div className="panel">
            <div className="panel-heading">
              <h2>PR Review</h2>
              <span className={latestReview ? "badge" : "badge warn"}>
                {latestReview ? latestReview.mergeReadiness.status : "preview"}
              </span>
            </div>
            {repo ? (
              <form
                action="/repo-actions"
                className="provider-form"
                method="post"
              >
                <input type="hidden" name="repoId" value={repo.id} />
                <input type="hidden" name="actionType" value="createReview" />
                {selectedProvider ? (
                  <>
                    <input
                      name="providerId"
                      type="hidden"
                      value={selectedProvider.id}
                    />
                    <p className="muted">
                      Reviews use {selectedProvider.displayName} /{" "}
                      {selectedProvider.model}. PR numbers resolve review refs
                      automatically when GitHub metadata is available.
                    </p>
                  </>
                ) : (
                  <p className="muted">
                    Configure and select a consented model provider to run PR
                    reviews.
                  </p>
                )}
                <label htmlFor="baseRef">Base ref</label>
                <input
                  id="baseRef"
                  name="baseRef"
                  placeholder={`optional, defaults to ${repo.defaultBranch}`}
                  type="text"
                />
                <label htmlFor="headRef">Head ref</label>
                <input
                  id="headRef"
                  name="headRef"
                  placeholder="HEAD"
                  type="text"
                />
                <label htmlFor="prNumber">PR number</label>
                <input
                  id="prNumber"
                  inputMode="numeric"
                  name="prNumber"
                  placeholder="optional"
                  type="text"
                />
                <button type="submit">Preview review</button>
              </form>
            ) : (
              <p className="muted">Select a repository before reviewing.</p>
            )}
            {latestReview ? <ReviewPreview review={latestReview} /> : null}
          </div>
          <div className="panel">
            <div className="panel-heading">
              <h2>Context PR</h2>
              <span className={prStatus.url ? "badge" : "badge warn"}>
                {prStatus.label}
              </span>
            </div>
            {prStatus.url ? (
              <a className="pr-link" href={prStatus.url}>
                {prStatus.url}
              </a>
            ) : (
              <p className="muted">{prStatus.message}</p>
            )}
          </div>
          <div className="panel">
            <div className="panel-heading">
              <h2>Run History</h2>
              <span className="count">{runs.length} runs</span>
            </div>
            {runs.length ? (
              <div className="list">
                {runs
                  .slice()
                  .reverse()
                  .slice(0, 8)
                  .map((run) => (
                    <div className="run" key={run.id}>
                      <div className="run-title">
                        <strong>{run.type}</strong>
                        <span
                          className={
                            run.status === "failed" ? "badge warn" : "badge"
                          }
                        >
                          {run.status}
                        </span>
                      </div>
                      <p
                        className={run.status === "failed" ? "error" : "muted"}
                      >
                        {run.safeMessage ?? run.inputSummary}
                      </p>
                      <dl className="run-meta">
                        <div>
                          <dt>Updated</dt>
                          <dd>{formatDate(run.updatedAt)}</dd>
                        </div>
                        <div>
                          <dt>Provider</dt>
                          <dd>{formatProvider(run)}</dd>
                        </div>
                        <div>
                          <dt>External</dt>
                          <dd>{formatExternal(run)}</dd>
                        </div>
                      </dl>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="muted">
                Run records will appear before external work starts and after
                each state transition.
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function ReviewPreview({ review }: { review: ReviewResult }) {
  const feedbackCounts = countReviewFeedback(review);
  const findingsBySeverity = ["blocker", "major", "minor", "note"].map(
    (severity) => ({
      severity,
      findings: review.findings.filter(
        (finding) => finding.severity === severity,
      ),
    }),
  );
  return (
    <div className="artifact-list">
      <div className="artifact">
        <div className="row compact">
          <div>
            <strong>Review #{review.prNumber ?? "local"}</strong>
            <p className="muted">
              {review.baseRef}...{review.headRef}
            </p>
          </div>
          <span className="badge">
            {review.modelProvider ?? "model unavailable"}
          </span>
        </div>
        <dl className="run-meta">
          <div>
            <dt>False positives</dt>
            <dd>{feedbackCounts.false_positive}</dd>
          </div>
          <div>
            <dt>Accepted</dt>
            <dd>{feedbackCounts.accepted}</dd>
          </div>
          <div>
            <dt>Needs context</dt>
            <dd>{feedbackCounts.needs_more_context}</dd>
          </div>
          <div>
            <dt>Unclear</dt>
            <dd>{feedbackCounts.unclear}</dd>
          </div>
        </dl>
        <ReviewSummary review={review} />
        <h3>Contribution triage</h3>
        <ReviewContributionTriage review={review} />
        <h3>Walkthrough</h3>
        <ReviewWalkthrough review={review} />
        <h3>Findings</h3>
        {findingsBySeverity.map(({ severity, findings }) =>
          findings.length ? (
            <div key={severity}>
              <strong>{severity}</strong>
              <ul className="plain-list">
                {findings.map((finding) => {
                  const findingFeedback = review.feedback.filter(
                    (feedback) => feedback.findingId === finding.id,
                  );
                  return (
                    <li key={finding.id}>
                      {finding.title}
                      {finding.path ? ` (${finding.path})` : ""}
                      <FindingDetail finding={finding} />
                      {findingFeedback.length ? (
                        <p className="muted">
                          Feedback:{" "}
                          {findingFeedback
                            .map((feedback) => feedback.verdict)
                            .join(", ")}
                        </p>
                      ) : null}
                      <form
                        action="/review-feedback"
                        className="provider-form"
                        method="post"
                      >
                        <input
                          type="hidden"
                          name="repoId"
                          value={review.repoId}
                        />
                        <input
                          type="hidden"
                          name="reviewId"
                          value={review.id}
                        />
                        <input
                          type="hidden"
                          name="findingId"
                          value={finding.id}
                        />
                        <label htmlFor={`feedback-reason-${finding.id}`}>
                          Feedback reason
                        </label>
                        <input
                          id={`feedback-reason-${finding.id}`}
                          name="reason"
                          placeholder="optional"
                          type="text"
                        />
                        <div className="row compact">
                          <button
                            name="verdict"
                            type="submit"
                            value="false_positive"
                          >
                            False positive
                          </button>
                          <button name="verdict" type="submit" value="accepted">
                            Accept
                          </button>
                          <button
                            name="verdict"
                            type="submit"
                            value="needs_more_context"
                          >
                            Needs context
                          </button>
                          <button name="verdict" type="submit" value="unclear">
                            Unclear
                          </button>
                        </div>
                      </form>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null,
        )}
        <h3>Required validation for this PR</h3>
        <pre>{requiredValidationCommands(review).join("\n")}</pre>
        <h3>Merge readiness</h3>
        <p>{review.mergeReadiness.reason}</p>
        <h3>Residual risk</h3>
        <ul className="plain-list">
          {review.residualRisk.map((risk) => (
            <li key={risk}>{risk}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ReviewContributionTriage({ review }: { review: ReviewResult }) {
  const triage = review.contributionTriage;
  if (triage.status === "not_evaluated") {
    return (
      <div className="triage-panel">
        <div className="row compact">
          <strong>Not evaluated</strong>
          <span className="badge warn">preview</span>
        </div>
        <p>{triage.recommendation}</p>
      </div>
    );
  }
  return (
    <div className="triage-panel">
      <dl className="run-meta">
        <div>
          <dt>Category</dt>
          <dd>{formatSnakeCase(triage.category ?? "not_evaluated")}</dd>
        </div>
        <div>
          <dt>Maintainer action</dt>
          <dd>{triage.recommendation}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>{triage.evidence.length}</dd>
        </div>
      </dl>
      <TriageList
        fallback="No missing contribution information recorded."
        items={triage.missingInformation}
        title="Missing information"
      />
      <TriageList
        fallback="No author action required by contribution triage."
        items={triage.requiredActions}
        title="Required author actions"
      />
      <details>
        <summary>Evidence</summary>
        <ul className="plain-list">
          {triage.evidence.map((citation, index) => (
            <li key={`${citation.source}-${citation.path ?? index}`}>
              {citation.source}
              {citation.path ? ` ${citation.path}` : ""}: {citation.reason}
              {citation.excerpt ? `: ${citation.excerpt}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function TriageList({
  fallback,
  items,
  title,
}: {
  fallback: string;
  items: string[];
  title: string;
}) {
  return (
    <div>
      <strong>{title}</strong>
      <ul className="plain-list">
        {items.length ? (
          items.map((item) => <li key={item}>{item}</li>)
        ) : (
          <li>{fallback}</li>
        )}
      </ul>
    </div>
  );
}

function ReviewSummary({ review }: { review: ReviewResult }) {
  const summary = parseReviewSummary(review.summary);
  const concerns = review.findings.slice(0, 5).map((finding) => finding.title);
  return (
    <div>
      <p>{summary.overview}</p>
      <p>
        Risk level:{" "}
        <strong>{summary.riskLevel ?? inferRiskLevel(review)}</strong>
      </p>
      <p>Main concerns:</p>
      <ul className="plain-list">
        {concerns.length ? (
          concerns.map((concern) => <li key={concern}>{concern}</li>)
        ) : (
          <li>No concrete findings.</li>
        )}
      </ul>
      {summary.validationSummary ? (
        <p className="muted">Validation: {summary.validationSummary}</p>
      ) : null}
      {summary.docsSummary ? (
        <p className="muted">Docs: {summary.docsSummary}</p>
      ) : null}
    </div>
  );
}

function ReviewWalkthrough({ review }: { review: ReviewResult }) {
  const rows = walkthroughRows(review);
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Area</th>
            <th>What changed</th>
            <th>Review focus</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.area}>
              <td>{row.area}</td>
              <td>{row.changed}</td>
              <td>{row.focus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FindingDetail({
  finding,
}: {
  finding: ReviewResult["findings"][number];
}) {
  const detail = parseFindingBody(finding.body);
  return (
    <div className="finding-detail">
      {detail.category ? <p className="muted">{detail.category}</p> : null}
      {detail.description ? <p>{detail.description}</p> : null}
      <p>
        <strong>Impact:</strong> {detail.impact || "Not specified."}
      </p>
      <p>
        <strong>Recommendation:</strong>{" "}
        {detail.recommendation || "Not specified."}
      </p>
      <details>
        <summary>Evidence</summary>
        <ul className="plain-list">
          {finding.citations.map((citation, index) => (
            <li key={`${citation.source}-${citation.path ?? index}`}>
              {citation.source}
              {citation.path ? ` ${citation.path}` : ""}: {citation.reason}
              {citation.excerpt ? `: ${citation.excerpt}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function parseReviewSummary(summary: string) {
  const lines = summary.split(/\r?\n/).map((line) => line.trim());
  const riskLine = lines.find((line) => /^Risk:/i.test(line));
  const validationLine = lines.find((line) => /^Validation:/i.test(line));
  const docsLine = lines.find((line) => /^Docs:/i.test(line));
  return {
    overview:
      lines
        .filter(
          (line) =>
            line &&
            !/^Risk:/i.test(line) &&
            !/^Validation:/i.test(line) &&
            !/^Docs:/i.test(line),
        )
        .join("\n") || summary,
    riskLevel: riskLine?.replace(/^Risk:\s*/i, "").replace(/\.$/, "") ?? null,
    validationSummary:
      validationLine?.replace(/^Validation:\s*/i, "").replace(/\.$/, "") ??
      null,
    docsSummary: docsLine?.replace(/^Docs:\s*/i, "").replace(/\.$/, "") ?? null,
  };
}

function parseFindingBody(body: string) {
  const category = body.match(/^Category:\s*(.+)$/m)?.[1] ?? null;
  const impact = body.match(
    /^Impact:\s*([\s\S]*?)(?:\nRecommendation:|$)/m,
  )?.[1];
  const recommendation = body.match(/^Recommendation:\s*([\s\S]*)$/m)?.[1];
  const description = body
    .replace(/^Category:.*$/m, "")
    .replace(/^Impact:[\s\S]*$/m, "")
    .trim();
  return {
    category,
    description,
    impact: impact?.trim() ?? "",
    recommendation: recommendation?.trim() ?? "",
  };
}

function inferRiskLevel(review: ReviewResult) {
  if (review.findings.some((finding) => finding.severity === "blocker")) {
    return "critical";
  }
  if (review.findings.some((finding) => finding.severity === "major")) {
    return "high";
  }
  if (review.findings.some((finding) => finding.severity === "minor")) {
    return "medium";
  }
  return "low";
}

function formatSnakeCase(value: string) {
  return value
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function walkthroughRows(review: ReviewResult) {
  const areas = review.changedSurface.length
    ? review.changedSurface
    : review.walkthrough;
  return areas.map((area) => {
    const files = review.changedFiles.filter((file) =>
      fileMatchesSurface(file.path, area),
    );
    return {
      area,
      changed: files.length
        ? files
            .slice(0, 3)
            .map((file) => file.path)
            .join(", ")
        : review.walkthrough[0] || "Changed files in this area.",
      focus:
        review.findings.find((finding) =>
          finding.path ? fileMatchesSurface(finding.path, area) : false,
        )?.title || "Review changed behavior, validation, and repo policy.",
    };
  });
}

function fileMatchesSurface(repoPath: string, surface: string): boolean {
  if (surface.startsWith("package:")) {
    return repoPath.startsWith(`packages/${surface.slice("package:".length)}/`);
  }
  if (surface === "api") {
    return repoPath.startsWith("apps/api/");
  }
  if (surface === "cli") {
    return repoPath.startsWith("apps/cli/");
  }
  if (surface === "web") {
    return repoPath.startsWith("apps/web/");
  }
  if (surface === "docs") {
    return repoPath.endsWith(".md") || repoPath.startsWith("docs/");
  }
  if (surface === "github-action/workflow") {
    return repoPath === "action.yml" || repoPath.startsWith(".github/");
  }
  if (surface === "fixtures/tests") {
    return repoPath.startsWith("tests/");
  }
  return repoPath.includes(surface);
}

function requiredValidationCommands(review: ReviewResult): string[] {
  const commands = review.expectedValidation
    .map((item) => item.command)
    .filter(isReviewValidationCommand);
  const preferred = [
    "biome check .",
    "tsc -b",
    "vitest run",
    "bun run build",
    "bun run tests/smoke/mvp-demo.ts",
    "bun run tests/smoke/compose-smoke.ts",
  ];
  const selected = preferred.filter(
    (command) =>
      commands.includes(command) ||
      (command === "bun run build" &&
        commands.some((item) => item.includes("bun run --cwd"))),
  );
  for (const command of commands) {
    if (!selected.includes(command) && selected.length < 10) {
      selected.push(command);
    }
  }
  return selected.length ? selected : ["No required validation inferred."];
}

function isReviewValidationCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    !normalized.includes("--watch") &&
    !normalized.includes(" next dev") &&
    !normalized.includes("bun src/server") &&
    !normalized.includes("format --write") &&
    /(biome check|tsc|typecheck|vitest|bun test|bun run build|smoke|mvp-demo|compose-smoke)/.test(
      normalized,
    )
  );
}

function countReviewFeedback(review: ReviewResult) {
  const counts = {
    false_positive: 0,
    accepted: 0,
    needs_more_context: 0,
    unclear: 0,
  };
  for (const feedback of review.feedback) {
    counts[feedback.verdict] += 1;
  }
  return counts;
}

function formatReadinessScore(score: number | undefined): string {
  if (score === undefined) {
    return "pending";
  }
  return score <= 1 ? `${Math.round(score * 100)}%` : `${Math.round(score)}`;
}

function actionErrorMessage(error: string): string {
  const parsed = parseStatusError(error);
  if (error === "invalid-action") {
    return "That repository action was not recognized.";
  }
  if (error === "unreachable") {
    return "The API did not respond to that repository action.";
  }
  if (error === "missing-provider") {
    return "Choose a consented model provider before generating context or reviewing a PR.";
  }
  if (error === "409") {
    return "That action needs analysis artifacts or provider consent first.";
  }
  return parsed.detail
    ? `Repository action failed with API status ${parsed.status}. ${parsed.detail}`
    : `Repository action failed with API status ${parsed.status}.`;
}

function providerErrorMessage(error: string): string {
  const parsed = parseStatusError(error);
  if (error === "invalid-provider") {
    return "Choose Codex CLI or Claude CLI.";
  }
  if (error === "missing-consent") {
    return "Repo-content consent is required before generation can use a provider.";
  }
  if (error === "unreachable") {
    return "The API did not respond while saving the provider.";
  }
  return parsed.detail
    ? `Provider setup failed with API status ${parsed.status}. ${parsed.detail}`
    : `Provider setup failed with API status ${parsed.status}.`;
}

function authReadinessMessage(authReadiness: AuthReadiness | null): string {
  if (!authReadiness || authReadiness.authReady) {
    return "";
  }
  const missing = [
    authToolMessage("gh", authReadiness.ghAuth),
    authToolMessage("codex", authReadiness.codexAuth),
    authToolMessage("claude", authReadiness.claudeAuth),
  ].filter((message) => message.length > 0);
  return `Auth readiness is degraded: ${missing.join("; ")}.`;
}

function authToolMessage(label: string, tool: AuthReadiness["ghAuth"]): string {
  if (tool.status === "ok") {
    return "";
  }
  return tool.error ? `${label}: ${tool.error}` : `${label}: auth missing`;
}

function parseStatusError(error: string): { status: string; detail: string } {
  const separator = error.indexOf(":");
  if (separator < 0) {
    return { status: error, detail: "" };
  }
  return {
    status: error.slice(0, separator),
    detail: error.slice(separator + 1),
  };
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatProvider(run: RunRecord): string {
  return run.provider && run.model ? `${run.provider} / ${run.model}` : "none";
}

function formatExternal(run: RunWithContext): string {
  return findPrUrl(run) ?? run.externalId ?? "none";
}

function FactList({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <h3>{label}</h3>
      <p className="muted">{values.length ? values.join(", ") : "none"}</p>
    </div>
  );
}

function StatusCard({
  label,
  value,
}: { label: string; value: string | undefined }) {
  return (
    <div className="panel status">
      <strong>{label}</strong>
      <span className={value === "ok" ? "badge" : "badge warn"}>
        {value ?? "missing"}
      </span>
    </div>
  );
}

function SetupMessage() {
  return (
    <div>
      <p className="muted">
        Choose a local repository or select an installed repository.
      </p>
    </div>
  );
}
