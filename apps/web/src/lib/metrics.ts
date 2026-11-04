import { getUsualDaysLate } from "./account";
import type { Db } from "./db";
import { toCents } from "./db-values";
import { daysOverdue } from "./schedule";

// Server-only: the recovery metrics from the spec's Success metrics table. Amounts come from the
// database only, with one total per currency, never converted. Read as the signed-in user, so
// row-level security applies. `computeMetrics` is pure.

export type MetricInvoice = {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  status: string;
  amountCents: number;
  amountPaidCents: number;
  currency: string;
  /** This invoice's own due date. */
  dueDate: string;
  /** Its due date, or that of the overdue invoice it replaced when a client asked to split. */
  firstDueDate: string;
  paidAt: Date | null;
  firstReminderAt: Date | null;
  timeZone: string;
};

export type InvoiceLine = {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  currency: string;
  days: number;
};

export type Metrics = {
  recovered: { currency: string; cents: number }[];
  daysLate: (InvoiceLine & { amountCents: number })[];
  medianDaysLate: number | null;
  /** Overdue invoices paid within 30 days of the first reminder, of those that can be counted. */
  recovery: { paid: number; total: number };
  usualDaysLate: number | null;
  daysSaved: number | null;
  overdue: (InvoiceLine & { remainingCents: number })[];
};

const RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Money that's the freelancer's to keep: disputed money may still go back. */
const KEPT = new Set(["paid", "partially_paid", "refunded"]);
const OPEN = new Set(["sent", "partially_paid"]);
const COUNTED = new Set([...KEPT, ...OPEN, "disputed"]);

const median = (values: number[]): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  const lower = sorted[middle - 1];
  return sorted.length % 2 === 1 || lower === undefined ? upper : (lower + upper) / 2;
};

/** Late as of when it was paid, or as of now while it's unpaid. */
const wentOverdue = (invoice: MetricInvoice, now: Date): boolean =>
  daysOverdue(invoice.firstDueDate, invoice.paidAt ?? now, invoice.timeZone) > 0;

const lineOf = (invoice: MetricInvoice, days: number): InvoiceLine => ({
  id: invoice.id,
  invoiceNumber: invoice.invoiceNumber,
  clientId: invoice.clientId,
  clientName: invoice.clientName,
  currency: invoice.currency,
  days,
});

const totalsByCurrency = (invoices: MetricInvoice[]): Metrics["recovered"] => {
  const totals = new Map<string, number>();
  for (const { currency, amountPaidCents } of invoices) {
    totals.set(currency, (totals.get(currency) ?? 0) + amountPaidCents);
  }
  return [...totals]
    .filter(([, cents]) => cents > 0)
    .map(([currency, cents]) => ({ currency, cents }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
};

const countRecovery = (invoices: MetricInvoice[], now: Date): Metrics["recovery"] => {
  const counts = { paid: 0, total: 0 };
  for (const { firstReminderAt, paidAt } of invoices) {
    if (!firstReminderAt) continue;
    const closes = firstReminderAt.getTime() + RECOVERY_WINDOW_MS;
    if (paidAt && paidAt.getTime() <= closes) {
      counts.paid += 1;
      counts.total += 1;
    } else if (paidAt || now.getTime() > closes) {
      counts.total += 1;
    }
  }
  return counts;
};

export const computeMetrics = (
  rows: MetricInvoice[],
  { now, usualDaysLate }: { now: Date; usualDaysLate: number | null },
): Metrics => {
  const counted = rows.filter((row) => COUNTED.has(row.status));
  const late = counted.filter((row) => wentOverdue(row, now));
  const daysLate = late
    .filter((row) => row.paidAt !== null && row.status !== "disputed")
    .sort((a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0))
    .map((row) => ({
      ...lineOf(row, daysOverdue(row.firstDueDate, row.paidAt ?? now, row.timeZone)),
      amountCents: row.amountPaidCents,
    }));
  const medianDaysLate = median(daysLate.map((line) => line.days));
  const overdue = counted
    .filter((row) => OPEN.has(row.status) && daysOverdue(row.dueDate, now, row.timeZone) > 0)
    .map((row) => ({
      ...lineOf(row, daysOverdue(row.dueDate, now, row.timeZone)),
      remainingCents: row.amountCents - row.amountPaidCents,
    }))
    .sort((a, b) => b.days - a.days);
  return {
    recovered: totalsByCurrency(late.filter((row) => KEPT.has(row.status))),
    daysLate,
    medianDaysLate,
    recovery: countRecovery(late, now),
    usualDaysLate,
    daysSaved:
      usualDaysLate === null || medianDaysLate === null
        ? null
        : Math.max(0, usualDaysLate - medianDaysLate),
    overdue,
  };
};

type MetricRow = {
  id: string;
  invoice_number: string;
  client_id: string;
  client_name: string;
  status: string;
  amount_cents: unknown;
  amount_paid_cents: unknown;
  currency: string;
  due_date: string;
  first_due_date: string;
  paid_at: Date | string | null;
  first_reminder_at: Date | string | null;
  time_zone: string;
};

/** A split on a client's request cancels the invoice it replaces: that one's dates carry over. */
const METRIC_ROWS = `
  SELECT i.id::text, i.invoice_number, c.id::text AS client_id, c.name AS client_name, i.status,
    i.amount_cents::text, i.amount_paid_cents::text, i.currency, i.due_date::text,
    least(i.due_date, replaced.due_date)::text AS first_due_date, i.paid_at,
    (SELECT min(r.sent_at) FROM public.reminders r
     WHERE r.invoice_id = i.id
       OR r.invoice_id IN (
         SELECT o.id FROM public.invoices o
         WHERE ip.id IS NOT NULL AND o.milestone_id = i.milestone_id AND o.status = 'cancelled'))
      AS first_reminder_at,
    c.time_zone
  FROM public.invoices i
  LEFT JOIN public.milestones m ON m.id = i.milestone_id
  LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
  LEFT JOIN public.projects p ON p.id = m.project_id
  JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
  LEFT JOIN public.installment_plans ip
    ON ip.id = i.installment_plan_id AND ip.created_from = 'client_request'
  LEFT JOIN LATERAL (
    SELECT min(o.due_date) AS due_date FROM public.invoices o
    WHERE ip.id IS NOT NULL AND o.milestone_id = i.milestone_id AND o.status = 'cancelled'
  ) replaced ON true
  WHERE i.due_date IS NOT NULL AND i.status <> 'cancelled' AND i.status <> 'draft'`;

const toInvoice = (row: MetricRow): MetricInvoice => ({
  id: row.id,
  invoiceNumber: row.invoice_number,
  clientId: row.client_id,
  clientName: row.client_name,
  status: row.status,
  amountCents: toCents(row.amount_cents),
  amountPaidCents: toCents(row.amount_paid_cents),
  currency: row.currency,
  dueDate: row.due_date,
  firstDueDate: row.first_due_date,
  paidAt: row.paid_at === null ? null : new Date(row.paid_at),
  firstReminderAt: row.first_reminder_at === null ? null : new Date(row.first_reminder_at),
  timeZone: row.time_zone,
});

export const loadMetrics = async (db: Db, now: Date): Promise<Metrics> => {
  const { rows } = await db.query<MetricRow>(METRIC_ROWS);
  return computeMetrics(rows.map(toInvoice), {
    now,
    usualDaysLate: await getUsualDaysLate(db),
  });
};
