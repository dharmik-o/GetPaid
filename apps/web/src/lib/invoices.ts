import type { InvoiceText } from "./ai-schemas";
import type { Db } from "./db";
import { toCents } from "./db-values";

// Server-only: invoice rows. Queries run as the signed-in user (RLS), so another user's
// invoice is simply not found. PayPal calls live in invoice-flow.ts, never inside a transaction.

export const INVOICE_STATUSES = [
  "draft",
  "sent",
  "partially_paid",
  "paid",
  "cancelled",
  "refunded",
  "disputed",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Which installment an invoice is ("2 of 3"); null for a plain invoice. */
export type InstallmentRef = { number: number; count: number };

/** What the dashboard and API show. No PayPal ids or request ids. */
export type InvoiceView = {
  id: string;
  milestoneId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  amountCents: number;
  amountPaidCents: number;
  currency: string;
  dueDate: string;
  /** The PayPal page where the client pays; set once the invoice is sent. */
  link: string | null;
  installment: InstallmentRef | null;
};

/** The row as the invoice flow needs it, including PayPal ids. Server-only. */
export type InvoiceRecord = InvoiceView & {
  paypalInvoiceId: string | null;
  paypalRequestId: string;
  milestoneStatusBefore: string | null;
  installmentPlanId: string | null;
};

type InvoiceRow = {
  id: string;
  milestone_id: string;
  invoice_number: string;
  status: InvoiceStatus;
  amount_cents: unknown;
  amount_paid_cents: unknown;
  currency: string;
  due_date: string;
  link: string | null;
  paypal_invoice_id: string | null;
  paypal_request_id: string;
  milestone_status_before: string | null;
  installment_number: number | null;
  installment_count: number | null;
  installment_plan_id: string | null;
};

const SELECT_INVOICES = `
  SELECT i.id::text, i.milestone_id::text, i.invoice_number, i.status, i.amount_cents::text,
    i.amount_paid_cents::text, i.currency, i.due_date::text, i.link,
    i.paypal_invoice_id, i.paypal_request_id::text, i.milestone_status_before,
    i.installment_number, i.installment_count, i.installment_plan_id::text
  FROM public.invoices i`;

const toRecord = (row: InvoiceRow): InvoiceRecord => ({
  id: row.id,
  milestoneId: row.milestone_id,
  invoiceNumber: row.invoice_number,
  status: row.status,
  amountCents: toCents(row.amount_cents),
  amountPaidCents: toCents(row.amount_paid_cents),
  currency: row.currency,
  dueDate: row.due_date,
  link: row.link,
  installment:
    row.installment_number === null || row.installment_count === null
      ? null
      : { number: row.installment_number, count: row.installment_count },
  paypalInvoiceId: row.paypal_invoice_id,
  paypalRequestId: row.paypal_request_id,
  milestoneStatusBefore: row.milestone_status_before,
  installmentPlanId: row.installment_plan_id,
});

export const toView = (record: InvoiceRecord): InvoiceView => ({
  id: record.id,
  milestoneId: record.milestoneId,
  invoiceNumber: record.invoiceNumber,
  status: record.status,
  amountCents: record.amountCents,
  amountPaidCents: record.amountPaidCents,
  currency: record.currency,
  dueDate: record.dueDate,
  link: record.link,
  installment: record.installment,
});

export const getInvoiceRecord = async (db: Db, id: string): Promise<InvoiceRecord | undefined> => {
  const { rows } = await db.query<InvoiceRow>(`${SELECT_INVOICES} WHERE i.id = $1`, [id]);
  return rows[0] ? toRecord(rows[0]) : undefined;
};

/** The milestone's open (not cancelled) invoices, plain or installments, in installment order. */
export const listOpenInvoices = async (db: Db, milestoneId: string): Promise<InvoiceRecord[]> => {
  const { rows } = await db.query<InvoiceRow>(
    `${SELECT_INVOICES} WHERE i.milestone_id = $1 AND i.status <> 'cancelled'
     ORDER BY coalesce(i.installment_number, 0)`,
    [milestoneId],
  );
  return rows.map(toRecord);
};

/** The open invoice for one installment number (null = the plain invoice); at most one. */
export const findOpenInvoice = async (
  db: Db,
  milestoneId: string,
  installmentNumber: number | null,
): Promise<InvoiceRecord | undefined> =>
  (await listOpenInvoices(db, milestoneId)).find(
    (record) => (record.installment?.number ?? null) === installmentNumber,
  );

/**
 * Each milestone's current invoices: the open ones (one, or one per installment), else the
 * latest cancelled one, so the dashboard can say it was cancelled.
 */
export const listInvoicesForProject = async (db: Db, projectId: string): Promise<InvoiceView[]> => {
  const { rows } = await db.query<InvoiceRow>(
    `${SELECT_INVOICES}
     JOIN public.milestones m ON m.id = i.milestone_id
     WHERE m.project_id = $1
     ORDER BY i.milestone_id, coalesce(i.installment_number, 0), i.created_at DESC`,
    [projectId],
  );
  const views = rows.map((row) => toView(toRecord(row)));
  const hasOpen = new Set(views.filter((v) => v.status !== "cancelled").map((v) => v.milestoneId));
  const shownCancelled = new Set<string>();
  return views.filter((view) => {
    if (view.status !== "cancelled") return true;
    if (hasOpen.has(view.milestoneId) || shownCancelled.has(view.milestoneId)) return false;
    shownCancelled.add(view.milestoneId);
    return true;
  });
};

export type NewInvoice = {
  milestoneId: string;
  amountCents: number;
  currency: string;
  dueDate: string;
  /** The milestone's status before its first invoice; null once it's already invoiced. */
  milestoneStatusBefore: string | null;
  installment: (InstallmentRef & { planId: string }) | null;
  /** The invoice document's template (lib/invoice-templates.ts resolves the default). */
  templateId?: string | null;
  /** The document's text tags, as approved by the freelancer. */
  invoiceText?: InvoiceText | null;
};

/**
 * Saves the draft row, with its request id and invoice number, before PayPal is called. If two
 * requests race, the one-open-invoice-per-installment index keeps one and both get it back.
 */
export const insertDraftInvoice = async (db: Db, invoice: NewInvoice): Promise<InvoiceRecord> => {
  await db.query(
    `INSERT INTO public.invoices (user_id, milestone_id, amount_cents, currency, due_date,
       milestone_status_before, installment_number, installment_count, installment_plan_id,
       template_id, invoice_text)
     VALUES ((SELECT auth.uid()), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (milestone_id, (coalesce(installment_number, 0))) WHERE status <> 'cancelled'
     DO NOTHING`,
    [
      invoice.milestoneId,
      invoice.amountCents,
      invoice.currency,
      invoice.dueDate,
      invoice.milestoneStatusBefore,
      invoice.installment?.number ?? null,
      invoice.installment?.count ?? null,
      invoice.installment?.planId ?? null,
      invoice.templateId ?? null,
      invoice.invoiceText ? JSON.stringify(invoice.invoiceText) : null,
    ],
  );
  const saved = await findOpenInvoice(db, invoice.milestoneId, invoice.installment?.number ?? null);
  if (!saved) throw new Error("The new invoice could not be read back after saving.");
  return saved;
};

export const recordPaypalId = async (
  db: Db,
  id: string,
  paypalInvoiceId: string,
): Promise<void> => {
  await db.query(
    "UPDATE public.invoices SET paypal_invoice_id = $2 WHERE id = $1 AND paypal_invoice_id IS NULL",
    [id, paypalInvoiceId],
  );
};

const logEventRow = async (
  db: Db,
  invoiceId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> => {
  await db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ((SELECT auth.uid()), 'invoice', $1, $2, $3)`,
    [invoiceId, type, JSON.stringify(payload)],
  );
};

/** Draft → sent, with the pay link; the milestone becomes Invoiced. Repeats change nothing. */
export const markSent = async (db: Db, record: InvoiceRecord, link: string): Promise<void> => {
  const updated = await db.query(
    "UPDATE public.invoices SET status = 'sent', link = $2 WHERE id = $1 AND status = 'draft'",
    [record.id, link],
  );
  if (updated.rowCount === 0) return;
  await db.query(
    `UPDATE public.milestones SET status = 'invoiced'
     WHERE id = $1 AND status IN ('planned', 'in_progress', 'delivered', 'accepted')`,
    [record.milestoneId],
  );
  await logEventRow(db, record.id, "invoice.sent", {
    invoiceNumber: record.invoiceNumber,
    amountCents: record.amountCents,
    currency: record.currency,
    installment: record.installment,
  });
};

/**
 * Cancelled: once the milestone has no open invoice left, it goes back to `restoreTo` (its
 * status before invoicing). Reminders still waiting for approval are skipped, so nothing about
 * this invoice can be sent.
 */
export const markCancelled = async (
  db: Db,
  record: InvoiceRecord,
  restoreTo: string,
): Promise<void> => {
  const updated = await db.query(
    "UPDATE public.invoices SET status = 'cancelled' WHERE id = $1 AND status IN ('draft', 'sent')",
    [record.id],
  );
  if (updated.rowCount === 0) return;
  await db.query(
    `UPDATE public.milestones SET status = $2
     WHERE id = $1 AND status IN ('invoiced', 'overdue')
       AND NOT EXISTS (SELECT 1 FROM public.invoices i
                       WHERE i.milestone_id = $1 AND i.status <> 'cancelled')`,
    [record.milestoneId, restoreTo],
  );
  await db.query(
    `UPDATE public.reminders SET approval_status = 'skipped'
     WHERE invoice_id = $1 AND approval_status = 'waiting'`,
    [record.id],
  );
  await logEventRow(db, record.id, "invoice.cancelled", { invoiceNumber: record.invoiceNumber });
};
