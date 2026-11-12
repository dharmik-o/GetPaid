"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { sendJson } from "@/lib/api-client";
import { formatAmountInput, parseAmount } from "@/lib/currencies";
import { formatDay, formatMoney } from "@/lib/format";
import { METHOD_LABELS, PAYMENT_METHODS, type PaymentMethod } from "@/lib/invoice-closing";

// "Record a payment": the freelancer says money arrived outside PayPal. A confirm step says
// exactly what will happen before anything is sent. Only a person pressing the button gets here:
// a client's words or the AI's reading of them can open this form but never fill it in and send it.

export type PaymentTarget = {
  invoiceId: string;
  invoiceNumber: string;
  currency: string;
  /** What is still owed, in minor units: the form's default and its limit. */
  owedCents: number;
};

type Props = {
  invoice: PaymentTarget;
  label?: string;
  className?: string;
  /** Called after PayPal and this app have both recorded it. */
  onRecorded?: () => void;
};

const FIELD_NAMES = {
  method: "Method",
  amountCents: "Amount",
  receivedOn: "Date received",
  reference: "Reference",
};

/** The freelancer's own calendar date, from their browser (the server checks it again). */
const localToday = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${String(now.getFullYear())}-${month}-${day}`;
};

const PaymentForm = ({
  invoice,
  onClose,
  onRecorded,
}: {
  invoice: PaymentTarget;
  onClose: () => void;
  onRecorded?: () => void;
}) => {
  const router = useRouter();
  const id = useId();
  const { currency } = invoice;
  const [today] = useState(localToday);
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const [amount, setAmount] = useState(formatAmountInput(invoice.owedCents, currency));
  const [receivedOn, setReceivedOn] = useState(today);
  const [reference, setReference] = useState("");
  const [confirming, setConfirming] = useState<number>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  const review = () => {
    const parsed = parseAmount(amount, currency);
    if (!parsed.ok) {
      setProblem(`Amount ${parsed.message}.`);
      return;
    }
    if (parsed.minor > invoice.owedCents) {
      setProblem(
        `Amount can't be more than what is still owed (${formatMoney(invoice.owedCents, currency)}).`,
      );
      return;
    }
    if (!receivedOn || receivedOn > today) {
      setProblem("Date received can't be in the future.");
      return;
    }
    setProblem(undefined);
    setConfirming(parsed.minor);
  };

  const record = async () => {
    if (confirming === undefined) return;
    setBusy(true);
    const result = await sendJson(
      `/api/invoices/${invoice.invoiceId}/payments`,
      "POST",
      { method, amountCents: confirming, receivedOn, ...(reference.trim() ? { reference } : {}) },
      FIELD_NAMES,
    );
    setBusy(false);
    if (!result.ok) {
      setConfirming(undefined);
      setProblem(result.message);
      return;
    }
    onClose();
    router.refresh();
    onRecorded?.();
  };

  if (confirming !== undefined) {
    const rest = invoice.owedCents - confirming;
    return (
      <div className="editor-form" role="group" aria-label="Confirm the payment">
        <p>
          <strong>
            Record {formatMoney(confirming, currency)} by {METHOD_LABELS[method]}, received{" "}
            {formatDay(receivedOn)}, on invoice {invoice.invoiceNumber}?
          </strong>
        </p>
        <ul className="field-hint">
          <li>PayPal is told first. If it refuses, nothing changes and you&apos;ll see why.</li>
          {rest === 0 ? (
            <li>
              The invoice becomes Paid, its PayPal pay link stops taking payment, and its reminders
              stop.
            </li>
          ) : (
            <li>
              The invoice becomes Partially paid, with {formatMoney(rest, currency)} still owed.
              Reminders waiting to go out are stopped; new ones quote the new balance.
            </li>
          )}
          <li>It is saved with the project&apos;s records. The client is not emailed.</li>
        </ul>
        <div className="actions">
          <button className="button" type="button" disabled={busy} onClick={() => void record()}>
            {busy ? "Recording…" : "Confirm and record"}
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              setConfirming(undefined);
            }}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="editor-form"
      role="group"
      aria-label={`Record a payment for ${invoice.invoiceNumber}`}
    >
      <label htmlFor={`${id}-method`}>Method</label>
      <select
        id={`${id}-method`}
        value={method}
        onChange={(event) => {
          setMethod(event.target.value as PaymentMethod);
        }}
      >
        {PAYMENT_METHODS.map((value) => (
          <option key={value} value={value}>
            {METHOD_LABELS[value]}
          </option>
        ))}
      </select>
      <div className="field-row">
        <div>
          <label htmlFor={`${id}-amount`}>Amount ({currency})</label>
          <input
            id={`${id}-amount`}
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
          <p className="field-hint">Still owed: {formatMoney(invoice.owedCents, currency)}</p>
        </div>
        <div>
          <label htmlFor={`${id}-date`}>Date received</label>
          <input
            id={`${id}-date`}
            type="date"
            max={today}
            value={receivedOn}
            onChange={(event) => {
              setReceivedOn(event.target.value);
            }}
          />
        </div>
      </div>
      <label htmlFor={`${id}-ref`}>Reference or note (optional)</label>
      <input
        id={`${id}-ref`}
        maxLength={200}
        value={reference}
        onChange={(event) => {
          setReference(event.target.value);
        }}
      />
      {problem ? (
        <p className="banner banner-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="actions">
        <button className="button" type="button" onClick={review}>
          Review
        </button>
        <button className="button button-secondary" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
};

export const RecordPayment = ({
  invoice,
  label = "Record a payment",
  className,
  onRecorded,
}: Props) => {
  const [open, setOpen] = useState(false);
  if (invoice.owedCents <= 0) return null;
  return open ? (
    <PaymentForm
      invoice={invoice}
      onRecorded={onRecorded}
      onClose={() => {
        setOpen(false);
      }}
    />
  ) : (
    <button
      className={className ?? "button button-secondary"}
      type="button"
      onClick={() => {
        setOpen(true);
      }}
    >
      {label}
    </button>
  );
};
