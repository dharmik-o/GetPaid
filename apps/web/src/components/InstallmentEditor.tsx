"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fieldLabel, sendJson } from "@/lib/api-client";
import { formatAmountInput, parseAmount } from "@/lib/currencies";
import { formatDay, formatMoney } from "@/lib/format";
import {
  checkInstallments,
  MAX_INSTALLMENTS,
  MIN_INSTALLMENTS,
  splitEvenly,
  type InstallmentItem,
} from "@/lib/installments";

// "Pay in installments" at setup, for a pay-on-invoice milestone: 2 to 12 installments, each
// with an amount and a due date, adding up to the milestone exactly. All their invoices are
// created when the work is delivered. Never PayPal partial payments.

type Props = {
  milestoneId: string;
  name: string;
  cents: number;
  currency: string;
  /** The saved setup plan, if there is one. */
  saved: InstallmentItem[] | null;
  /** Today in the client's time zone, for the date check. */
  today: string;
};

type Row = { amount: string; dueDate: string };

const NAMES = { items: "Installments", paymentMode: "Payment mode" };

const COUNTS = Array.from(
  { length: MAX_INSTALLMENTS - MIN_INSTALLMENTS + 1 },
  (_, i) => i + MIN_INSTALLMENTS,
);

const evenRows = (cents: number, count: number, currency: string, old: Row[]): Row[] =>
  splitEvenly(cents, count).map((amount, i) => ({
    amount: formatAmountInput(amount, currency),
    dueDate: old[i]?.dueDate ?? "",
  }));

type Parsed = { items: InstallmentItem[] } | { message: string };

const parseRows = (rows: Row[], currency: string): Parsed => {
  const items: InstallmentItem[] = [];
  for (const [index, row] of rows.entries()) {
    const amount = parseAmount(row.amount, currency);
    if (!amount.ok) return { message: `Installment ${String(index + 1)} amount ${amount.message}` };
    items.push({ amountCents: amount.minor, dueDate: row.dueDate || null });
  }
  return { items };
};

export const InstallmentEditor = ({ milestoneId, name, cents, currency, saved, today }: Props) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>(() =>
    saved
      ? saved.map((item) => ({
          amount: formatAmountInput(item.amountCents, currency),
          dueDate: item.dueDate ?? "",
        }))
      : evenRows(cents, 2, currency, []),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean }>();

  const parsed = parseRows(rows, currency);
  const issues =
    "items" in parsed
      ? checkInstallments(parsed.items, { totalCents: cents, currency, datesRequired: true, today })
      : [];
  const firstIssue = issues[0];
  const problem =
    "message" in parsed
      ? parsed.message
      : firstIssue
        ? `${fieldLabel(firstIssue.field, NAMES)} ${firstIssue.message}`
        : undefined;

  const url = `/api/milestones/${milestoneId}/installments`;

  const save = async (method: "PUT" | "DELETE", body: unknown, done: string) => {
    setBusy(true);
    setMessage(undefined);
    const result = await sendJson(url, method, body, NAMES);
    setBusy(false);
    if (!result.ok) {
      setMessage({ text: result.message, error: true });
      return;
    }
    setMessage({ text: done, error: false });
    setOpen(false);
    router.refresh();
  };

  if (!open) {
    return (
      <div>
        {saved ? (
          <ol className="field-hint">
            {saved.map((item, i) => (
              <li key={i}>
                {formatMoney(item.amountCents, currency)} due{" "}
                {item.dueDate ? formatDay(item.dueDate) : "per the terms"}
              </li>
            ))}
          </ol>
        ) : null}
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            setOpen(true);
          }}
        >
          {saved ? "Change installments" : "Pay in installments"}
        </button>
        {saved ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => {
              void save("DELETE", {}, `${name} is back to one invoice.`);
            }}
          >
            Use one invoice
          </button>
        ) : null}
        {message ? (
          <div className={message.error ? "banner banner-error" : "banner"} role="status">
            {message.text}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <fieldset className="form">
      <legend>Installments for {name}</legend>
      <label>
        Number of installments
        <select
          value={rows.length}
          onChange={(e) => {
            setRows(evenRows(cents, Number(e.target.value), currency, rows));
          }}
        >
          {COUNTS.map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </select>
      </label>
      {rows.map((row, i) => (
        <div key={i} className="row-actions">
          <label>
            Installment {i + 1} ({currency})
            <input
              inputMode="decimal"
              value={row.amount}
              onChange={(e) => {
                setRows(rows.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)));
              }}
            />
          </label>
          <label>
            Due date (client&apos;s date)
            <input
              type="date"
              value={row.dueDate}
              min={today}
              onChange={(e) => {
                setRows(rows.map((r, j) => (j === i ? { ...r, dueDate: e.target.value } : r)));
              }}
            />
          </label>
        </div>
      ))}
      <p className="field-hint">
        They must add up to {formatMoney(cents, currency)}. An even split puts any rounding on the
        last installment. Each gets its own PayPal invoice when the work is delivered.
      </p>
      {problem ? (
        <p className="warning-text" role="status">
          {problem}
        </p>
      ) : null}
      <div>
        <button
          type="button"
          className="button"
          disabled={busy || problem !== undefined}
          onClick={() => {
            if ("items" in parsed) {
              void save("PUT", { items: parsed.items }, `Installments saved for ${name}.`);
            }
          }}
        >
          {busy ? "Saving…" : "Save installments"}
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            setOpen(false);
          }}
        >
          Close
        </button>
      </div>
      {message ? (
        <div className={message.error ? "banner banner-error" : "banner"} role="status">
          {message.text}
        </div>
      ) : null}
    </fieldset>
  );
};
