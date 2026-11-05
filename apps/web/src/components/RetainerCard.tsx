"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { sendJson } from "@/lib/api-client";
import { formatDay, formatMoney } from "@/lib/format";
import type { Retainer } from "@/lib/retainers";

// One retainer: its fee, what's next, the client's approval link, and recent invoices.

const STATUS_NAMES: Record<Retainer["status"], string> = {
  pending_approval: "Waiting for the client",
  active: "Active",
  suspended: "Suspended",
  cancelled: "Cancelled",
  ended: "Ended",
};

const INVOICE_STATUS_NAMES: Record<string, string> = {
  draft: "Being created",
  sent: "Open",
  partially_paid: "Partly paid",
  paid: "Paid",
  cancelled: "Cancelled",
  refunded: "Refunded",
  disputed: "Disputed",
};

const APPROVAL_EMAIL_TEXT: Record<Retainer["approvalEmail"], string> = {
  none: "The client hasn't been asked to approve auto-pay. Draft the email, then review it in the Outbox.",
  waiting: "The email asking the client to approve auto-pay is waiting for you in the Outbox.",
  scheduled:
    "The email asking the client to approve auto-pay is approved, and goes out in their send window.",
  sent: "The client has been emailed the approval link. This changes once they approve.",
};

const repeatText = ({ unit, count }: Retainer): string =>
  count === 1 ? `Every ${unit}` : `Every ${String(count)} ${unit}s`;

const canCancel = ({ status }: Retainer): boolean =>
  status === "pending_approval" || status === "active" || status === "suspended";

export const RetainerCard = ({ retainer }: { retainer: Retainer }) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const act = async (action: "setup" | "cancel" | "email") => {
    setBusy(true);
    setError(undefined);
    const result = await sendJson(`/api/retainers/${retainer.id}`, "POST", { action }, {});
    setBusy(false);
    if (result.ok) router.refresh();
    else setError(result.message);
  };

  return (
    <article className="card outbox-card" aria-label={retainer.name}>
      <div className="outbox-head">
        <div>
          <h2>{retainer.name}</h2>
          <p className="muted">
            {[retainer.clientName, retainer.projectTitle].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="money">{formatMoney(retainer.amountCents, retainer.currency)}</div>
      </div>
      <p className="outbox-meta">
        <span className="chip">{STATUS_NAMES[retainer.status]}</span>{" "}
        <span className="chip">{retainer.method === "auto_pay" ? "Auto-pay" : "Invoice"}</span>
      </p>
      <p className="muted">
        {repeatText(retainer)}, from {formatDay(retainer.startsOn)}
        {retainer.endsOn ? ` to ${formatDay(retainer.endsOn)}` : ", until cancelled"}
        {retainer.nextChargeOn ? `. Next charge ${formatDay(retainer.nextChargeOn)}.` : "."}
      </p>
      {retainer.pausedForInvoice ? (
        <p>
          A charge failed, so auto-pay is paused in PayPal and can&apos;t charge the client again.
          It comes back on once the invoice for that charge is paid.
        </p>
      ) : null}
      {retainer.status === "pending_approval" && retainer.setUp ? (
        <p>{APPROVAL_EMAIL_TEXT[retainer.approvalEmail]}</p>
      ) : null}
      {retainer.invoices.length > 0 ? (
        <ul>
          {retainer.invoices.map((invoice) => (
            <li key={invoice.id}>
              {formatDay(invoice.cycleOn)}: {invoice.number},{" "}
              {formatMoney(invoice.amountCents, retainer.currency)},{" "}
              {INVOICE_STATUS_NAMES[invoice.status] ?? invoice.status}
              {invoice.afterFailedCharge ? " (auto-pay failed)" : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        {!retainer.setUp && retainer.status === "pending_approval" ? (
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => void act("setup")}
          >
            Finish setup
          </button>
        ) : null}
        {retainer.status === "pending_approval" &&
        retainer.setUp &&
        retainer.approvalEmail === "none" ? (
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => void act("email")}
          >
            Draft the approval email
          </button>
        ) : null}
        {canCancel(retainer) ? (
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void act("cancel")}
          >
            Cancel retainer
          </button>
        ) : null}
      </div>
    </article>
  );
};
