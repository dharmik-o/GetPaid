import type { Db, UserDbRunner } from "./db";
import { toCents } from "./db-values";
import { formatFullDay } from "./format";
import { cancelInPaypal } from "./invoice-cancel";
import { sendThroughPaypal } from "./invoice-flow";
import { resolveTemplateId } from "./invoice-templates";
import { errorKind, logEvent } from "./log";
import type { PaypalClient } from "./paypal";
import { retainerDates, type RetainerStatus } from "./retainers";
import { retainerCyclesBetween, retainerDueDate, todayIn } from "./schedule";
import type { ServiceDbRunner } from "./service-db";
import { mergeSettings } from "./settings";

// Server-only: each cycle's PayPal invoice. A row is saved as a draft first, with its request id
// and number, and the scheduler picks up any draft still unsent, so a failed PayPal call only
// delays it. PayPal emails nobody: the client hears about it through an approved reminder.

export type RetainerInvoiceDeps = {
  runAsService: ServiceDbRunner;
  runAsUser: (userId: string) => UserDbRunner;
  now: () => Date;
  paypal: () => PaypalClient;
};

/** A scheduler that was off for a while catches up a little at a time. */
const CYCLES_PER_RUN = 12;
const RUN_LIMIT = 100;

type CycleRow = {
  user_id: string;
  amount_cents: string;
  currency: string;
  interval_unit: "week" | "month";
  interval_count: number;
  starts_on: string;
  ends_on: string | null;
  status: RetainerStatus;
  time_zone: string;
  account_settings: unknown;
  client_settings: unknown;
  project_settings: unknown;
};

const SELECT_CYCLE_ROW = `
  SELECT r.user_id::text, r.amount_cents::text, r.currency, r.interval_unit, r.interval_count,
    r.starts_on::text, r.ends_on::text, r.status, c.time_zone,
    u.default_settings AS account_settings, c.settings AS client_settings,
    p.settings AS project_settings
  FROM public.retainers r
  JOIN public.clients c ON c.id = r.client_id
  JOIN public.users u ON u.id = r.user_id
  LEFT JOIN public.projects p ON p.id = r.project_id
  WHERE r.id = $1`;

export const loadCycleRow = async (db: Db, id: string): Promise<CycleRow | undefined> => {
  const { rows } = await db.query<CycleRow>(SELECT_CYCLE_ROW, [id]);
  return rows[0];
};

/** One open invoice per cycle: a second attempt finds the first and changes nothing. */
export const insertCycleInvoice = async (
  db: Db,
  retainerId: string,
  row: CycleRow,
  cycle: { on: string; dueDate: string; reason: "cycle" | "payment_failed" },
): Promise<boolean> => {
  const { rowCount } = await db.query(
    `INSERT INTO public.invoices (user_id, retainer_id, amount_cents, currency, due_date,
       retainer_cycle_on, retainer_cycle_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (retainer_id, retainer_cycle_on)
       WHERE status <> 'cancelled' AND retainer_cycle_on IS NOT NULL
     DO NOTHING`,
    [
      row.user_id,
      retainerId,
      toCents(row.amount_cents),
      row.currency,
      cycle.dueDate,
      cycle.on,
      cycle.reason,
    ],
  );
  return rowCount > 0;
};

/** Draft rows for each charge date reached, and the end of a retainer that has finished. */
const createDueCycles = async (db: Db, retainerId: string, now: Date): Promise<number> => {
  const row = await loadCycleRow(db, retainerId);
  if (row?.status !== "active") return 0;
  const today = todayIn(now, row.time_zone);
  const { rows } = await db.query<{ on: string }>(
    `SELECT retainer_cycle_on::text AS on FROM public.invoices
     WHERE retainer_id = $1 AND retainer_cycle_on IS NOT NULL`,
    [retainerId],
  );
  // Any status counts: a cycle the freelancer cancelled mustn't come back.
  const done = new Set(rows.map((invoice) => invoice.on));
  const missing = retainerCyclesBetween(retainerDates(row), row.starts_on, today).filter(
    (cycle) => !done.has(cycle),
  );
  const { paymentTerms } = mergeSettings({
    account: row.account_settings,
    client: row.client_settings,
    project: row.project_settings,
  });
  for (const on of missing.slice(0, CYCLES_PER_RUN)) {
    await insertCycleInvoice(db, retainerId, row, {
      on,
      dueDate: retainerDueDate(paymentTerms, on),
      reason: "cycle",
    });
  }
  if (row.ends_on !== null && today > row.ends_on && missing.length <= CYCLES_PER_RUN) {
    await db.query(
      "UPDATE public.retainers SET status = 'ended' WHERE id = $1 AND status = 'active'",
      [retainerId],
    );
  }
  return Math.min(missing.length, CYCLES_PER_RUN);
};

type IssueRow = {
  invoice_number: string;
  status: string;
  amount_cents: string;
  currency: string;
  due_date: string;
  retainer_cycle_on: string;
  paypal_invoice_id: string | null;
  paypal_request_id: string;
  retainer_name: string;
  client_id: string;
  client_name: string;
  client_email: string;
  time_zone: string;
};

const loadIssueRow = async (db: Db, invoiceId: string): Promise<IssueRow | undefined> => {
  const { rows } = await db.query<IssueRow>(
    `SELECT i.invoice_number, i.status, i.amount_cents::text, i.currency, i.due_date::text,
       i.retainer_cycle_on::text, i.paypal_invoice_id, i.paypal_request_id::text,
       r.name AS retainer_name, c.id::text AS client_id, c.name AS client_name,
       c.email AS client_email, c.time_zone
     FROM public.invoices i
     JOIN public.retainers r ON r.id = i.retainer_id
     JOIN public.clients c ON c.id = r.client_id
     WHERE i.id = $1`,
    [invoiceId],
  );
  return rows[0];
};

const markRetainerInvoiceSent = async (
  db: Db,
  invoiceId: string,
  link: string,
  row: IssueRow,
): Promise<void> => {
  const { rowCount } = await db.query(
    "UPDATE public.invoices SET status = 'sent', link = $2 WHERE id = $1 AND status = 'draft'",
    [invoiceId, link],
  );
  if (rowCount === 0) return;
  await db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ((SELECT auth.uid()), 'invoice', $1, 'invoice.sent', $2)`,
    [
      invoiceId,
      JSON.stringify({
        invoiceNumber: row.invoice_number,
        amountCents: toCents(row.amount_cents),
        currency: row.currency,
        cycleOn: row.retainer_cycle_on,
      }),
    ],
  );
};

/** Creates and sends one cycle's PayPal invoice. A repeat finds the first by its number. */
export const issueRetainerInvoice = async (
  deps: RetainerInvoiceDeps,
  { userId, invoiceId }: { userId: string; invoiceId: string },
): Promise<void> => {
  const runAsUser = deps.runAsUser(userId);
  const row = await runAsUser(async (db) => {
    const loaded = await loadIssueRow(db, invoiceId);
    if (loaded?.status === "draft") {
      const templateId = await resolveTemplateId(db, { picked: null, clientId: loaded.client_id });
      await db.query(
        "UPDATE public.invoices SET template_id = coalesce(template_id, $2) WHERE id = $1",
        [invoiceId, templateId],
      );
    }
    return loaded;
  });
  if (row?.status !== "draft") return;
  const now = deps.now();
  const sent = await sendThroughPaypal(
    { runAsUser, paypal: deps.paypal(), now },
    {
      id: invoiceId,
      invoiceNumber: row.invoice_number,
      paypalInvoiceId: row.paypal_invoice_id,
    },
    {
      requestId: row.paypal_request_id,
      invoiceNumber: row.invoice_number,
      currency: row.currency,
      amountCents: toCents(row.amount_cents),
      dueDate: row.due_date <= todayIn(now, row.time_zone) ? null : row.due_date,
      itemName: row.retainer_name,
      itemDescription: `${row.retainer_name}, charge of ${formatFullDay(row.retainer_cycle_on)}`,
      note: null,
      recipient: { email: row.client_email, name: row.client_name },
    },
  );
  if (!sent.ok) {
    logEvent("retainers.invoice_refused", { invoiceId });
    return;
  }
  await runAsUser((db) => markRetainerInvoiceSent(db, invoiceId, sent.link, row));
  logEvent("retainers.invoice_sent", { invoiceId });
};

type SettledRow = {
  id: string;
  retainer_id: string;
  invoice_number: string;
  amount_cents: string;
  paypal_invoice_id: string | null;
};

const PAID = "paid";

/**
 * PayPal's retry collected this charge, so its invoice isn't owed. Cancelled at PayPal unless the
 * client got there first: then it's recorded as paid, and the freelancer is told to check.
 */
export const cancelSettledInvoice = async (
  deps: RetainerInvoiceDeps,
  { userId, invoiceId }: { userId: string; invoiceId: string },
): Promise<void> => {
  const runAsUser = deps.runAsUser(userId);
  const row = await runAsUser(async (db) => {
    const { rows } = await db.query<SettledRow>(
      `SELECT id::text, retainer_id::text, invoice_number, amount_cents::text, paypal_invoice_id
       FROM public.invoices
       WHERE id = $1 AND retainer_settled_at IS NOT NULL AND status IN ('draft', 'sent')`,
      [invoiceId],
    );
    return rows[0];
  });
  if (!row) return;
  const paypal = deps.paypal();
  const refused = await cancelInPaypal(
    { runAsUser, paypal, now: deps.now() },
    { paypalInvoiceId: row.paypal_invoice_id },
    PAID,
  );
  const paidCents =
    refused && row.paypal_invoice_id
      ? (await paypal.getInvoice(row.paypal_invoice_id)).paidCents
      : 0;
  await runAsUser(async (db) => {
    const status = !refused
      ? "cancelled"
      : paidCents >= toCents(row.amount_cents)
        ? "paid"
        : "partially_paid";
    await db.query("UPDATE public.invoices SET status = $2, amount_paid_cents = $3 WHERE id = $1", [
      row.id,
      status,
      paidCents,
    ]);
    await db.query(
      `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
       VALUES ((SELECT auth.uid()), 'invoice', $1, $2, $3)`,
      [row.id, `invoice.${status}`, JSON.stringify({ invoiceNumber: row.invoice_number })],
    );
    if (refused) {
      await db.query(
        `INSERT INTO public.retainer_alerts (user_id, retainer_id, kind)
         VALUES ((SELECT auth.uid()), $1, 'paid_twice')`,
        [row.retainer_id],
      );
    }
  });
};

const guarded = async (event: string, invoiceId: string, work: () => Promise<void>) => {
  try {
    await work();
  } catch (error) {
    // Tried again on the next run: the row is still a draft, or still waiting to be cancelled.
    logEvent(event, { invoiceId, error: errorKind(error) });
  }
};

/** The scheduler's part: this cycle's invoices, then anything left over from a failed call. */
export const runRetainerInvoices = async (
  deps: RetainerInvoiceDeps,
): Promise<{ invoiced: number }> => {
  const now = deps.now();
  const retainers = await deps.runAsService(async (db) => {
    const { rows } = await db.query<{ id: string; user_id: string }>(
      `SELECT id::text, user_id::text FROM public.retainers
       WHERE method = 'invoice' AND status = 'active' LIMIT ${String(RUN_LIMIT)}`,
    );
    return rows;
  });
  for (const { id, user_id: userId } of retainers) {
    await deps.runAsUser(userId)((db) => createDueCycles(db, id, now));
  }
  const pending = await deps.runAsService(async (db) => {
    const { rows } = await db.query<{ id: string; user_id: string; settled: boolean }>(
      `SELECT id::text, user_id::text, retainer_settled_at IS NOT NULL AS settled
       FROM public.invoices
       WHERE retainer_id IS NOT NULL AND retainer_cycle_on IS NOT NULL
         AND (status = 'draft' OR (status = 'sent' AND retainer_settled_at IS NOT NULL))
       ORDER BY created_at LIMIT ${String(RUN_LIMIT)}`,
    );
    return rows;
  });
  let invoiced = 0;
  for (const { id: invoiceId, user_id: userId, settled } of pending) {
    if (settled) {
      await guarded("retainers.cancel_failed", invoiceId, () =>
        cancelSettledInvoice(deps, { userId, invoiceId }),
      );
      continue;
    }
    await guarded("retainers.invoice_failed", invoiceId, async () => {
      await issueRetainerInvoice(deps, { userId, invoiceId });
      invoiced += 1;
    });
  }
  return { invoiced };
};
