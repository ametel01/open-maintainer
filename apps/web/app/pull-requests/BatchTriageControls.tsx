"use client";

import { type MouseEvent, useEffect, useRef, useState } from "react";

type BatchTriageControlsProps = {
  canRunTriage: boolean;
  clearHref: string | null;
  initialSelectedCount: number;
  resultMessage: string | null;
  errorMessage: string | null;
};

export function BatchTriageControls({
  canRunTriage,
  clearHref,
  errorMessage,
  initialSelectedCount,
  resultMessage,
}: BatchTriageControlsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  const [selectedCount, setSelectedCount] = useState(initialSelectedCount);

  useEffect(() => {
    const form = rootRef.current?.closest("form");
    if (!form) {
      return;
    }
    const updateSelectedCount = () => {
      setSelectedCount(
        form.querySelectorAll<HTMLInputElement>(
          'input[name="selectedPr"]:checked',
        ).length,
      );
    };
    updateSelectedCount();
    form.addEventListener("change", updateSelectedCount);
    return () => form.removeEventListener("change", updateSelectedCount);
  }, []);

  const disabled = pending || !canRunTriage || selectedCount === 0;

  function submitWithPendingFeedback(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (disabled) {
      return;
    }
    const form = event.currentTarget.form;
    if (!form) {
      return;
    }
    setPending(true);
    window.setTimeout(() => form.submit(), 0);
  }

  return (
    <div ref={rootRef}>
      <div className="pr-batch-actions">
        <button
          disabled={disabled}
          onClick={submitWithPendingFeedback}
          type="submit"
        >
          {pending
            ? "Running LLM triage..."
            : "Run LLM triage and apply labels"}
        </button>
        {clearHref ? (
          <a className="repo-link" href={clearHref}>
            Clear
          </a>
        ) : null}
      </div>
      <div className="pr-batch-results" aria-live="polite">
        {selectedCount > 0 ? (
          <p className="muted">
            {selectedCount} selected PR{selectedCount === 1 ? "" : "s"}.
          </p>
        ) : (
          <p className="muted">Select one or more PRs to triage.</p>
        )}
        {!canRunTriage ? (
          <p className="error">
            Select a model provider with repository-content consent before
            applying PR triage labels.
          </p>
        ) : null}
        {pending ? (
          <output className="draft-action-status">
            Fetching selected PR evidence, asking the model, then applying
            labels...
          </output>
        ) : null}
        {!pending && resultMessage ? <strong>{resultMessage}</strong> : null}
        {!pending && errorMessage ? (
          <p className="error">{errorMessage}</p>
        ) : null}
      </div>
    </div>
  );
}
