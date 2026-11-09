"use client";

import Link from "next/link";
import { useState, type SyntheticEvent } from "react";

// "Final demand" on an overdue invoice row: makes the letter and leaves it in the Outbox. It never
// sends: the freelancer reads it there and approves it first.

type Issue = { field: string; message: string };

export const FinalDemandButton = ({ invoiceId }: { invoiceId: string }) => {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  const make = async (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/invoices/${invoiceId}/final-demand`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadlineDays: Number(days) }),
      });
      if (response.ok) {
        setDone(true);
        return;
      }
      const body = (await response.json()) as { error?: string; errors?: Issue[] };
      const first = body.errors?.[0];
      setError(
        first ? `Days to pay ${first.message}.` : (body.error ?? "That didn't work. Try again."),
      );
    } catch {
      setError("That didn't work. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <span role="status">
        Final demand drafted. <Link href="/outbox">Read it in the Outbox</Link>; nothing is sent
        until you approve it.
      </span>
    );
  }
  if (!open) {
    return (
      <button
        className="button button-secondary"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Final demand
      </button>
    );
  }
  return (
    <form className="form" onSubmit={(event) => void make(event)} noValidate>
      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="field">
        <label htmlFor={`demand-days-${invoiceId}`}>Days to pay (7 to 14)</label>
        <input
          id={`demand-days-${invoiceId}`}
          inputMode="numeric"
          value={days}
          onChange={(e) => {
            setDays(e.target.value);
          }}
        />
        <div className="field-hint">
          A formal letter with the amount owed, any interest the law allows, and this deadline. It
          waits in your Outbox for approval. This is not legal advice.
        </div>
      </div>
      <div className="actions">
        <button className="button" type="submit" disabled={busy}>
          Make the final demand
        </button>
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
};
