"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseAmount } from "@/lib/currencies";
import { formatDay, formatMoney } from "@/lib/format";
import { statusLabel, type MilestoneStatus } from "@/lib/milestone-status";

// The project's invoices: one PayPal invoice per milestone, with its pay link. Creating one
// makes the PayPal invoice and its link; PayPal emails nobody. The client only hears about it
// in a reminder the freelancer approves.

export type InvoiceRowData = {
  milestoneId: string;
  name: string;
  cents: number;
  paymentMode: "pay_on_invoice" | "deposit" | "hold";
  status: MilestoneStatus;
  invoice: {
    id: string;
    invoiceNumber: string;
    status: string;
    amountPaidCents: number;
    minimumDueCents: number | null;
    dueDate: string;
    link: string | null;
  } | null;
};

type Props = { currency: string; rows: InvoiceRowData[] };

type ApiBody = { error?: string; errors?: { field: string; message: string }[] };

const INVOICE_LABELS: Record<string, string> = {
  draft: "Not sent yet",
  sent: "Sent",
  partially_paid: "Partially paid",
  paid: "Paid",
  cancelled: "Cancelled",
  refunded: "Refunded",
  disputed: "Disputed",
};

const FIELD_NAMES: Record<string, string> = {
  minimumDueCents: "Minimum first payment",
  paymentTerms: "Payment terms",
  status: "Status",
  paymentMode: "Payment mode",
};

const messageOf = (body: ApiBody): string => {
  const first = body.errors?.[0];
  if (first) return `${FIELD_NAMES[first.field] ?? first.field} ${first.message}`;
  return body.error ?? "That didn't work. Try again.";
};

const isOpen = (row: InvoiceRowData): boolean =>
  row.invoice !== null && row.invoice.status !== "cancelled";

/** Why a milestone can't be invoiced yet, or undefined when it can. */
const blockedReason = (row: InvoiceRowData): string | undefined => {
  if (row.paymentMode === "hold") return "Milestone holds are paid by authorization, not invoice.";
  if (!["planned", "in_progress", "delivered", "accepted"].includes(row.status)) {
    return `${statusLabel(row.status)}: no new invoice needed.`;
  }
  if (row.paymentMode === "pay_on_invoice" && !["delivered", "accepted"].includes(row.status)) {
    return "Mark it Delivered to invoice it.";
  }
  return undefined;
};

export const InvoicePanel = ({ currency, rows }: Props) => {
  const router = useRouter();
  const [minimums, setMinimums] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<{ text: string; error: boolean }>();

  const call = async (key: string, url: string, body: unknown, done: string) => {
    setBusy(key);
    setMessage(undefined);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as ApiBody;
      if (!response.ok) {
        setMessage({ text: messageOf(result), error: true });
        return;
      }
      setMessage({ text: done, error: false });
      router.refresh();
    } catch {
      setMessage({
        text: "That didn't reach the server. Check your connection and try again.",
        error: true,
      });
    } finally {
      setBusy(undefined);
    }
  };

  const create = (row: InvoiceRowData) => {
    let body: { minimumDueCents?: number } = {};
    if (row.paymentMode === "deposit") {
      const minimum = parseAmount(minimums[row.milestoneId] ?? "", currency);
      if (!minimum.ok) {
        setMessage({ text: `Minimum first payment ${minimum.message}`, error: true });
        return;
      }
      body = { minimumDueCents: minimum.minor };
    }
    void call(
      row.milestoneId,
      `/api/milestones/${row.milestoneId}/invoice`,
      body,
      `Invoice created for ${row.name}. Its PayPal link goes into every reminder.`,
    );
  };

  const cancel = (row: InvoiceRowData) => {
    if (!row.invoice) return;
    if (
      !window.confirm(
        `Cancel invoice ${row.invoice.invoiceNumber} for ${row.name}? The client won't be able to pay it.`,
      )
    ) {
      return;
    }
    void call(
      row.milestoneId,
      `/api/invoices/${row.invoice.id}/cancel`,
      {},
      `Invoice for ${row.name} cancelled.`,
    );
  };

  if (rows.length === 0) {
    return (
      <p className="empty">
        No milestones yet. Add a milestone plan above to invoice this project; for a single invoice,
        add one milestone at 100%.
      </p>
    );
  }

  return (
    <div>
      <table className="table milestone-table">
        <thead>
          <tr>
            <th scope="col">Milestone</th>
            <th scope="col" className="money">
              Amount
            </th>
            <th scope="col">Invoice</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const invoice = row.invoice;
            const blocked = blockedReason(row);
            return (
              <tr key={row.milestoneId}>
                <td>
                  {row.name}
                  <div className="field-hint">{statusLabel(row.status)}</div>
                </td>
                <td className="money">
                  {formatMoney(row.cents, currency)}
                  {invoice && invoice.amountPaidCents > 0 ? (
                    <div className="field-hint">
                      Paid {formatMoney(invoice.amountPaidCents, currency)}
                    </div>
                  ) : null}
                </td>
                <td>
                  {invoice ? (
                    <>
                      <span className="chip">
                        {INVOICE_LABELS[invoice.status] ?? invoice.status}
                      </span>
                      {invoice.invoiceNumber}
                      <div className="field-hint">
                        Due {formatDay(invoice.dueDate)} (client&apos;s date)
                      </div>
                      {invoice.minimumDueCents !== null ? (
                        <div className="field-hint">
                          Minimum first payment {formatMoney(invoice.minimumDueCents, currency)}
                        </div>
                      ) : null}
                      {invoice.link && invoice.status !== "cancelled" ? (
                        <div>
                          <a href={invoice.link} target="_blank" rel="noreferrer">
                            PayPal pay link
                          </a>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <span className="muted">No invoice yet</span>
                  )}
                </td>
                <td>
                  {isOpen(row) && invoice && ["draft", "sent"].includes(invoice.status) ? (
                    <button
                      type="button"
                      className="button button-danger"
                      disabled={busy !== undefined}
                      onClick={() => {
                        cancel(row);
                      }}
                    >
                      {busy === row.milestoneId ? "Cancelling…" : "Cancel invoice"}
                    </button>
                  ) : null}
                  {!isOpen(row) && blocked ? <span className="muted">{blocked}</span> : null}
                  {!isOpen(row) && !blocked ? (
                    <div>
                      {row.paymentMode === "deposit" ? (
                        <label className="field-hint">
                          Minimum first payment ({currency})
                          <input
                            inputMode="decimal"
                            value={minimums[row.milestoneId] ?? ""}
                            onChange={(e) => {
                              setMinimums((current) => ({
                                ...current,
                                [row.milestoneId]: e.target.value,
                              }));
                            }}
                          />
                        </label>
                      ) : null}
                      <button
                        type="button"
                        className="button"
                        disabled={busy !== undefined}
                        onClick={() => {
                          create(row);
                        }}
                      >
                        {busy === row.milestoneId ? "Creating…" : "Create invoice"}
                      </button>
                    </div>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {message ? (
        <div className={message.error ? "banner banner-error" : "banner"} role="status">
          {message.text}
        </div>
      ) : null}
    </div>
  );
};
