"use client";

import { type FormEvent, useState } from "react";

type DraftActionFormProps = {
  actionType: "reviewDraft" | "triageDraft";
  canGenerate: boolean;
  label: string;
  pendingLabel: string;
  providerId: string | null;
  pullNumber: number;
  repoId: string;
  tab: string;
};

export function DraftActionForm({
  actionType,
  canGenerate,
  label,
  pendingLabel,
  providerId,
  pullNumber,
  repoId,
  tab,
}: DraftActionFormProps) {
  const [pending, setPending] = useState(false);
  const disabled = !canGenerate || pending;

  function submitWithPendingFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) {
      return;
    }
    const form = event.currentTarget;
    setPending(true);
    window.setTimeout(() => form.submit(), 0);
  }

  return (
    <form
      action="/pull-request-actions"
      method="post"
      onSubmit={submitWithPendingFeedback}
    >
      <input type="hidden" name="repoId" value={repoId} />
      <input type="hidden" name="pullNumber" value={pullNumber} />
      <input type="hidden" name="actionType" value={actionType} />
      <input type="hidden" name="tab" value={tab} />
      {providerId ? (
        <input type="hidden" name="providerId" value={providerId} />
      ) : null}
      <button disabled={disabled} type="submit">
        {pending ? pendingLabel : label}
      </button>
      {pending ? (
        <output className="draft-action-status">
          Preparing PR context and model draft...
        </output>
      ) : null}
    </form>
  );
}
