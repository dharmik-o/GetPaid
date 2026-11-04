import { z } from "zod";
import { isPaypalCurrency } from "./currencies";
import { isUuid, type Db } from "./db";
import { toCents } from "./db-values";
import { toFieldIssues, type FieldIssue } from "./field-issues";
import { alertText, type AlertKind } from "./retainer-alerts";
import { retainerCyclesBetween, todayIn, type RetainerDates } from "./schedule";

// Server-only: retainers as the signed-in freelancer sees them (RLS). PayPal ids, request ids and
// the approval link stay on the server: the link reaches the browser only inside its email draft.

export type RetainerMethod = "auto_pay" | "invoice";
export type RetainerStatus = "pending_approval" | "active" | "suspended" | "cancelled" | "ended";

export type RetainerInvoice = {
  id: string;
  number: string;
  cycleOn: string;
  status: string;
  amountCents: number;
  amountPaidCents: number;
  link: string | null;
  /** True when it covers an auto-pay charge that failed. */
  afterFailedCharge: boolean;
};

export type Retainer = {
  id: string;
  clientId: string;
  clientName: string;
  projectTitle: string | null;
  name: string;
  amountCents: number;
  currency: string;
  unit: "week" | "month";
  count: number;
  startsOn: string;
  endsOn: string | null;
  method: RetainerMethod;
  status: RetainerStatus;
  /** Auto-pay is paused in PayPal until the invoice for a failed charge is paid. */
  pausedForInvoice: boolean;
  /** Where the email asking the client to approve auto-pay stands. */
  approvalEmail: "none" | "waiting" | "scheduled" | "sent";
  /** Auto-pay is set up in PayPal. False means the setup needs another try. */
  setUp: boolean;
  nextChargeOn: string | null;
  invoices: RetainerInvoice[];
};

export type RetainerAlert = { id: string; retainerId: string; kind: AlertKind; text: string };

const MAX_MONTHS = 12;
const MAX_WEEKS = 52;

const createSchema = z
  .strictObject({
    clientId: z.string({ error: "must be one of your clients" }),
    projectId: z.string({ error: "must be one of this client's projects" }).nullable().optional(),
    name: z
      .string({ error: "is required" })
      .trim()
      .min(1, "is required")
      .max(120, "must be 120 characters or fewer"),
    amountCents: z
      .int("must be a whole number of minor units (cents)")
      .min(1, "must be more than 0")
      .max(Number.MAX_SAFE_INTEGER, "is too large"),
    currency: z
      .string({ error: "must be a currency PayPal supports" })
      .refine(isPaypalCurrency, "must be a currency PayPal supports"),
    unit: z.enum(["week", "month"], { error: "must be weeks or months" }),
    count: z.int("must be a whole number").min(1, "must be at least 1"),
    startsOn: z.iso.date({ error: "must be a date like 2026-12-31" }),
    endsOn: z.iso.date({ error: "must be a date like 2026-12-31" }).nullable().optional(),
    method: z.enum(["auto_pay", "invoice"], { error: "must be auto-pay or invoice each cycle" }),
  })
  .superRefine((value, ctx) => {
    const max = value.unit === "week" ? MAX_WEEKS : MAX_MONTHS;
    if (value.count > max) {
      ctx.addIssue({
        code: "custom",
        path: ["count"],
        message: `can be at most ${String(max)} ${value.unit}s, PayPal's limit`,
      });
    }
    if (value.endsOn && value.endsOn < value.startsOn) {
      ctx.addIssue({
        code: "custom",
        path: ["endsOn"],
        message: "must be on or after the start date",
      });
    }
  });

export type RetainerResult =
  { ok: true; id: string; method: RetainerMethod } | { ok: false; errors: FieldIssue[] };

const fail = (field: string, message: string): RetainerResult => ({
  ok: false,
  errors: [{ field, message }],
});

/** Checks and saves a new retainer. PayPal is called afterwards, outside this transaction. */
export const createRetainer = async (db: Db, raw: unknown, now: Date): Promise<RetainerResult> => {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
  }
  const input = parsed.data;
  if (!isUuid(input.clientId)) return fail("clientId", "must be one of your clients");
  const { rows: clients } = await db.query<{ time_zone: string }>(
    "SELECT time_zone FROM public.clients WHERE id = $1",
    [input.clientId],
  );
  const client = clients[0];
  if (!client) return fail("clientId", "must be one of your clients");
  // A past start would bill cycles nobody agreed to. PayPal refuses one for auto-pay too.
  if (input.startsOn < todayIn(now, client.time_zone)) {
    return fail("startsOn", "can't be in the past, in the client's time zone");
  }
  const projectId = input.projectId ?? null;
  if (projectId !== null) {
    const { rows: projects } = await db.query(
      "SELECT 1 FROM public.projects WHERE id = $1 AND client_id = $2",
      [isUuid(projectId) ? projectId : null, input.clientId],
    );
    if (projects.length === 0) return fail("projectId", "must be one of this client's projects");
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.retainers (user_id, client_id, project_id, name, amount_cents, currency,
       interval_unit, interval_count, starts_on, ends_on, method, status)
     VALUES ((SELECT auth.uid()), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id::text`,
    [
      input.clientId,
      projectId,
      input.name,
      input.amountCents,
      input.currency,
      input.unit,
      input.count,
      input.startsOn,
      input.endsOn ?? null,
      input.method,
      input.method === "auto_pay" ? "pending_approval" : "active",
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Saving the retainer returned no id.");
  await db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ((SELECT auth.uid()), 'retainer', $1, 'retainer.created', $2)`,
    [id, JSON.stringify({ method: input.method })],
  );
  return { ok: true, id, method: input.method };
};

type RetainerRow = {
  id: string;
  client_id: string;
  client_name: string;
  time_zone: string;
  project_title: string | null;
  name: string;
  amount_cents: string;
  currency: string;
  interval_unit: "week" | "month";
  interval_count: number;
  starts_on: string;
  ends_on: string | null;
  method: RetainerMethod;
  status: RetainerStatus;
  paypal_subscription_id: string | null;
  hold_cycle_on: string | null;
};

export const SELECT_RETAINERS = `
  SELECT r.id::text, r.client_id::text, c.name AS client_name, c.time_zone, p.title AS project_title,
    r.name, r.amount_cents::text, r.currency, r.interval_unit, r.interval_count, r.starts_on::text,
    r.ends_on::text, r.method, r.status, r.paypal_subscription_id,
    r.auto_pay_hold_cycle_on::text AS hold_cycle_on
  FROM public.retainers r
  JOIN public.clients c ON c.id = r.client_id
  LEFT JOIN public.projects p ON p.id = r.project_id`;

export const retainerDates = (row: {
  starts_on: string;
  ends_on: string | null;
  interval_unit: "week" | "month";
  interval_count: number;
}): RetainerDates => ({
  startsOn: row.starts_on,
  endsOn: row.ends_on,
  unit: row.interval_unit,
  count: row.interval_count,
});

/** Charges still to come only if nothing is stopping them. */
export const isCharging = (status: RetainerStatus): boolean => status === "active";

const LOOK_AHEAD_YEARS = 2;

const nextCharge = (row: RetainerRow, now: Date): string | null => {
  if (!isCharging(row.status)) return null;
  const today = todayIn(now, row.time_zone);
  const horizon = `${String(Number(today.slice(0, 4)) + LOOK_AHEAD_YEARS)}${today.slice(4)}`;
  const upcoming = retainerCyclesBetween(retainerDates(row), today, horizon);
  return upcoming.find((date) => date > today) ?? null;
};

const INVOICES_SHOWN = 6;

const loadInvoices = async (db: Db): Promise<Map<string, RetainerInvoice[]>> => {
  const { rows } = await db.query<{
    id: string;
    retainer_id: string;
    invoice_number: string;
    retainer_cycle_on: string;
    retainer_cycle_reason: string | null;
    status: string;
    amount_cents: string;
    amount_paid_cents: string;
    link: string | null;
  }>(
    `SELECT id::text, retainer_id::text, invoice_number, retainer_cycle_on::text,
       retainer_cycle_reason, status, amount_cents::text, amount_paid_cents::text, link
     FROM public.invoices
     WHERE retainer_id IS NOT NULL AND retainer_cycle_on IS NOT NULL
     ORDER BY retainer_cycle_on DESC, created_at DESC`,
  );
  const byRetainer = new Map<string, RetainerInvoice[]>();
  for (const row of rows) {
    const list = byRetainer.get(row.retainer_id) ?? [];
    if (list.length >= INVOICES_SHOWN) continue;
    list.push({
      id: row.id,
      number: row.invoice_number,
      cycleOn: row.retainer_cycle_on,
      status: row.status,
      amountCents: toCents(row.amount_cents),
      amountPaidCents: toCents(row.amount_paid_cents),
      link: row.link,
      afterFailedCharge: row.retainer_cycle_reason === "payment_failed",
    });
    byRetainer.set(row.retainer_id, list);
  }
  return byRetainer;
};

const loadApprovalEmails = async (db: Db): Promise<Map<string, Retainer["approvalEmail"]>> => {
  const { rows } = await db.query<{
    retainer_id: string;
    approval_status: string;
    sent: boolean;
  }>(
    `SELECT retainer_id::text, approval_status, sent_at IS NOT NULL AS sent
     FROM public.reminders WHERE retainer_id IS NOT NULL ORDER BY created_at`,
  );
  const states = new Map<string, Retainer["approvalEmail"]>();
  for (const row of rows) {
    if (row.sent) states.set(row.retainer_id, "sent");
    else if (row.approval_status === "waiting") states.set(row.retainer_id, "waiting");
    else if (row.approval_status === "approved") states.set(row.retainer_id, "scheduled");
    else if (states.get(row.retainer_id) !== "sent") states.set(row.retainer_id, "none");
  }
  return states;
};

export const listRetainers = async (db: Db, now: Date): Promise<Retainer[]> => {
  const { rows } = await db.query<RetainerRow>(`${SELECT_RETAINERS} ORDER BY r.created_at DESC`);
  const invoices = await loadInvoices(db);
  const approvalEmails = await loadApprovalEmails(db);
  return rows.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    projectTitle: row.project_title,
    name: row.name,
    amountCents: toCents(row.amount_cents),
    currency: row.currency,
    unit: row.interval_unit,
    count: row.interval_count,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    method: row.method,
    status: row.status,
    pausedForInvoice: row.hold_cycle_on !== null,
    approvalEmail: approvalEmails.get(row.id) ?? "none",
    setUp: row.method !== "auto_pay" || row.paypal_subscription_id !== null,
    nextChargeOn: nextCharge(row, now),
    invoices: invoices.get(row.id) ?? [],
  }));
};

/** What's flagged for the freelancer in the dashboard, newest first. */
export const listRetainerAlerts = async (db: Db): Promise<RetainerAlert[]> => {
  const { rows } = await db.query<{
    id: string;
    retainer_id: string;
    kind: AlertKind;
    name: string;
    client_name: string;
    amount_cents: string;
    currency: string;
  }>(
    `SELECT a.id::text, a.retainer_id::text, a.kind, r.name, c.name AS client_name,
       r.amount_cents::text, r.currency
     FROM public.retainer_alerts a
     JOIN public.retainers r ON r.id = a.retainer_id
     JOIN public.clients c ON c.id = r.client_id
     WHERE a.dismissed_at IS NULL
     ORDER BY a.created_at DESC LIMIT 50`,
  );
  return rows.map((row) => ({
    id: row.id,
    retainerId: row.retainer_id,
    kind: row.kind,
    text: alertText(row.kind, {
      name: row.name,
      clientName: row.client_name,
      amountCents: toCents(row.amount_cents),
      currency: row.currency,
    }),
  }));
};

export const dismissRetainerAlert = async (db: Db, id: string, now: Date): Promise<boolean> => {
  if (!isUuid(id)) return false;
  const { rowCount } = await db.query(
    "UPDATE public.retainer_alerts SET dismissed_at = $2 WHERE id = $1 AND dismissed_at IS NULL",
    [id, now.toISOString()],
  );
  return rowCount > 0;
};
