import type {
  PullRequestDetail,
  PullRequestListItem,
  PullRequestTimelineItem,
  ReviewChangedFile,
} from "@open-maintainer/shared";
import Link from "next/link";
import {
  contextDashboardHref,
  pullRequestsDashboardHref,
} from "../dashboard-navigation";
import type { SearchParams } from "../dashboard-view-model";
import { BatchTriageControls } from "./BatchTriageControls";
import { DraftActionForm } from "./DraftActionForm";
import { PullRequestKeyboardNav } from "./PullRequestKeyboardNav";
import { reviewDraftMarkdown, triageDraftMarkdown } from "./draft-markdown";
import {
  type PullRequestTab,
  loadPullRequestsViewModel,
  pullRequestHref,
} from "./pr-view-model";

type PullRequestsPageProps = {
  searchParams?: Promise<SearchParams>;
};

export default async function PullRequestsPage({
  searchParams,
}: PullRequestsPageProps) {
  const params: SearchParams = searchParams ? await searchParams : {};
  const view = await loadPullRequestsViewModel({ searchParams: params });
  const canGenerate =
    Boolean(view.repo && view.selectedPullNumber && view.selectedProvider) &&
    view.selectedProvider?.repoContentConsent === true;

  return (
    <main>
      <PullRequestKeyboardNav />
      <div className="shell pr-shell">
        <header className="topbar pr-topbar">
          <div>
            <p className="muted">Pull request management</p>
            <h1>Open Maintainer</h1>
          </div>
          <nav className="top-nav" aria-label="Dashboard sections">
            <Link
              className="repo-link"
              href={contextDashboardHref({
                providerId: view.selectedProvider?.id ?? null,
                repoId: view.repo?.id ?? null,
              })}
            >
              Context
            </Link>
            <Link
              className="repo-link active"
              href={
                view.repo
                  ? pullRequestHref({
                      repoId: view.repo.id,
                      pullNumber: view.selectedPullNumber,
                      filters: view.filters,
                      providerId: view.selectedProvider?.id ?? null,
                      reviewId: view.selectedReview?.id ?? null,
                    })
                  : pullRequestsDashboardHref({
                      providerId: view.selectedProvider?.id ?? null,
                      repoId: null,
                    })
              }
            >
              Pull Requests
            </Link>
          </nav>
        </header>

        <section className="pr-status-strip" aria-label="Service status">
          <StatusCard label="API" value={view.health?.api} />
          <StatusCard
            label="GitHub"
            value={view.authReadiness?.ghAuth.status}
          />
          <StatusCard
            label="Model"
            value={view.selectedProvider?.repoContentConsent ? "ok" : "missing"}
          />
          <StatusCard label="Source" value={view.source ?? undefined} />
        </section>

        <section className="pr-controls" aria-label="Pull request controls">
          <RepositorySwitcher view={view} />
          <PullRequestFilters view={view} />
        </section>

        <section className="pr-layout">
          <section className="pr-queue" aria-label="Pull request queue">
            <PullRequestQueueSummary view={view} />
            {view.errors.list ? (
              <StatePanel tone="warn" title="Pull requests unavailable">
                {pullRequestErrorMessage(view.errors.list)}
              </StatePanel>
            ) : (
              <PullRequestList view={view} />
            )}
          </section>

          <section className="pr-main" aria-label="Pull request detail">
            {view.repo ? (
              view.selectedPullRequest ? (
                <>
                  <PullRequestDetailHeader
                    pullRequest={view.selectedPullRequest}
                    source={view.source}
                  />
                  <PullRequestTabs view={view} />
                  <div className="pr-detail-grid">
                    <div className="pr-detail-primary">
                      {view.errors.detail ? (
                        <StatePanel tone="warn" title="Details unavailable">
                          {pullRequestErrorMessage(view.errors.detail)}
                        </StatePanel>
                      ) : (
                        <PullRequestTabPanel
                          pullRequest={view.selectedPullRequest}
                          tab={view.filters.tab}
                        />
                      )}
                      <DraftPanel canGenerate={canGenerate} view={view} />
                    </div>
                    <MetadataPanel pullRequest={view.selectedPullRequest} />
                  </div>
                </>
              ) : view.selectedPullNumber && view.errors.detail ? (
                <StatePanel
                  tone="warn"
                  title={`PR #${view.selectedPullNumber} details unavailable`}
                >
                  {pullRequestErrorMessage(view.errors.detail)}
                </StatePanel>
              ) : (
                <StatePanel title="No pull request selected">
                  {view.pullRequests.length
                    ? "Choose a pull request from the list."
                    : "No pull requests matched this repository and filter."}
                </StatePanel>
              )
            ) : (
              <StatePanel title="Select a repository">
                Add or select a repository before opening pull requests.
              </StatePanel>
            )}
          </section>
        </section>
      </div>
    </main>
  );
}

function PullRequestQueueSummary({
  view,
}: {
  view: Awaited<ReturnType<typeof loadPullRequestsViewModel>>;
}) {
  const stats = summarizePullRequests(view.pullRequests);
  return (
    <section className="panel pr-queue-summary">
      <div>
        <p className="muted">{formatSnakeCase(view.filters.state)} queue</p>
        <h2>{view.repo ? view.repo.fullName : "No repository selected"}</h2>
      </div>
      <div className="pr-queue-metrics" aria-label="Pull request queue metrics">
        <QueueMetric label="Visible" value={stats.visible} />
        <QueueMetric
          label="Needs action"
          tone={stats.needsAction > 0 ? "warn" : "neutral"}
          value={stats.needsAction}
        />
        <QueueMetric
          label="Review required"
          tone={stats.reviewRequired > 0 ? "warn" : "neutral"}
          value={stats.reviewRequired}
        />
        <QueueMetric
          label="Failing checks"
          tone={stats.failingChecks > 0 ? "critical" : "neutral"}
          value={stats.failingChecks}
        />
      </div>
    </section>
  );
}

function QueueMetric({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: "neutral" | "warn" | "critical";
  value: number;
}) {
  return (
    <div className={`pr-queue-metric ${tone}`}>
      <strong>{formatNumber(value)}</strong>
      <span>{label}</span>
    </div>
  );
}

function RepositorySwitcher({
  view,
}: {
  view: Awaited<ReturnType<typeof loadPullRequestsViewModel>>;
}) {
  return (
    <div className="panel pr-sidebar-panel">
      <div className="panel-heading">
        <h2>Repository</h2>
        <span className="count">{view.repos.length} installed</span>
      </div>
      {view.repos.length ? (
        <div className="repo-links" aria-label="Repositories">
          {view.repos.map((repo) => (
            <Link
              className={
                repo.id === view.repo?.id ? "repo-link active" : "repo-link"
              }
              href={pullRequestHref({
                repoId: repo.id,
                filters: view.filters,
                providerId: view.selectedProvider?.id ?? null,
              })}
              key={repo.id}
            >
              {repo.fullName}
            </Link>
          ))}
        </div>
      ) : (
        <p className="muted">No repositories are installed.</p>
      )}
      {view.repo ? (
        <div className="row compact">
          <div>
            <strong>{view.repo.fullName}</strong>
            <p className="muted">Default branch: {view.repo.defaultBranch}</p>
          </div>
          <span className="badge">
            {view.repo.private ? "private" : "public"}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function PullRequestFilters({
  view,
}: {
  view: Awaited<ReturnType<typeof loadPullRequestsViewModel>>;
}) {
  return (
    <form className="panel pr-filter-form" method="get">
      {view.repo ? (
        <input type="hidden" name="repo" value={view.repo.id} />
      ) : null}
      <label>
        <span>Search</span>
        <input
          data-pr-search
          defaultValue={view.filters.q}
          name="q"
          placeholder="number, title, author, label"
          type="search"
        />
      </label>
      <div className="pr-filter-row">
        <label>
          <span>State</span>
          <select name="state" defaultValue={view.filters.state}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          <span>Sort</span>
          <select name="sort" defaultValue={view.filters.sort}>
            <option value="updated">Updated</option>
            <option value="created">Created</option>
            <option value="number">Number</option>
          </select>
        </label>
        <label>
          <span>Direction</span>
          <select name="direction" defaultValue={view.filters.direction}>
            <option value="desc">Desc</option>
            <option value="asc">Asc</option>
          </select>
        </label>
      </div>
      <input type="hidden" name="tab" value={view.filters.tab} />
      <button type="submit">Apply</button>
    </form>
  );
}

function PullRequestList({
  view,
}: {
  view: Awaited<ReturnType<typeof loadPullRequestsViewModel>>;
}) {
  if (!view.repo) {
    return null;
  }
  const repo = view.repo;
  if (view.pullRequests.length === 0) {
    return (
      <StatePanel title="No pull requests">
        Try a different state, search, or repository.
      </StatePanel>
    );
  }
  const selectedPrs = new Set(view.filters.selectedPrs);
  return (
    <form
      action="/pull-request-triage-actions"
      className="pr-batch-form"
      method="post"
    >
      <input type="hidden" name="repoId" value={repo.id} />
      <input type="hidden" name="state" value={view.filters.state} />
      <input type="hidden" name="sort" value={view.filters.sort} />
      <input type="hidden" name="direction" value={view.filters.direction} />
      <input type="hidden" name="tab" value={view.filters.tab} />
      <input type="hidden" name="draft" value={view.filters.draft} />
      {view.filters.q ? (
        <input type="hidden" name="q" value={view.filters.q} />
      ) : null}
      {view.selectedPullNumber ? (
        <input type="hidden" name="pr" value={view.selectedPullNumber} />
      ) : null}
      {view.selectedProvider ? (
        <input
          type="hidden"
          name="providerId"
          value={view.selectedProvider.id}
        />
      ) : null}
      <BatchPullRequestTriagePanel view={view} />
      <div className="pr-list" aria-label="Pull requests">
        {view.pullRequests.map((pullRequest) => (
          <article
            aria-current={
              pullRequest.number === view.selectedPullNumber
                ? "page"
                : undefined
            }
            className={
              pullRequest.number === view.selectedPullNumber
                ? "pr-list-item active"
                : "pr-list-item"
            }
            key={pullRequest.number}
          >
            <label className="pr-select">
              <input
                defaultChecked={selectedPrs.has(pullRequest.number)}
                name="selectedPr"
                type="checkbox"
                value={pullRequest.number}
              />
              <span>Select</span>
            </label>
            <div className="pr-list-primary">
              <div className="pr-list-kicker">
                <Link
                  className="pr-number-link"
                  href={pullRequestHref({
                    repoId: repo.id,
                    pullNumber: pullRequest.number,
                    filters: view.filters,
                    providerId: view.selectedProvider?.id ?? null,
                  })}
                >
                  #{pullRequest.number}
                </Link>
                <span className={stateClass(pullRequest.state)}>
                  {pullRequest.state}
                </span>
                {pullRequest.isDraft ? (
                  <span className="badge warn">draft</span>
                ) : null}
              </div>
              <Link
                data-pr-nav-item
                className="pr-list-title-text"
                href={pullRequestHref({
                  repoId: repo.id,
                  pullNumber: pullRequest.number,
                  filters: view.filters,
                  providerId: view.selectedProvider?.id ?? null,
                })}
              >
                {pullRequest.title}
              </Link>
              <div className="pr-list-context">
                <span>{pullRequest.author ?? "unknown"}</span>
                <span>updated {formatRelativeDate(pullRequest.updatedAt)}</span>
                <span>
                  {pullRequest.baseRef}...{pullRequest.headRef}
                </span>
              </div>
              {pullRequest.labels.length ? (
                <div className="pr-list-labels" aria-label="Labels">
                  {pullRequest.labels.slice(0, 3).map((label) => (
                    <span className="badge subtle pr-label" key={label}>
                      {label}
                    </span>
                  ))}
                  {pullRequest.labels.length > 3 ? (
                    <span className="badge subtle pr-label">
                      +{pullRequest.labels.length - 3}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <TriageTags tags={pullRequest.triageTags} />
            </div>
            <div className="pr-list-status">
              <span className={attentionClass(pullRequest.attention)}>
                {attentionLabel(pullRequest.attention)}
              </span>
              <span className="badge subtle">{checksLabel(pullRequest)}</span>
            </div>
            <div className="pr-list-review">
              <strong>{reviewDecisionLabel(pullRequest)}</strong>
              <span>{mergeStateLabel(pullRequest)}</span>
            </div>
            <div className="pr-list-size">
              <strong>{pullRequest.changedFiles} files</strong>
              <span>{diffStat(pullRequest)}</span>
              <span>{commentsLabel(pullRequest)}</span>
            </div>
          </article>
        ))}
      </div>
    </form>
  );
}

function BatchPullRequestTriagePanel({
  view,
}: {
  view: Awaited<ReturnType<typeof loadPullRequestsViewModel>>;
}) {
  const selectedCount = view.filters.selectedPrs.length;
  const canRunTriage = view.selectedProvider?.repoContentConsent === true;
  const clearHref = view.repo
    ? pullRequestHref({
        repoId: view.repo.id,
        pullNumber: view.selectedPullNumber,
        filters: {
          ...view.filters,
          batchTriage: false,
          selectedPrs: [],
        },
        providerId: view.selectedProvider?.id ?? null,
        reviewId: view.selectedReview?.id ?? null,
      })
    : null;
  return (
    <section className="panel pr-batch-panel">
      <div>
        <h2>Batch PR triage</h2>
        <p className="muted">Model-backed label write for selected PRs.</p>
      </div>
      <BatchTriageControls
        canRunTriage={canRunTriage}
        clearHref={view.filters.batchTriage ? clearHref : null}
        errorMessage={
          view.errors.triage ? pullRequestTriageError(view.errors.triage) : null
        }
        initialSelectedCount={selectedCount}
        resultMessage={view.messages.triage ?? null}
      />
    </section>
  );
}

function TriageTags({ tags }: { tags: PullRequestListItem["triageTags"] }) {
  return tags.length ? (
    <div className="pr-auto-tags" aria-label="Automatic triage tags">
      {tags.map((tag) => (
        <span
          className="badge pr-auto-tag"
          key={tag.id}
          title={tag.description}
        >
          {tag.label}
        </span>
      ))}
    </div>
  ) : null;
}

function PullRequestDetailHeader({
  pullRequest,
  source,
}: {
  pullRequest: PullRequestDetail;
  source: string | null;
}) {
  const summary = pullRequest.summary;
  return (
    <section className="panel pr-detail-header">
      <div>
        <p className="muted">
          #{summary.number} by {summary.author ?? "unknown"} / {summary.baseRef}
          ...{summary.headRef}
        </p>
        <h2>{summary.title}</h2>
        <div className="pr-detail-metrics" aria-label="Pull request summary">
          <span>{checksLabel(summary)}</span>
          <span>{reviewDecisionLabel(summary)}</span>
          <span>{summary.changedFiles} files</span>
          <span>{commentsLabel(summary)}</span>
        </div>
      </div>
      <div className="pr-header-badges">
        <span className={stateClass(summary.state)}>{summary.state}</span>
        {summary.isDraft ? <span className="badge warn">draft</span> : null}
        <span className={attentionClass(summary.attention)}>
          {attentionLabel(summary.attention)}
        </span>
        {summary.triageTags.map((tag) => (
          <span
            className="badge pr-auto-tag"
            key={tag.id}
            title={tag.description}
          >
            {tag.label}
          </span>
        ))}
        <span className="badge subtle">{source ?? "source pending"}</span>
      </div>
    </section>
  );
}

function PullRequestTabs({
  view,
}: {
  view: Awaited<ReturnType<typeof loadPullRequestsViewModel>>;
}) {
  if (!view.repo || !view.selectedPullNumber) {
    return null;
  }
  const repo = view.repo;
  const tabs: Array<{
    tab: PullRequestTab;
    label: string;
    count: number | undefined;
  }> = [
    {
      tab: "conversation",
      label: "Conversation",
      count: view.selectedPullRequest?.timeline.length,
    },
    {
      tab: "files",
      label: "Files",
      count: view.selectedPullRequest?.files.length,
    },
    {
      tab: "commits",
      label: "Commits",
      count: view.selectedPullRequest?.commits.length,
    },
  ];
  return (
    <nav className="pr-tabs" aria-label="Pull request views">
      {tabs.map(({ tab, label, count }) => (
        <Link
          className={view.filters.tab === tab ? "pr-tab active" : "pr-tab"}
          href={pullRequestHref({
            repoId: repo.id,
            pullNumber: view.selectedPullNumber,
            filters: view.filters,
            tab,
            providerId: view.selectedProvider?.id ?? null,
            reviewId: view.selectedReview?.id ?? null,
          })}
          key={tab}
        >
          {label}
          {count !== undefined ? <span>{count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

function PullRequestTabPanel({
  pullRequest,
  tab,
}: {
  pullRequest: PullRequestDetail;
  tab: PullRequestTab;
}) {
  if (tab === "files") {
    return <FilesTab pullRequest={pullRequest} />;
  }
  if (tab === "commits") {
    return <CommitsTab pullRequest={pullRequest} />;
  }
  return <ConversationTab pullRequest={pullRequest} />;
}

function ConversationTab({ pullRequest }: { pullRequest: PullRequestDetail }) {
  return (
    <section className="panel timeline">
      {pullRequest.timeline.length ? (
        pullRequest.timeline.map((item) => (
          <TimelineItem item={item} key={item.id} />
        ))
      ) : (
        <p className="muted">No timeline entries were returned.</p>
      )}
    </section>
  );
}

function TimelineItem({ item }: { item: PullRequestTimelineItem }) {
  return (
    <article className="timeline-item">
      <div className="timeline-heading">
        <strong>{timelineTitle(item)}</strong>
        <span>{formatDate(item.createdAt)}</span>
      </div>
      {item.path ? (
        <p className="muted">
          {item.path}
          {item.line ? `:${item.line}` : ""}
        </p>
      ) : null}
      {item.body ? <p className="timeline-body">{item.body}</p> : null}
    </article>
  );
}

function FilesTab({ pullRequest }: { pullRequest: PullRequestDetail }) {
  return (
    <section className="panel file-list">
      <div className="diff-summary">
        <strong>{pullRequest.files.length} files changed</strong>
        <span className="additions">+{pullRequest.summary.additions}</span>
        <span className="deletions">-{pullRequest.summary.deletions}</span>
      </div>
      {pullRequest.skippedFiles.length ? (
        <details className="skipped-files">
          <summary>{pullRequest.skippedFiles.length} files skipped</summary>
          <ul className="plain-list">
            {pullRequest.skippedFiles.map((file) => (
              <li key={`${file.path}-${file.reason}`}>
                {file.path}: {file.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {pullRequest.files.map((file, index) => (
        <FileDiff file={file} key={file.path} open={index < 2} />
      ))}
    </section>
  );
}

function FileDiff({
  file,
  open,
}: {
  file: ReviewChangedFile;
  open: boolean;
}) {
  const lines = (file.patch ?? "Patch unavailable.").split(/\r?\n/);
  const visibleLines = lines.slice(0, 420);
  return (
    <details className="file-diff" open={open}>
      <summary>
        <span>{file.path}</span>
        <span>
          {file.status} / +{file.additions} -{file.deletions}
        </span>
      </summary>
      <pre className="diff-pre">
        {visibleLines.map((line, index) => (
          <code className={diffLineClass(line)} key={`${file.path}-${index}`}>
            {line || " "}
            {"\n"}
          </code>
        ))}
        {lines.length > visibleLines.length ? (
          <code>{`... ${lines.length - visibleLines.length} more lines hidden\n`}</code>
        ) : null}
      </pre>
    </details>
  );
}

function CommitsTab({ pullRequest }: { pullRequest: PullRequestDetail }) {
  return (
    <section className="panel commit-list">
      {pullRequest.commits.length ? (
        pullRequest.commits.map((commit) => (
          <article className="commit-row" key={commit.sha}>
            <code>{commit.sha.slice(0, 12)}</code>
            <div>
              <strong>{commit.message ?? "Commit"}</strong>
              <p className="muted">
                {commit.author ?? "unknown"} / {formatDate(commit.authoredAt)}
              </p>
            </div>
          </article>
        ))
      ) : (
        <p className="muted">No commits were returned.</p>
      )}
    </section>
  );
}

function DraftPanel({
  canGenerate,
  view,
}: {
  canGenerate: boolean;
  view: Awaited<ReturnType<typeof loadPullRequestsViewModel>>;
}) {
  const pullNumber = view.selectedPullNumber;
  const selectedReview = view.selectedReview;
  return (
    <section className="panel draft-panel">
      <div className="panel-heading">
        <h2>Drafts</h2>
        <span className={canGenerate ? "badge" : "badge warn"}>
          {canGenerate ? "ready" : "consent needed"}
        </span>
      </div>
      {view.errors.action ? (
        <p className="error">{pullRequestActionError(view.errors.action)}</p>
      ) : null}
      {view.repo && pullNumber ? (
        <div className="draft-actions">
          <DraftActionForm
            actionType="reviewDraft"
            canGenerate={canGenerate}
            label="Generate review draft"
            pendingLabel="Generating review..."
            providerId={view.selectedProvider?.id ?? null}
            pullNumber={pullNumber}
            repoId={view.repo.id}
            tab={view.filters.tab}
          />
          <DraftActionForm
            actionType="triageDraft"
            canGenerate={canGenerate}
            label="Generate triage draft"
            pendingLabel="Generating triage..."
            providerId={view.selectedProvider?.id ?? null}
            pullNumber={pullNumber}
            repoId={view.repo.id}
            tab={view.filters.tab}
          />
        </div>
      ) : null}
      {!canGenerate ? (
        <p className="muted">
          Select a model provider with repository-content consent before model
          drafts can run.
        </p>
      ) : null}
      {selectedReview ? (
        <div className="draft-editor-stack">
          <div className="draft-toggle" aria-label="Draft type">
            <Link
              className={
                view.filters.draft === "review"
                  ? "repo-link active"
                  : "repo-link"
              }
              href={
                view.repo && pullNumber
                  ? pullRequestHref({
                      repoId: view.repo.id,
                      pullNumber,
                      filters: { ...view.filters, draft: "review" },
                      providerId: view.selectedProvider?.id ?? null,
                      reviewId: selectedReview.id,
                    })
                  : "/pull-requests"
              }
            >
              Review
            </Link>
            <Link
              className={
                view.filters.draft === "triage"
                  ? "repo-link active"
                  : "repo-link"
              }
              href={
                view.repo && pullNumber
                  ? pullRequestHref({
                      repoId: view.repo.id,
                      pullNumber,
                      filters: { ...view.filters, draft: "triage" },
                      providerId: view.selectedProvider?.id ?? null,
                      reviewId: selectedReview.id,
                    })
                  : "/pull-requests"
              }
            >
              Triage
            </Link>
          </div>
          <textarea
            className="draft-editor"
            defaultValue={
              view.filters.draft === "triage"
                ? triageDraftMarkdown(selectedReview)
                : reviewDraftMarkdown(selectedReview)
            }
          />
          <p className="muted">
            Drafts are editable here; this route does not post comments,
            reviews, labels, or other GitHub mutations.
          </p>
        </div>
      ) : (
        <p className="muted">
          Generated review and triage drafts for this PR will appear here.
        </p>
      )}
    </section>
  );
}

function MetadataPanel({ pullRequest }: { pullRequest: PullRequestDetail }) {
  const summary = pullRequest.summary;
  return (
    <aside className="panel metadata-panel" aria-label="Pull request metadata">
      <h2>Metadata</h2>
      <MetadataItem label="Status" value={attentionLabel(summary.attention)} />
      <MetadataItem label="Review" value={summary.reviewDecision ?? "none"} />
      <MetadataItem
        label="Merge"
        value={summary.mergeStateStatus ?? "unknown"}
      />
      <MetadataItem label="Checks" value={checksLabel(summary)} />
      <MetadataList
        label="Automatic triage"
        values={summary.triageTags.map((tag) => tag.githubLabel)}
      />
      <MetadataList label="Labels" values={summary.labels} />
      <MetadataList label="Reviewers" values={summary.reviewers} />
      <MetadataList label="Assignees" values={summary.assignees} />
      <div>
        <h3>Checks</h3>
        {pullRequest.checks.length ? (
          <ul className="plain-list">
            {pullRequest.checks.map((check) => (
              <li key={`${check.name}-${check.status}`}>
                {check.name}: {check.conclusion ?? check.status}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No checks were returned.</p>
        )}
      </div>
    </aside>
  );
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <h3>{label}</h3>
      <p>{value}</p>
    </div>
  );
}

function MetadataList({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <h3>{label}</h3>
      <p className="muted">{values.length ? values.join(", ") : "none"}</p>
    </div>
  );
}

function StatePanel({
  children,
  title,
  tone = "neutral",
}: {
  children: string;
  title: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <div
      className={
        tone === "warn" ? "panel state-panel warn" : "panel state-panel"
      }
    >
      <h2>{title}</h2>
      <p className={tone === "warn" ? "error" : "muted"}>{children}</p>
    </div>
  );
}

function StatusCard({
  label,
  value,
}: {
  label: string;
  value: string | undefined;
}) {
  return (
    <div className="panel status">
      <strong>{label}</strong>
      <span
        className={
          value === "ok" || value === "local-gh" || value === "github-app"
            ? "badge"
            : "badge warn"
        }
      >
        {value ?? "missing"}
      </span>
    </div>
  );
}

function timelineTitle(item: PullRequestTimelineItem): string {
  const actor = item.author ?? "unknown";
  if (item.kind === "opened") {
    return `${actor} opened this pull request`;
  }
  if (item.kind === "review_comment") {
    return `${actor} commented on a file`;
  }
  if (item.kind === "review") {
    return `${actor} reviewed${item.state ? `: ${item.state}` : ""}`;
  }
  return `${actor} commented`;
}

function attentionLabel(attention: PullRequestListItem["attention"]): string {
  if (attention === "checks_failed") {
    return "checks failed";
  }
  if (attention === "changes_requested") {
    return "changes requested";
  }
  if (attention === "review_required") {
    return "review required";
  }
  if (attention === "conflicts") {
    return "conflicts";
  }
  return attention;
}

function attentionClass(attention: PullRequestListItem["attention"]): string {
  return attention === "none" ? "badge subtle" : "badge warn";
}

function stateClass(state: PullRequestListItem["state"]): string {
  return state === "open" ? "badge" : "badge warn";
}

function summarizePullRequests(pullRequests: PullRequestListItem[]): {
  visible: number;
  needsAction: number;
  reviewRequired: number;
  failingChecks: number;
} {
  return {
    visible: pullRequests.length,
    needsAction: pullRequests.filter(
      (pullRequest) => pullRequest.attention !== "none",
    ).length,
    reviewRequired: pullRequests.filter(
      (pullRequest) => pullRequest.attention === "review_required",
    ).length,
    failingChecks: pullRequests.filter(
      (pullRequest) => pullRequest.checksSummary.failing > 0,
    ).length,
  };
}

function checksLabel(pullRequest: PullRequestListItem): string {
  const checks = pullRequest.checksSummary;
  if (checks.total === 0) {
    return "checks unavailable";
  }
  if (checks.failing > 0) {
    return `${checks.failing}/${checks.total} failing`;
  }
  if (checks.pending > 0) {
    return `${checks.pending}/${checks.total} pending`;
  }
  return `${checks.passing}/${checks.total} passing`;
}

function reviewDecisionLabel(pullRequest: PullRequestListItem): string {
  return pullRequest.reviewDecision
    ? formatSnakeCase(pullRequest.reviewDecision.toLowerCase())
    : "review pending";
}

function mergeStateLabel(pullRequest: PullRequestListItem): string {
  if (pullRequest.mergeStateStatus) {
    return `merge ${statusPhrase(pullRequest.mergeStateStatus)}`;
  }
  if (pullRequest.mergeable) {
    return `merge ${statusPhrase(pullRequest.mergeable)}`;
  }
  return "merge unknown";
}

function statusPhrase(value: string): string {
  return formatSnakeCase(value.toLowerCase()).toLowerCase();
}

function commentsLabel(pullRequest: PullRequestListItem): string {
  const count = pullRequest.comments + pullRequest.reviewComments;
  return `${formatNumber(count)} ${count === 1 ? "comment" : "comments"}`;
}

function diffStat(pullRequest: PullRequestListItem): string {
  return `+${formatNumber(pullRequest.additions)} -${formatNumber(pullRequest.deletions)}`;
}

function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "diff-line addition";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "diff-line deletion";
  }
  if (line.startsWith("@@")) {
    return "diff-line hunk";
  }
  return "diff-line";
}

function pullRequestErrorMessage(error: string): string {
  if (error === "unreachable") {
    return "The API did not respond while loading pull requests.";
  }
  const parsed = parseStatusError(error);
  if (parsed.status === "409") {
    return (
      parsed.detail ||
      "Pull request access is not configured for this repository."
    );
  }
  return parsed.detail
    ? `Pull request API status ${parsed.status}. ${parsed.detail}`
    : `Pull request API status ${parsed.status}.`;
}

function pullRequestActionError(error: string): string {
  if (error === "invalid-pr-action") {
    return "That pull request action was not recognized.";
  }
  if (error === "unreachable") {
    return "The API did not respond while generating the draft.";
  }
  const parsed = parseStatusError(error);
  if (parsed.status === "403") {
    return (
      parsed.detail ||
      "Repository-content consent is required before model drafts can run."
    );
  }
  return parsed.detail
    ? `Draft generation failed with API status ${parsed.status}. ${parsed.detail}`
    : `Draft generation failed with API status ${parsed.status}.`;
}

function pullRequestTriageError(error: string): string {
  if (error === "unreachable") {
    return "The API did not respond while applying PR triage labels.";
  }
  const parsed = parseStatusError(error);
  if (parsed.status === "403") {
    return (
      parsed.detail ||
      "Repository-content consent is required before LLM PR triage can run."
    );
  }
  return parsed.detail
    ? `PR triage failed with API status ${parsed.status}. ${parsed.detail}`
    : `PR triage failed with API status ${parsed.status}.`;
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

function formatDate(value: string | null): string {
  if (!value) {
    return "unknown";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatRelativeDate(value: string | null): string {
  if (!value) {
    return "unknown";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const diffMs = Date.now() - date.getTime();
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (diffMs >= 0 && diffMs < minuteMs) {
    return "just now";
  }
  if (diffMs >= 0 && diffMs < hourMs) {
    const minutes = Math.max(1, Math.floor(diffMs / minuteMs));
    return `${minutes}m ago`;
  }
  if (diffMs >= 0 && diffMs < dayMs) {
    const hours = Math.max(1, Math.floor(diffMs / hourMs));
    return `${hours}h ago`;
  }
  if (diffMs >= 0 && diffMs < 30 * dayMs) {
    const days = Math.max(1, Math.floor(diffMs / dayMs));
    return `${days}d ago`;
  }
  return date.toLocaleDateString();
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatSnakeCase(value: string): string {
  return value
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
