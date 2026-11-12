"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { sendJson } from "@/lib/api-client";
import { CANCEL_REASON_LABELS, CANCEL_REASONS, type CancelReason } from "@/lib/invoice-closing";

// "Cancel invoice": a reason is required, so the record says why. Not offered on a paid invoice.

type Props = {
  invoiceId: string;
  /** What is being cancelled, in words: "invoice FPR-000008" or "the installment plan for Build". */
  what: string;
  label?: string;
  className?: string;
};

export const CancelInvoice = ({
  invoiceId,
  what,
  label = "Cancel invoice",
  className = "button button-danger",
}: Props) => {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<CancelReason | "">("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const cancel = async () => {
    if (!reason) {
      setProblem("Pick a reason first.");
      return;
    }
    setBusy(true);
    setProblem(undefined);
    const result = await sendJson(
      `/api/invoices/${invoiceId}/cancel`,
      "POST",
      { reason },
      {
        reason: "Reason",
      },
    );
    setBusy(false);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    setOpen(false);
    router.refresh();
  };

  if (!open) {
    return (
      <button
        className={className}
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </button>
    );
  }
  return (
    <div className="editor-form" role="group" aria-label={`Cancel ${what}`}>
      <p>
        Cancel {what}? The client won&apos;t be able to pay it, and its reminders stop. This
        can&apos;t be undone.
      </p>
      <label htmlFor={`${id}-reason`}>Why?</label>
      <select
        id={`${id}-reason`}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value as CancelReason | "");
        }}
      >
        <option value="">Pick a reason</option>
        {CANCEL_REASONS.map((value) => (
          <option key={value} value={value}>
            {CANCEL_REASON_LABELS[value]}
          </option>
        ))}
      </select>
      {problem ? (
        <p className="banner banner-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="actions">
        <button
          className="button button-danger"
          type="button"
          disabled={busy}
          onClick={() => void cancel()}
        >
          {busy ? "Cancelling…" : "Confirm cancel"}
        </button>
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false);
          }}
        >
          Keep invoice
        </button>
      </div>
    </div>
  );
};
