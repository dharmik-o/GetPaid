"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  InvoiceDocumentFields,
  type DocumentFields,
  type TemplateChoice,
} from "@/components/InvoiceDocumentFields";
import {
  IncludeSignature,
  NO_SIGNATURE,
  startsTicked,
  type SignatureChoice,
} from "@/components/IncludeSignature";
import { InstallmentEditor } from "@/components/InstallmentEditor";
import { PaidBadge, PaidMoment } from "@/components/PaidMoment";
import { StatusBadge } from "@/components/StatusBadge";
import { sendJson } from "@/lib/api-client";
import { parseAmount } from "@/lib/currencies";
import { formatDay, formatMoney } from "@/lib/format";
import type { InstallmentItem } from "@/lib/installments";
import { statusLabel, type MilestoneStatus } from "@/lib/milestone-status";
import { invoiceStampId } from "@/lib/paid-stamps";

// The project's invoices: one PayPal invoice per milestone, or one per installment, each with
// its pay link. Creating one makes the PayPal invoice and its link; PayPal emails nobody. The
// client only hears about it in a reminder the freelancer approves. No PayPal partial payments:
// paying in parts means installments.

export type InvoiceRowInvoice = {
  id: string;
  invoiceNumber: string;
  status: string;
  amountCents: number;
  amountPaidCents: number;
  dueDate: string;
  link: string | null;
  installment: { number: number; count: number } | null;
  includeSignature?: boolean;
};

export type InvoiceRowData = {
  milestoneId: string;
  name: string;
  cents: number;
  paymentMode: "pay_on_invoice" | "deposit" | "hold";
  status: MilestoneStatus;
  /** The milestone's deadline (ISO date), for "Add to calendar". */
  deadline?: string;
  /** The open invoices (one, or one per installment), else the latest cancelled one. */
  invoices: InvoiceRowInvoice[];
  plan: { createdFrom: "setup" | "deposit" | "client_request"; items: InstallmentItem[] } | null;
};

type Props = {
  currency: string;
  today: string;
  rows: InvoiceRowData[];
  /** For the invoice document's template pick. */
  templates?: TemplateChoice[];
  signature?: SignatureChoice;
};

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
  depositCents: "Deposit",
  installment: "Installment",
  items: "Installments",
  paymentTerms: "Payment terms",
  status: "Status",
  paymentMode: "Payment mode",
  templateId: "Template",
  "text.greeting": "Greeting",
  "text.thank_you_note": "Thank-you note",
  "text.project_summary": "Project summary",
  "text.notes": "Notes",
};

const NO_DOCUMENT_CHOICE: DocumentFields = { templateId: "", text: null };

const openInvoices = (row: InvoiceRowData) => row.invoices.filter((i) => i.status !== "cancelled");

/** Why a milestone can't be invoiced yet, or undefined when it can. */
const blockedReason = (row: InvoiceRowData): string | undefined => {
  if (row.paymentMode === "hold") return "Paid by a hold, not an invoice: see Milestone holds.";
  if (!["planned", "in_progress", "delivered", "accepted"].includes(row.status)) {
    return `${statusLabel(row.status)}: no new invoice needed.`;
  }
  if (row.paymentMode === "pay_on_invoice" && !["delivered", "accepted"].includes(row.status)) {
    return "Mark it Delivered to invoice it.";
  }
  return undefined;
};

/** A deposit plan's next installment that has no invoice yet (the rest, on delivery). */
const nextDepositInstallment = (row: InvoiceRowData) => {
  if (row.plan?.createdFrom !== "deposit") return undefined;
  const open = openInvoices(row);
  if (open.length === 0) return undefined;
  const number = open.length + 1;
  const item = row.plan.items[number - 1];
  return item ? { number, amountCents: item.amountCents } : undefined;
};

const InvoiceLine = ({ invoice, currency }: { invoice: InvoiceRowInvoice; currency: string }) => (
  <PaidMoment
    stampId={invoiceStampId(invoice.invoiceNumber)}
    announcement={`${invoice.invoiceNumber} paid`}
    paid={invoice.status === "paid"}
  >
    {invoice.status === "paid" ? (
      <PaidBadge />
    ) : (
      <StatusBadge status={invoice.status}>
        {INVOICE_LABELS[invoice.status] ?? invoice.status}
      </StatusBadge>
    )}{" "}
    {invoice.invoiceNumber}
    {invoice.installment ? (
      <div className="field-hint">
        Installment {invoice.installment.number} of {invoice.installment.count}:{" "}
        {formatMoney(invoice.amountCents, currency)}
      </div>
    ) : null}
    <div className="field-hint">Due {formatDay(invoice.dueDate)} (client&apos;s date)</div>
    {invoice.link && invoice.status !== "cancelled" ? (
      <div>
        <a href={invoice.link} target="_blank" rel="noreferrer">
          PayPal pay link
        </a>
        {" · "}
        <a href={`/api/invoices/${invoice.id}/pdf`}>Invoice PDF</a>
      </div>
    ) : null}
  </PaidMoment>
);

export const InvoicePanel = ({
  currency,
  today,
  rows,
  templates = [],
  signature = NO_SIGNATURE,
}: Props) => {
  const router = useRouter();
  const [deposits, setDeposits] = useState<Record<string, string>>({});
  const [documents, setDocuments] = useState<Record<string, DocumentFields>>({});
  const documentOf = (milestoneId: string) => documents[milestoneId] ?? NO_DOCUMENT_CHOICE;
  const [signatures, setSignatures] = useState<Record<string, boolean>>({});
  /** The rest of a deposit starts from what the deposit's invoice chose. */
  const includesSignature = (row: InvoiceRowData): boolean =>
    signatures[row.milestoneId] ??
    openInvoices(row)[0]?.includeSignature ??
    startsTicked(signature);
  const signatureField = (row: InvoiceRowData) => (
    <IncludeSignature
      available={signature.available}
      checked={includesSignature(row)}
      onChange={(checked) => {
        setSignatures((current) => ({ ...current, [row.milestoneId]: checked }));
      }}
    />
  );
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<{ text: string; error: boolean }>();

  const call = async (key: string, url: string, body: unknown, done: string) => {
    setBusy(key);
    setMessage(undefined);
    const result = await sendJson(url, "POST", body, FIELD_NAMES);
    setBusy(undefined);
    if (!result.ok) {
      setMessage({ text: result.message, error: true });
      return;
    }
    setMessage({ text: done, error: false });
    router.refresh();
  };

  const create = (row: InvoiceRowData) => {
    const document = documentOf(row.milestoneId);
    let body: {
      depositCents?: number;
      templateId?: string;
      text?: DocumentFields["text"];
      includeSignature: boolean;
    } = {
      includeSignature: includesSignature(row),
      ...(document.templateId ? { templateId: document.templateId } : {}),
      ...(document.text ? { text: document.text } : {}),
    };
    if (row.paymentMode === "deposit") {
      const deposit = parseAmount(deposits[row.milestoneId] ?? "", currency);
      if (!deposit.ok) {
        setMessage({ text: `Deposit ${deposit.message}`, error: true });
        return;
      }
      body = { ...body, depositCents: deposit.minor };
    }
    const what = row.plan ? "Installment invoices" : "Invoice";
    void call(
      row.milestoneId,
      `/api/milestones/${row.milestoneId}/invoice`,
      body,
      `${what} created for ${row.name}. Each PayPal link goes into its reminders.`,
    );
  };

  const invoiceRest = (row: InvoiceRowData, number: number) => {
    void call(
      row.milestoneId,
      `/api/milestones/${row.milestoneId}/invoice`,
      { installment: number, includeSignature: includesSignature(row) },
      `Installment ${String(number)} created for ${row.name}.`,
    );
  };

  const cancel = (row: InvoiceRowData, invoice: InvoiceRowInvoice) => {
    const what = invoice.installment
      ? `the installment plan for ${row.name} (every unpaid installment)`
      : `invoice ${invoice.invoiceNumber} for ${row.name}`;
    if (!window.confirm(`Cancel ${what}? The client won't be able to pay it.`)) return;
    void call(
      row.milestoneId,
      `/api/invoices/${invoice.id}/cancel`,
      {},
      `Cancelled ${invoice.installment ? "the installment plan" : "the invoice"} for ${row.name}.`,
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

  const actions = (row: InvoiceRowData) => {
    const open = openInvoices(row);
    const first = open[0];
    const next = nextDepositInstallment(row);
    if (first) {
      const unpaid = open.every((i) => ["draft", "sent"].includes(i.status));
      return (
        <>
          {next ? signatureField(row) : null}
          {next ? (
            <button
              type="button"
              className="button"
              disabled={busy !== undefined}
              onClick={() => {
                invoiceRest(row, next.number);
              }}
            >
              Work delivered: invoice the rest ({formatMoney(next.amountCents, currency)})
            </button>
          ) : null}
          {unpaid ? (
            <button
              type="button"
              className="button button-danger"
              disabled={busy !== undefined}
              onClick={() => {
                cancel(row, first);
              }}
            >
              {busy === row.milestoneId
                ? "Working…"
                : first.installment
                  ? "Cancel installment plan"
                  : "Cancel invoice"}
            </button>
          ) : null}
        </>
      );
    }
    const blocked = blockedReason(row);
    const setupPlan = row.paymentMode === "pay_on_invoice" && row.plan?.createdFrom === "setup";
    return (
      <div>
        {row.paymentMode === "pay_on_invoice" ? (
          <InstallmentEditor
            milestoneId={row.milestoneId}
            name={row.name}
            cents={row.cents}
            currency={currency}
            saved={setupPlan ? (row.plan?.items ?? null) : null}
            today={today}
          />
        ) : null}
        {blocked ? <span className="muted">{blocked}</span> : null}
        {!blocked && row.paymentMode === "deposit" ? (
          <label className="field-hint">
            Deposit due at kickoff ({currency}). The whole amount makes one invoice; less makes it
            installment 1, with the rest invoiced when the work is delivered.
            <input
              inputMode="decimal"
              value={deposits[row.milestoneId] ?? ""}
              onChange={(e) => {
                setDeposits((current) => ({ ...current, [row.milestoneId]: e.target.value }));
              }}
            />
          </label>
        ) : null}
        {!blocked ? (
          <InvoiceDocumentFields
            milestoneId={row.milestoneId}
            templates={templates}
            value={documentOf(row.milestoneId)}
            onChange={(value) => {
              setDocuments((current) => ({ ...current, [row.milestoneId]: value }));
            }}
          />
        ) : null}
        {!blocked ? signatureField(row) : null}
        {!blocked ? (
          <button
            type="button"
            className="button"
            disabled={busy !== undefined}
            onClick={() => {
              create(row);
            }}
          >
            {busy === row.milestoneId
              ? "Creating…"
              : setupPlan
                ? `Create ${String(row.plan?.items.length)} installment invoices`
                : row.paymentMode === "deposit"
                  ? "Create deposit invoice"
                  : "Create invoice"}
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <div>
      <table className="table milestone-table stack-wide">
        <thead>
          <tr>
            <th scope="col">Milestone</th>
            <th scope="col" className="money">
              Amount
            </th>
            <th scope="col">Invoices</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const paid = openInvoices(row).reduce((sum, i) => sum + i.amountPaidCents, 0);
            return (
              <tr key={row.milestoneId}>
                <td data-label="Milestone">
                  {row.name}
                  <div className="field-hint">{statusLabel(row.status)}</div>
                  {row.deadline ? (
                    <Link
                      className="field-hint"
                      href={`/calendar/new?${new URLSearchParams({ link: `milestone:${row.milestoneId}`, date: row.deadline, title: row.name }).toString()}`}
                    >
                      Add to calendar
                    </Link>
                  ) : null}
                </td>
                <td className="money" data-label="Amount">
                  {formatMoney(row.cents, currency)}
                  {paid > 0 ? (
                    <div className="field-hint">Paid {formatMoney(paid, currency)}</div>
                  ) : null}
                </td>
                <td data-label="Invoices">
                  {row.invoices.length > 0 ? (
                    row.invoices.map((invoice) => (
                      <InvoiceLine key={invoice.id} invoice={invoice} currency={currency} />
                    ))
                  ) : (
                    <span className="muted">No invoice yet</span>
                  )}
                </td>
                <td data-label="Action">{actions(row)}</td>
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
