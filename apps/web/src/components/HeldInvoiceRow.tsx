"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { sendJson } from "@/lib/api-client";
import { formatDay } from "@/lib/format";
import type { HeldInvoice } from "@/lib/reply-review";

// An invoice with its reminders held or paused, and the way to start them again.

export const HeldInvoiceRow = ({ invoice }: { invoice: HeldInvoice }) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const resume = async () => {
    setBusy(true);
    setError(undefined);
    const result = await sendJson(`/api/invoices/${invoice.id}/resume-reminders`, "POST", {}, {});
    setBusy(false);
    if (result.ok) router.refresh();
    else setError(result.message);
  };

  return (
    <div className="card outbox-card">
      <div className="outbox-head">
        <div>
          <p>
            <strong>{invoice.clientName}</strong>{" "}
            {invoice.pausedUntil ? `paused until ${formatDay(invoice.pausedUntil)}` : "on hold"}
          </p>
          <p className="muted">{invoice.what}</p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            void resume();
          }}
        >
          Resume reminders
        </button>
      </div>
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
};
