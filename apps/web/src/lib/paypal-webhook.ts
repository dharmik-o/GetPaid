import { z } from "zod";
import type { Db } from "./db";
import { toCents } from "./db-values";
import { jsonResponse, serverError } from "./http";
import type { InvoiceStatus } from "./invoices";
import { applyHoldEvent } from "./hold-webhook";
import { errorKind, logEvent } from "./log";
import type { PaypalClient, PaypalInvoice, WebhookHeaders } from "./paypal";
import { releaseHoldIfPaid } from "./retainer-hold";
import { applyRetainerEvent, subscriptionIdOf } from "./retainer-webhook";
import type { UserDbRunner } from "./db";
import type { ServiceDbRunner } from "./service-db";

// Server-only: POST /api/webhooks/paypal (n8n's 06_paypal_webhook relays PayPal's deliveries
// here). Every delivery is verified with PayPal before anything changes. For invoice events
// the status and amounts come from PayPal's own copy of the invoice, read fresh, never from
// the event body, which also keeps late or repeated events from moving anything backwards.

type Deps = {
  runAsService: ServiceDbRunner;
  /** Follow-ups to a verified event (a failed charge's invoice) run as the retainer's owner. */
  runAsUser: (userId: string) => UserDbRunner;
  now: () => Date;
  paypal: () => PaypalClient;
  webhookId: () => string | undefined;
};

const MAX_BODY_CHARS = 1_000_000;

const HEADERS: Record<keyof WebhookHeaders, string> = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
};

const eventSchema = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource: z.unknown(),
});

type WebhookEvent = z.infer<typeof eventSchema>;

/** Where an event points: PayPal's invoice id, or our invoice number. */
export type Target =
  | { by: "paypal_invoice_id"; value: string; action: "sync" }
  | { by: "invoice_number"; value: string; action: "sync" | "dispute" };

const INVOICE_EVENTS = new Set([
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.UPDATED",
  "INVOICING.INVOICE.REFUNDED",
  "INVOICING.INVOICE.CANCELLED",
]);

const idResource = z.object({ id: z.string().min(1) });
const refundResource = z.object({ id: z.string().optional(), invoice_id: z.string().min(1) });
const disputeResource = z.object({
  disputed_transactions: z.array(z.object({ invoice_number: z.string().optional() })),
});

const targetOf = (event: WebhookEvent): Target | undefined => {
  if (INVOICE_EVENTS.has(event.event_type)) {
    const parsed = idResource.safeParse(event.resource);
    return parsed.success
      ? { by: "paypal_invoice_id", value: parsed.data.id, action: "sync" }
      : undefined;
  }
  if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
    const parsed = refundResource.safeParse(event.resource);
    return parsed.success
      ? { by: "invoice_number", value: parsed.data.invoice_id, action: "sync" }
      : undefined;
  }
  if (event.event_type === "CUSTOMER.DISPUTE.CREATED") {
    const parsed = disputeResource.safeParse(event.resource);
    const number = parsed.success
      ? parsed.data.disputed_transactions.find((t) => t.invoice_number)?.invoice_number
      : undefined;
    return number ? { by: "invoice_number", value: number, action: "dispute" } : undefined;
  }
  return undefined;
};

export type LocalInvoice = {
  id: string;
  user_id: string;
  milestone_id: string | null;
  retainer_id: string | null;
  paypal_invoice_id: string | null;
  paypal_order_id: string | null;
  status: InvoiceStatus;
  amount_paid_cents: string;
  milestone_status_before: string | null;
  installment_plan_id: string | null;
};

export const findInvoice = async (
  db: Db,
  target: Target,
  lock = false,
): Promise<LocalInvoice | undefined> => {
  // The column name comes from the fixed Target type, never from the request.
  const column = target.by === "paypal_invoice_id" ? "paypal_invoice_id" : "invoice_number";
  const { rows } = await db.query<LocalInvoice>(
    `SELECT id::text, user_id::text, milestone_id::text, retainer_id::text, paypal_invoice_id, paypal_order_id, status,
       amount_paid_cents::text, milestone_status_before, installment_plan_id::text
     FROM public.invoices WHERE ${column} = $1${lock ? " FOR UPDATE" : ""}`,
    [target.value],
  );
  return rows[0];
};

const FROM_PAYPAL: Record<string, InvoiceStatus> = {
  PAID: "paid",
  MARKED_AS_PAID: "paid",
  PARTIALLY_PAID: "partially_paid",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "refunded",
  MARKED_AS_REFUNDED: "refunded",
  CANCELLED: "cancelled",
};

/** Our status for PayPal's. A dispute stays a dispute until money goes back. */
export const syncedStatus = (current: InvoiceStatus, paypalStatus: string): InvoiceStatus => {
  const next = FROM_PAYPAL[paypalStatus] ?? current;
  return current === "disputed" && next !== "refunded" ? "disputed" : next;
};

/** Milestone status that follows a plain invoice's; undefined leaves the milestone as it is. */
const milestoneStatusFor = (status: InvoiceStatus, before: string | null): string | undefined => {
  if (status === "paid" || status === "partially_paid" || status === "disputed") return status;
  if (status === "cancelled") return before ?? "accepted";
  return undefined;
};

/**
 * Milestone status after an installment changes: Paid once every installment of the plan is
 * invoiced and paid (the plan is then completed), Partially paid while some are. A cancelled
 * installment leaves the milestone alone while it has other open invoices.
 */
const installmentMilestoneStatus = async (
  db: Db,
  invoice: LocalInvoice,
  planId: string,
  status: InvoiceStatus,
): Promise<string | undefined> => {
  if (status === "disputed") return status;
  const { rows } = await db.query<{ count: number; open: number; paid: number }>(
    `SELECT p.count,
       (SELECT count(*)::int FROM public.invoices i
        WHERE i.installment_plan_id = p.id AND i.status <> 'cancelled') AS open,
       (SELECT count(*)::int FROM public.invoices i
        WHERE i.installment_plan_id = p.id AND i.status = 'paid') AS paid
     FROM public.installment_plans p WHERE p.id = $1`,
    [planId],
  );
  const plan = rows[0];
  if (!plan) return undefined;
  if (status === "cancelled") {
    return plan.open === 0 ? (invoice.milestone_status_before ?? "accepted") : undefined;
  }
  if (status !== "paid" && status !== "partially_paid") return undefined;
  if (plan.paid === plan.count) {
    await db.query(
      "UPDATE public.installment_plans SET status = 'completed' WHERE id = $1 AND status = 'active'",
      [planId],
    );
    return "paid";
  }
  return "partially_paid";
};

export type Change = { status: InvoiceStatus; amountPaidCents: number };

/** Records the event id; false when this event was already applied. */
const claimEvent = async (db: Db, invoice: LocalInvoice, event: WebhookEvent): Promise<boolean> => {
  const { rowCount } = await db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ($1, 'invoice', $2, 'paypal.webhook', $3)
     ON CONFLICT ((payload ->> 'paypalEventId')) WHERE payload ->> 'paypalEventId' IS NOT NULL
     DO NOTHING`,
    [
      invoice.user_id,
      invoice.id,
      JSON.stringify({ paypalEventId: event.id, eventType: event.event_type }),
    ],
  );
  return rowCount > 0;
};

/**
 * Saves a status or amount change, moves the milestone, and stops reminders not yet sent.
 * `cause` is logged with it: the PayPal event type, or the freelancer's own action.
 */
export const applyChange = async (
  db: Db,
  invoice: LocalInvoice,
  change: Change,
  cause: string,
): Promise<boolean> => {
  const unchanged =
    change.status === invoice.status &&
    change.amountPaidCents === toCents(invoice.amount_paid_cents);
  if (unchanged) return false;
  await db.query("UPDATE public.invoices SET status = $2, amount_paid_cents = $3 WHERE id = $1", [
    invoice.id,
    change.status,
    change.amountPaidCents,
  ]);
  const milestoneStatus = invoice.installment_plan_id
    ? await installmentMilestoneStatus(db, invoice, invoice.installment_plan_id, change.status)
    : milestoneStatusFor(change.status, invoice.milestone_status_before);
  if (invoice.milestone_id && milestoneStatus) {
    // Cancelling restores the pre-invoice status only from an invoice status.
    const from = change.status === "cancelled" ? "AND status IN ('invoiced', 'overdue')" : "";
    await db.query(`UPDATE public.milestones SET status = $2 WHERE id = $1 ${from}`, [
      invoice.milestone_id,
      milestoneStatus,
    ]);
  }
  // Paid, refunded, cancelled or disputed: nothing more to send for this invoice. Any other
  // payment change alters the balance, so drafts quoting the old amount are stopped too; the
  // schedule makes new ones. Other installments keep their own reminders.
  await db.query(
    `UPDATE public.reminders SET approval_status = 'skipped', approved_via = NULL
     WHERE invoice_id = $1 AND sent_at IS NULL AND approval_status IN ('waiting', 'approved')`,
    [invoice.id],
  );
  await db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ($1, 'invoice', $2, $3, $4)`,
    [
      invoice.user_id,
      invoice.id,
      `invoice.${change.status}`,
      JSON.stringify({ amountPaidCents: change.amountPaidCents, eventType: cause }),
    ],
  );
  return true;
};

type Outcome = "ignored" | "duplicate" | "unchanged" | "applied";

export const changeFromPaypal = (invoice: LocalInvoice, remote: PaypalInvoice): Change => ({
  status: syncedStatus(invoice.status, remote.status),
  amountPaidCents: Math.max(0, remote.paidCents - remote.refundedCents),
});

/**
 * A refund of a captured hold. There's no PayPal invoice to read, so the amount comes from PayPal's
 * own copy of the refund, and each refund counts once, however often it's delivered.
 */
const applyHoldRefund = async (
  deps: Deps,
  paypal: PaypalClient,
  target: Target,
  event: WebhookEvent,
): Promise<Outcome> => {
  const refundId = refundResource.safeParse(event.resource).data?.id;
  if (!refundId) return "ignored";
  const { cents } = await paypal.getRefund(refundId);
  return deps.runAsService(async (db) => {
    const invoice = await findInvoice(db, target, true);
    if (!invoice) return "ignored";
    if (!(await claimEvent(db, invoice, { ...event, id: `refund:${refundId}` }))) {
      return "duplicate";
    }
    const change: Change = {
      status: "refunded",
      amountPaidCents: Math.max(0, toCents(invoice.amount_paid_cents) - cents),
    };
    return (await applyChange(db, invoice, change, event.event_type)) ? "applied" : "unchanged";
  });
};

/** Never fails the webhook: the money is recorded, and the scheduler finishes reactivating. */
const reactivateAfterPayment = async (
  deps: Deps,
  paypal: PaypalClient,
  retainerId: string,
): Promise<void> => {
  try {
    await releaseHoldIfPaid({ ...deps, paypal: () => paypal }, paypal, retainerId);
  } catch (error) {
    logEvent("paypal_webhook.reactivate_failed", { retainerId, error: errorKind(error) });
  }
};

const applyEvent = async (
  deps: Deps,
  paypal: PaypalClient,
  event: WebhookEvent,
): Promise<Outcome> => {
  const subscriptionId = subscriptionIdOf(event);
  if (subscriptionId) {
    return applyRetainerEvent({ ...deps, paypal: () => paypal }, paypal, event, subscriptionId);
  }
  const holdOutcome = await applyHoldEvent({ ...deps, paypal: () => paypal }, paypal, event);
  if (holdOutcome) return holdOutcome;
  const target = targetOf(event);
  if (!target) return "ignored";
  const found = await deps.runAsService((db) => findInvoice(db, target));
  if (!found) return "ignored";

  if (found.paypal_order_id && event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
    return applyHoldRefund(deps, paypal, target, event);
  }

  // Read PayPal's copy outside any transaction.
  const remote =
    target.action === "sync" && found.paypal_invoice_id
      ? await paypal.getInvoice(found.paypal_invoice_id)
      : undefined;
  if (target.action === "sync" && !remote) return "ignored";

  const outcome = await deps.runAsService(async (db): Promise<Outcome> => {
    const invoice = await findInvoice(db, target, true);
    if (!invoice) return "ignored";
    if (!(await claimEvent(db, invoice, event))) return "duplicate";
    const change: Change = remote
      ? changeFromPaypal(invoice, remote)
      : { status: "disputed", amountPaidCents: toCents(invoice.amount_paid_cents) };
    return (await applyChange(db, invoice, change, event.event_type)) ? "applied" : "unchanged";
  });
  if (found.retainer_id && outcome === "applied") {
    await reactivateAfterPayment(deps, paypal, found.retainer_id);
  }
  return outcome;
};

const reject = (status: number, error: string, reason: string): Response => {
  logEvent("paypal_webhook.rejected", { reason, status });
  return jsonResponse({ error }, status);
};

const readHeaders = (request: Request): WebhookHeaders | undefined => {
  const entries = Object.entries(HEADERS).map(([key, name]) => [key, request.headers.get(name)]);
  return entries.every(([, value]) => value)
    ? (Object.fromEntries(entries) as WebhookHeaders)
    : undefined;
};

const parseObject = (raw: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export const paypalWebhookHandler = (deps: Deps) => ({
  post: async (request: Request): Promise<Response> => {
    const webhookId = deps.webhookId();
    if (!webhookId) {
      return reject(
        503,
        "Webhooks can't be verified yet: set PAYPAL_WEBHOOK_ID in the local env file and restart.",
        "webhook_id_missing",
      );
    }
    const headers = readHeaders(request);
    if (!headers) return reject(400, "Missing PayPal signature headers.", "unsigned");
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) return reject(413, "Webhook body too large.", "too_large");
    const json = parseObject(raw);
    if (!json) return reject(400, "Webhook body must be a JSON object.", "not_json");

    let paypal: PaypalClient;
    let verified: boolean;
    try {
      paypal = deps.paypal();
      verified = await paypal.verifyWebhook(headers, raw, webhookId);
    } catch (error) {
      logEvent("paypal_webhook.verify_failed", { error: errorKind(error) });
      return jsonResponse({ error: "Couldn't verify the webhook with PayPal. Retry later." }, 503);
    }
    if (!verified) {
      return reject(401, "Webhook signature not verified.", "signature_failed");
    }

    const event = eventSchema.safeParse(json);
    if (!event.success) {
      logEvent("paypal_webhook.ignored", { reason: "unknown_shape" });
      return jsonResponse({ received: true });
    }
    try {
      const outcome = await applyEvent(deps, paypal, event.data);
      logEvent("paypal_webhook.handled", {
        eventId: event.data.id,
        eventType: event.data.event_type,
        outcome,
      });
      return jsonResponse({ received: true, outcome });
    } catch (error) {
      // A 5xx makes PayPal deliver it again later.
      return serverError("paypal_webhook.failed", error);
    }
  },
});
