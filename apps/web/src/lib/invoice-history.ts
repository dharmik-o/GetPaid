import { z } from "zod";
import type { Db } from "./db";
import { toCents } from "./db-values";
import { formatFullDay } from "./format";
import { RECORDABLE_STATUSES } from "./invoice-closing";
import { todayIn } from "./schedule";

// Server-only: every invoice of a project or client, with each saved version. Read as the signed-in
// user (RLS), so another user's invoices simply aren't there. Amounts are as stored, and totals keep
// each currency apart: nothing is ever converted.

export type DisplayStatus =
  "draft" | "sent" | "overdue" | "partially_paid" | "paid" | "cancelled" | "refunded" | "disputed";

export const STATUS_LABELS: Readonly<Record<DisplayStatus, string>> = {
  draft: "Draft",
  sent: "Sent",
  overdue: "Overdue",
  partially_paid: "Partially paid",
  paid: "Paid",
  cancelled: "Cancelled",
  refunded: "Refunded",
  disputed: "Disputed",
};

const DISPLAY_STATUSES = Object.keys(STATUS_LABELS) as DisplayStatus[];

export type ArchivedVersion = {
  version: number;
  sentAt: string | null;
  templateName: string | null;
  signed: boolean;
};

export type HistoryInvoice = {
  id: string;
  number: string;
  /** What it's for: a milestone, an installment, a retainer cycle or maintenance. */
  purpose: string;
  status: DisplayStatus;
  amountCents: number;
  amountPaidCents: number;
  currency: string;
  /** The PayPal page where the client pays. */
  link: string | null;
  projectId: string | null;
  projectTitle: string | null;
  /** When it first went to the client, if it has. */
  sentAt: string | null;
  /** The day to filter by, in the client's zone: when it was sent, or else created. */
  day: string;
  templateName: string | null;
  signed: boolean;
  /** Newest first. Empty until a PDF has been saved. */
  versions: ArchivedVersion[];
  /** How it was last paid when the freelancer recorded it by hand (a method key); else null. */
  paymentMethod: string | null;
  /** Open, and one the freelancer can record a payment on (not a retainer cycle). */
  closable: boolean;
};

type Row = {
  id: string;
  invoice_number: string;
  status: string;
  amount_cents: unknown;
  amount_paid_cents: unknown;
  currency: string;
  due_date: string | null;
  link: string | null;
  created_at: Date | string;
  installment_number: number | null;
  installment_count: number | null;
  retainer_cycle_on: string | null;
  include_signature: boolean;
  milestone_name: string | null;
  retainer_name: string | null;
  maintenance_task: string | null;
  project_id: string | null;
  project_title: string | null;
  time_zone: string;
  template_name: string | null;
  first_sent_at: Date | string | null;
  versions: unknown;
  payment_method: string | null;
  is_milestone: boolean;
};

const versionsSchema = z.array(
  z.object({
    version: z.number(),
    sentAt: z.string().nullable(),
    templateName: z.string().nullable(),
    signed: z.boolean(),
  }),
);

/** Overdue isn't stored: it's an unpaid invoice past its date, in the client's zone. */
export const displayStatus = (
  status: string,
  dueDate: string | null,
  today: string,
): DisplayStatus => {
  const unpaid = status === "sent" || status === "partially_paid";
  if (unpaid && dueDate !== null && dueDate < today) return "overdue";
  return DISPLAY_STATUSES.find((known) => known === status) ?? "sent";
};

export const invoicePurpose = (row: {
  milestoneName: string | null;
  retainerName: string | null;
  maintenanceTask: string | null;
  installment: { number: number; count: number } | null;
  retainerCycleOn: string | null;
}): string => {
  if (row.retainerName) {
    return row.retainerCycleOn
      ? `Retainer: ${row.retainerName}, charge of ${formatFullDay(row.retainerCycleOn)}`
      : `Retainer: ${row.retainerName}`;
  }
  const name = row.maintenanceTask
    ? `Maintenance: ${row.maintenanceTask}`
    : (row.milestoneName ?? "Invoice");
  return row.installment
    ? `${name}, installment ${String(row.installment.number)} of ${String(row.installment.count)}`
    : name;
};

const SELECT_HISTORY = `
  SELECT i.id::text, i.invoice_number, i.status, i.amount_cents::text, i.amount_paid_cents::text,
    i.currency, i.due_date::text, i.link, i.created_at, i.installment_number, i.installment_count,
    i.retainer_cycle_on::text, i.include_signature, m.name AS milestone_name,
    rt.name AS retainer_name, p.id::text AS project_id, p.title AS project_title, c.time_zone,
    t.name AS template_name,
    (SELECT mt.task FROM public.maintenance_tasks mt
     WHERE mt.job_project_id = p.id ORDER BY mt.created_at LIMIT 1) AS maintenance_task,
    (SELECT min(r.sent_at) FROM public.reminders r WHERE r.invoice_id = i.id) AS first_sent_at,
    (SELECT coalesce(json_agg(json_build_object('version', f.version, 'sentAt', f.sent_at,
       'templateName', f.template_name, 'signed', f.signed) ORDER BY f.version DESC), '[]'::json)
     FROM public.invoice_archive_files f WHERE f.invoice_id = i.id) AS versions,
    (SELECT pay.method FROM public.invoice_payments pay WHERE pay.invoice_id = i.id
     ORDER BY pay.created_at DESC LIMIT 1) AS payment_method,
    (i.milestone_id IS NOT NULL) AS is_milestone
  FROM public.invoices i
  LEFT JOIN public.milestones m ON m.id = i.milestone_id
  LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
  LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id)
  JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
  LEFT JOIN public.invoice_templates t ON t.id = i.template_id`;

const ORDER = "ORDER BY i.created_at DESC, i.invoice_number DESC";

const toIso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const toInvoice = (row: Row, now: Date): HistoryInvoice => {
  const versions = versionsSchema.parse(
    typeof row.versions === "string" ? JSON.parse(row.versions) : row.versions,
  );
  const firstVersionSent = versions
    .map((file) => file.sentAt)
    .filter((sent): sent is string => sent !== null)
    .sort()[0];
  const sentAt = toIso(row.first_sent_at) ?? toIso(firstVersionSent ?? null);
  const status = displayStatus(row.status, row.due_date, todayIn(now, row.time_zone));
  return {
    id: row.id,
    number: row.invoice_number,
    purpose: invoicePurpose({
      milestoneName: row.milestone_name,
      retainerName: row.retainer_name,
      maintenanceTask: row.maintenance_task,
      installment:
        row.installment_number === null || row.installment_count === null
          ? null
          : { number: row.installment_number, count: row.installment_count },
      retainerCycleOn: row.retainer_cycle_on,
    }),
    status,
    amountCents: toCents(row.amount_cents),
    amountPaidCents: toCents(row.amount_paid_cents),
    currency: row.currency,
    link: row.link,
    projectId: row.project_id,
    projectTitle: row.project_title,
    sentAt,
    day: todayIn(new Date(sentAt ?? row.created_at), row.time_zone),
    templateName: row.template_name,
    signed: row.include_signature,
    versions,
    paymentMethod: row.payment_method,
    closable: row.is_milestone && RECORDABLE_STATUSES.includes(row.status),
  };
};

export const listProjectInvoices = async (
  db: Db,
  projectId: string,
  now: Date,
): Promise<HistoryInvoice[]> => {
  const { rows } = await db.query<Row>(`${SELECT_HISTORY} WHERE p.id = $1 ${ORDER}`, [projectId]);
  return rows.map((row) => toInvoice(row, now));
};

export const listClientInvoices = async (
  db: Db,
  clientId: string,
  now: Date,
): Promise<HistoryInvoice[]> => {
  const { rows } = await db.query<Row>(`${SELECT_HISTORY} WHERE c.id = $1 ${ORDER}`, [clientId]);
  return rows.map((row) => toInvoice(row, now));
};

export type HistoryFilters = {
  status: DisplayStatus | null;
  from: string | null;
  to: string | null;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const dayFrom = (value: unknown): string | null =>
  typeof value === "string" && DAY.test(value) ? value : null;

/** From the page's address, which anyone can edit: anything unusable just means no filter. */
export const parseHistoryFilters = (params: Record<string, unknown>): HistoryFilters => ({
  status: DISPLAY_STATUSES.find((status) => status === params.status) ?? null,
  from: dayFrom(params.from),
  to: dayFrom(params.to),
});

export const filterInvoices = (
  invoices: readonly HistoryInvoice[],
  { status, from, to }: HistoryFilters,
): HistoryInvoice[] =>
  invoices.filter(
    (invoice) =>
      (status === null || invoice.status === status) &&
      (from === null || invoice.day >= from) &&
      (to === null || invoice.day <= to),
  );

export type CurrencyTotal = { currency: string; sentCents: number; paidCents: number };

const NOT_SENT: readonly DisplayStatus[] = ["draft", "cancelled"];

/** What was sent and what was paid, per currency. Each invoice counts once, whatever its versions. */
export const totalsByCurrency = (invoices: readonly HistoryInvoice[]): CurrencyTotal[] => {
  const totals = new Map<string, CurrencyTotal>();
  for (const invoice of invoices) {
    const total = totals.get(invoice.currency) ?? {
      currency: invoice.currency,
      sentCents: 0,
      paidCents: 0,
    };
    if (!NOT_SENT.includes(invoice.status)) total.sentCents += invoice.amountCents;
    total.paidCents += invoice.amountPaidCents;
    totals.set(invoice.currency, total);
  }
  return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
};

export type HistoryGroup = {
  key: string;
  title: string;
  projectId: string | null;
  invoices: HistoryInvoice[];
};

/** Grouped by project, in the order they first appear. A retainer with no project has its own group. */
export const groupByProject = (invoices: readonly HistoryInvoice[]): HistoryGroup[] => {
  const groups = new Map<string, HistoryGroup>();
  for (const invoice of invoices) {
    const key = invoice.projectId ?? "none";
    const group = groups.get(key) ?? {
      key,
      title: invoice.projectTitle ?? "No project",
      projectId: invoice.projectId,
      invoices: [],
    };
    group.invoices.push(invoice);
    groups.set(key, group);
  }
  return [...groups.values()];
};
