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
import { CancelInvoice } from "@/components/CancelInvoice";
import { CopyButton } from "@/components/CopyButton";
import { Icon } from "@/components/Icon";
import { InstallmentEditor } from "@/components/InstallmentEditor";
import { PaidBadge, PaidMoment } from "@/components/PaidMoment";
import { RecordPayment } from "@/components/RecordPayment";
import { StatusBadge } from "@/components/StatusBadge";
import { stampFor, StatusStamp } from "@/components/StatusStamp";
import { sendJson } from "@/lib/api-client";
import { parseAmount } from "@/lib/currencies";
import { formatDay, formatMoney } from "@/lib/format";
import type { InstallmentItem } from "@/lib/installments";
import { statusLabel, type MilestoneStatus } from "@/lib/milestone-status";
import { RECORDABLE_STATUSES } from "@/lib/invoice-closing";
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
  /** When the next reminder for this milestone goes, in both zones; null when none is planned. */
  nextReminder?: string | null;
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

const DAY_MS = 86_400_000;

/** Whole days from one ISO date to a later one (both calendar dates, so no time zone applies). */
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

const percentOf = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.min(100, Math.round((part / whole) * 100));

const Progress = ({ percent, label }: { percent: number; label: string }) => (
  <div
    className="progress"
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={percent}
  >
    <span style={{ width: `${String(percent)}%` }} />
  </div>
);

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
      <div className="invoice-links">
        <a className="link-button" href={invoice.link} target="_blank" rel="noreferrer">
          <Icon name="external" size={16} />
          PayPal pay link
        </a>
        <a className="link-button button-inverted" href={`/api/invoices/${invoice.id}/pdf`}>
          <Icon name="file" size={16} />
          Invoice PDF
        </a>
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
          {open
            .filter((i) => RECORDABLE_STATUSES.includes(i.status))
            .map((i) => (
              <RecordPayment
                key={i.id}
                label={
                  i.installment
                    ? `Record a payment: installment ${String(i.installment.number)}`
                    : "Record a payment"
                }
                invoice={{
                  invoiceId: i.id,
                  invoiceNumber: i.invoiceNumber,
                  currency,
                  owedCents: i.amountCents - i.amountPaidCents,
                }}
              />
            ))}
          {unpaid ? (
            <CancelInvoice
              invoiceId={first.id}
              what={
                first.installment
                  ? `the installment plan for ${row.name} (every unpaid installment)`
                  : `invoice ${first.invoiceNumber} for ${row.name}`
              }
              label={first.installment ? "Cancel installment plan" : "Cancel invoice"}
            />
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

  const sum = (pick: (invoice: InvoiceRowInvoice) => number): number =>
    rows.reduce((total, row) => total + openInvoices(row).reduce((t, i) => t + pick(i), 0), 0);
  const invoiced = sum((i) => i.amountCents);
  const paidTotal = sum((i) => i.amountPaidCents);

  return (
    <div>
      <div className="summary-strip" aria-label="Project totals">
        <div>
          <p className="meta-label">Invoiced</p>
          <p className="strip-amount">{formatMoney(invoiced, currency)}</p>
        </div>
        <div>
          <p className="meta-label">Paid</p>
          <p className="strip-amount">{formatMoney(paidTotal, currency)}</p>
        </div>
        <div>
          <p className="meta-label">Outstanding</p>
          <p className="strip-amount">{formatMoney(Math.max(0, invoiced - paidTotal), currency)}</p>
        </div>
        <Progress percent={percentOf(paidTotal, invoiced)} label="Paid of invoiced" />
      </div>
      <div className="milestone-grid">
        {rows.map((row) => {
          const open = openInvoices(row);
          const first = open[0];
          const paid = open.reduce((sum2, i) => sum2 + i.amountPaidCents, 0);
          // Overdue isn't stored: it's an unpaid invoice past its date, as in the invoice log.
          const lateInvoice = open.find(
            (i) => ["sent", "partially_paid"].includes(i.status) && i.dueDate < today,
          );
          const late = lateInvoice ? daysBetween(lateInvoice.dueDate, today) : 0;
          const shown = late > 0 ? "overdue" : row.status;
          const stamp = stampFor(shown);
          return (
            <article
              className="ms-card"
              key={row.milestoneId}
              aria-label={row.name}
              data-tour="milestone-card"
            >
              {stamp ? (
                <span className="ms-stamp">
                  <StatusStamp kind={stamp} />
                </span>
              ) : null}
              <h3 className="ms-name">{row.name}</h3>
              <p className="ms-terms muted">
                {first
                  ? `${first.invoiceNumber} · due ${formatDay(first.dueDate)}`
                  : "No invoice yet"}
              </p>
              <p className="ms-amount">{formatMoney(row.cents, currency)}</p>
              <p className="ms-status">
                <StatusBadge status={shown}>
                  {late > 0 ? `Overdue ${String(late)}d` : statusLabel(row.status)}
                </StatusBadge>
              </p>
              {open.length > 0 ? (
                <>
                  <Progress
                    percent={percentOf(paid, row.cents)}
                    label={`${row.name}: paid of ${formatMoney(row.cents, currency)}`}
                  />
                  <p className="field-hint">
                    Paid {formatMoney(paid, currency)} of {formatMoney(row.cents, currency)}
                  </p>
                </>
              ) : null}
              {row.nextReminder ? (
                <p className="field-hint">Next reminder: {row.nextReminder}</p>
              ) : null}
              {row.deadline ? (
                <Link
                  className="field-hint"
                  href={`/calendar/new?${new URLSearchParams({ link: `milestone:${row.milestoneId}`, date: row.deadline, title: row.name }).toString()}`}
                >
                  Add to calendar
                </Link>
              ) : null}
              <div className="ms-invoices">
                {row.invoices.length > 0 ? (
                  row.invoices.map((invoice) => (
                    <InvoiceLine key={invoice.id} invoice={invoice} currency={currency} />
                  ))
                ) : (
                  <span className="muted">No invoice yet</span>
                )}
                {first?.link && first.status !== "cancelled" ? (
                  <CopyButton value={first.link} label={`Copy the pay link for ${row.name}`} />
                ) : null}
              </div>
              <div className="ms-actions">{actions(row)}</div>
            </article>
          );
        })}
      </div>
      {message ? (
        <div className={message.error ? "banner banner-error" : "banner"} role="status">
          {message.text}
        </div>
      ) : null}
    </div>
  );
};
