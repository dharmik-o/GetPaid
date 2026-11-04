"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { fieldLabel, sendJson } from "@/lib/api-client";
import { formatAmountInput, parseAmount } from "@/lib/currencies";
import { formatMoney } from "@/lib/format";
import {
  MAX_INSTALLMENTS,
  MIN_INSTALLMENTS,
  splitEvenly,
  type InstallmentItem,
} from "@/lib/installments";
import type { ReplyItem } from "@/lib/reply-review";
import { primaryLabel } from "@/lib/reply-labels";

// A client's reply, and what the AI thinks it says. The AI only suggests: nothing changes until
// the freelancer chooses, and any split's amounts and dates are theirs. The client's words are
// untrusted, and React shows them as plain text.

export type SplitOffer = { remainderCents: number; items: InstallmentItem[] };

type Props = { reply: ReplyItem; offer: SplitOffer | null };

const LABEL_NAMES: Record<ReplyItem["label"], string> = {
  promise: "Promises to pay",
  installments: "Asks to pay in parts",
  paid_elsewhere: "Says they've paid",
  dispute: "Disputes the work",
  out_of_office: "Out of office",
  unclear: "Unclear",
};

const FIELD_NAMES = { items: "Installments" };

const COUNTS = Array.from(
  { length: MAX_INSTALLMENTS - MIN_INSTALLMENTS + 1 },
  (_, i) => i + MIN_INSTALLMENTS,
);

type Row = { amount: string; dueDate: string };

const toRows = (items: readonly InstallmentItem[], currency: string): Row[] =>
  items.map((item) => ({
    amount: formatAmountInput(item.amountCents, currency),
    dueDate: item.dueDate ?? "",
  }));

const SplitForm = ({
  reply,
  offer,
  busy,
  act,
}: {
  reply: ReplyItem;
  offer: SplitOffer;
  busy: boolean;
  act: (payload: object) => Promise<void>;
}) => {
  const { currency } = reply;
  const [rows, setRows] = useState<Row[]>(() => toRows(offer.items, currency));
  const [problem, setProblem] = useState<string>();

  const setCount = (count: number) => {
    setRows((old) =>
      splitEvenly(offer.remainderCents, count).map((cents, index) => ({
        amount: formatAmountInput(cents, currency),
        dueDate: old[index]?.dueDate ?? "",
      })),
    );
  };

  const update = (index: number, change: Partial<Row>) => {
    setRows((old) => old.map((row, i) => (i === index ? { ...row, ...change } : row)));
  };

  const submit = async () => {
    const items: InstallmentItem[] = [];
    for (const [index, row] of rows.entries()) {
      const parsed = parseAmount(row.amount, currency);
      if (!parsed.ok) {
        setProblem(`Installment ${String(index + 1)} ${parsed.message}.`);
        return;
      }
      items.push({ amountCents: parsed.minor, dueDate: row.dueDate || null });
    }
    setProblem(undefined);
    await act({ action: "split", items });
  };

  return (
    <div className="editor-form">
      <p>
        Split the unpaid {formatMoney(offer.remainderCents, currency)}. Approving cancels the open
        unpaid invoices and creates these, each with its own PayPal link. Anything already paid
        stays as it is.
      </p>
      <label htmlFor={`count-${reply.id}`}>Installments</label>
      <select
        id={`count-${reply.id}`}
        value={rows.length}
        onChange={(event) => {
          setCount(Number(event.target.value));
        }}
      >
        {COUNTS.map((count) => (
          <option key={count} value={count}>
            {count}
          </option>
        ))}
      </select>
      {rows.map((row, index) => (
        <div className="field-row" key={index}>
          <div>
            <label htmlFor={`amount-${reply.id}-${String(index)}`}>
              Installment {index + 1} amount ({currency})
            </label>
            <input
              id={`amount-${reply.id}-${String(index)}`}
              inputMode="decimal"
              value={row.amount}
              onChange={(event) => {
                update(index, { amount: event.target.value });
              }}
            />
          </div>
          <div>
            <label htmlFor={`due-${reply.id}-${String(index)}`}>Due</label>
            <input
              id={`due-${reply.id}-${String(index)}`}
              type="date"
              min={reply.today}
              value={row.dueDate}
              onChange={(event) => {
                update(index, { dueDate: event.target.value });
              }}
            />
          </div>
        </div>
      ))}
      {problem ? (
        <p className="banner banner-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="actions">
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => {
            void submit();
          }}
        >
          Approve split and replace the invoice
        </button>
      </div>
    </div>
  );
};

export const ReplyCard = ({ reply, offer }: Props) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [splitting, setSplitting] = useState(reply.suggestion.kind === "split");

  const act = async (payload: object) => {
    setBusy(true);
    setError(undefined);
    const result = await sendJson(`/api/replies/${reply.id}`, "POST", payload, FIELD_NAMES);
    setBusy(false);
    if (result.ok) router.refresh();
    else setError(result.message.replace("items", fieldLabel("items", FIELD_NAMES)));
  };

  return (
    <article className="card outbox-card" aria-label={`Reply from ${reply.clientName}`}>
      <div className="outbox-head">
        <div>
          <h2>{reply.clientName} replied</h2>
          <p className="muted">{reply.what}</p>
        </div>
        <div className="money">{reply.amountDue}</div>
      </div>
      <p className="outbox-body">{reply.text}</p>
      <p>
        <span className="chip">AI suggestion: {LABEL_NAMES[reply.label]}</span>
        {reply.summary}
      </p>
      <p className="field-hint">
        Reminders for this invoice are on hold until you decide. The AI can&apos;t change anything
        by itself.
      </p>
      {reply.label === "dispute" ? (
        <p>
          <Link href={`/clients/${reply.clientId}`}>Open this client&apos;s evidence timeline</Link>
        </p>
      ) : null}
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      {splitting && offer ? <SplitForm reply={reply} offer={offer} busy={busy} act={act} /> : null}
      <div className="actions">
        {reply.suggestion.kind === "split" ? null : (
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => {
              void act({ action: "apply" });
            }}
          >
            {primaryLabel(reply.suggestion)}
          </button>
        )}
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            void act({ action: "resume" });
          }}
        >
          Resume reminders
        </button>
        {offer && !splitting ? (
          <button
            className="button button-secondary"
            type="button"
            onClick={() => {
              setSplitting(true);
            }}
          >
            Offer a split instead
          </button>
        ) : null}
      </div>
    </article>
  );
};
