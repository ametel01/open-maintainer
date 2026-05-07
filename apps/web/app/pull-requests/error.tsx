"use client";

export default function PullRequestsError() {
  return (
    <main>
      <div className="shell pr-shell">
        <section className="panel state-panel warn">
          <h1>Open Maintainer</h1>
          <p className="error">Pull request management could not render.</p>
        </section>
      </div>
    </main>
  );
}
