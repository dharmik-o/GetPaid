import { z } from "zod";
import type { Db } from "./db";
import { errorKind, logEvent } from "./log";
import type { PaypalClient, PaypalSubscription } from "./paypal";
import {
  cancelSettledInvoice,
  insertCycleInvoice,
  issueRetainerInvoice,
  loadCycleRow,
  type RetainerInvoiceDeps,
} from "./retainer-invoices";
import type { AlertKind } from "./retainer-alerts";
import { retainerDates, type RetainerStatus } from "./retainers";
import { retainerCycleOn, todayIn } from "./schedule";

// Server-only: verified PayPal subscription events (paypal-webhook.ts checks the signature first).
// An event only says "look at this subscription": its state comes from PayPal, read fresh, and
// money comes from our own retainer row. That also keeps late or repeated events harmless.

const SUBSCRIPTION_EVENT = /^BILLING\.SUBSCRIPTION\.[A-Z.-]+$/;
const SALE_COMPLETED = "PAYMENT.SALE.COMPLETED";
const PAYMENT_FAILED = "BILLING.SUBSCRIPTION.PAYMENT.FAILED";

type RawEvent = { id: string; event_type: string; resource: unknown };

const subscriptionResource = z.object({ id: z.string().min(1) });
const saleResource = z.object({ billing_agreement_id: z.string().min(1) });

/** The subscription an event is about, or undefined when it isn't a subscription event. */
export const subscriptionIdOf = (event: RawEvent): string | undefined => {
  if (event.event_type === SALE_COMPLETED) {
    const sale = saleResource.safeParse(event.resource);
    return sale.success ? sale.data.billing_agreement_id : undefined;
  }
  if (!SUBSCRIPTION_EVENT.test(event.event_type)) return undefined;
  const resource = subscriptionResource.safeParse(event.resource);
  return resource.success ? resource.data.id : undefined;
};

const FROM_PAYPAL: Readonly<Record<string, RetainerStatus>> = {
  APPROVAL_PENDING: "pending_approval",
  APPROVED: "pending_approval",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  CANCELLED: "cancelled",
  EXPIRED: "ended",
};

const ALERT_ON_STATUS: Partial<Record<RetainerStatus, AlertKind>> = {
  suspended: "suspended",
  cancelled: "cancelled",
};

type Local = { id: string; user_id: string; status: RetainerStatus };

const findRetainer = async (
  db: Db,
  subscriptionId: string,
  lock = false,
): Promise<Local | undefined> => {
  const { rows } = await db.query<Local>(
    `SELECT id::text, user_id::text, status FROM public.retainers
     WHERE paypal_subscription_id = $1${lock ? " FOR UPDATE" : ""}`,
    [subscriptionId],
  );
  return rows[0];
};

const claimEvent = async (db: Db, retainer: Local, event: RawEvent): Promise<boolean> => {
  const { rowCount } = await db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ($1, 'retainer', $2, 'paypal.webhook', $3)
     ON CONFLICT ((payload ->> 'paypalEventId')) WHERE payload ->> 'paypalEventId' IS NOT NULL
     DO NOTHING`,
    [
      retainer.user_id,
      retainer.id,
      JSON.stringify({ paypalEventId: event.id, eventType: event.event_type }),
    ],
  );
  return rowCount > 0;
};

const addAlert = (db: Db, retainer: Local, kind: AlertKind) =>
  db.query("INSERT INTO public.retainer_alerts (user_id, retainer_id, kind) VALUES ($1, $2, $3)", [
    retainer.user_id,
    retainer.id,
    kind,
  ]);

/** A failed charge gets a normal invoice for that cycle, once, whatever PayPal retries. */
const startEscalation = async (db: Db, retainer: Local, now: Date): Promise<string | undefined> => {
  const row = await loadCycleRow(db, retainer.id);
  if (!row) return undefined;
  const today = todayIn(now, row.time_zone);
  const on = retainerCycleOn(retainerDates(row), today) ?? row.starts_on;
  const inserted = await insertCycleInvoice(db, retainer.id, row, {
    on,
    // The charge date has passed, so the reminder tiers count from there.
    dueDate: on,
    reason: "payment_failed",
  });
  if (!inserted) return undefined;
  await addAlert(db, retainer, "payment_failed");
  const { rows } = await db.query<{ id: string }>(
    `SELECT id::text FROM public.invoices
     WHERE retainer_id = $1 AND retainer_cycle_on = $2 AND status <> 'cancelled'`,
    [retainer.id, on],
  );
  return rows[0]?.id;
};

/**
 * PayPal says nothing is outstanding, so its retry collected what had failed. Open invoices for
 * those charges are no longer owed: their reminders stop now, and they're cancelled at PayPal after
 * this transaction. An invoice with money on it means the client may have paid twice.
 */
const settleFailedCharges = async (db: Db, retainer: Local): Promise<string[]> => {
  const { rows } = await db.query<{ id: string; status: string }>(
    `UPDATE public.invoices SET retainer_settled_at = now()
     WHERE retainer_id = $1 AND retainer_cycle_reason = 'payment_failed'
       AND retainer_settled_at IS NULL AND status <> 'cancelled'
     RETURNING id::text, status`,
    [retainer.id],
  );
  const open = rows.filter((row) => ["draft", "sent"].includes(row.status)).map((row) => row.id);
  if (open.length > 0) {
    await db.query(
      `UPDATE public.reminders SET approval_status = 'skipped', approved_via = NULL
       WHERE invoice_id = ANY($1::uuid[]) AND sent_at IS NULL
         AND approval_status IN ('waiting', 'approved')`,
      [open],
    );
    await addAlert(db, retainer, "recovered");
  }
  if (rows.some((row) => row.status === "paid" || row.status === "partially_paid")) {
    await addAlert(db, retainer, "paid_twice");
  }
  return open;
};

type Applied = {
  outcome: "duplicate" | "unchanged" | "applied";
  issue?: string;
  cancel?: string[];
  cancelSubscription?: boolean;
};

const applyStatus = async (
  db: Db,
  retainer: Local,
  remote: PaypalSubscription,
): Promise<Applied> => {
  const next = FROM_PAYPAL[remote.status];
  if (!next || next === retainer.status) return { outcome: "unchanged" };
  // Cancelled here first, then the client used the old approval link: it must not stay live.
  if (retainer.status === "cancelled") {
    if (next !== "active") return { outcome: "unchanged" };
    await addAlert(db, retainer, "activated_after_cancel");
    return { outcome: "applied", cancelSubscription: true };
  }
  await db.query(
    `UPDATE public.retainers SET status = $2,
       paypal_approval_link = CASE WHEN $2 = 'pending_approval' THEN paypal_approval_link END
     WHERE id = $1`,
    [retainer.id, next],
  );
  const alert = ALERT_ON_STATUS[next];
  if (alert) await addAlert(db, retainer, alert);
  return { outcome: "applied" };
};

const applyToRetainer = async (
  db: Db,
  subscriptionId: string,
  event: RawEvent,
  remote: PaypalSubscription,
  now: Date,
): Promise<Applied & { userId?: string }> => {
  const retainer = await findRetainer(db, subscriptionId, true);
  if (!retainer) return { outcome: "unchanged" };
  if (!(await claimEvent(db, retainer, event))) return { outcome: "duplicate" };
  const status = await applyStatus(db, retainer, remote);
  const applied: Applied & { userId: string } = { ...status, userId: retainer.user_id };
  if (event.event_type === PAYMENT_FAILED && retainer.status !== "cancelled") {
    const issue = await startEscalation(db, retainer, now);
    return issue ? { ...applied, outcome: "applied", issue } : applied;
  }
  if (event.event_type === SALE_COMPLETED) {
    await db.query("UPDATE public.retainers SET last_paid_at = $2 WHERE id = $1", [
      retainer.id,
      now.toISOString(),
    ]);
    const cancel = remote.outstandingCents === 0 ? await settleFailedCharges(db, retainer) : [];
    return { ...applied, outcome: "applied", cancel };
  }
  return applied;
};

/** Never fails the webhook: the scheduler finishes whatever this couldn't. */
const afterCommit = async (
  deps: RetainerInvoiceDeps,
  paypal: PaypalClient,
  subscriptionId: string,
  applied: Applied & { userId?: string },
): Promise<void> => {
  const { userId } = applied;
  if (!userId) return;
  try {
    if (applied.cancelSubscription) {
      await paypal.cancelSubscription(subscriptionId, "Cancelled by the freelancer.");
    }
    if (applied.issue) await issueRetainerInvoice(deps, { userId, invoiceId: applied.issue });
    for (const invoiceId of applied.cancel ?? []) {
      await cancelSettledInvoice(deps, { userId, invoiceId });
    }
  } catch (error) {
    logEvent("paypal_webhook.retainer_followup_failed", { error: errorKind(error) });
  }
};

export type RetainerOutcome = "ignored" | "duplicate" | "unchanged" | "applied";

export const applyRetainerEvent = async (
  deps: RetainerInvoiceDeps,
  paypal: PaypalClient,
  event: RawEvent,
  subscriptionId: string,
): Promise<RetainerOutcome> => {
  const found = await deps.runAsService((db) => findRetainer(db, subscriptionId));
  if (!found) return "ignored";
  // Read PayPal's copy outside any transaction.
  const remote = await paypal.getSubscription(subscriptionId);
  const applied = await deps.runAsService((db) =>
    applyToRetainer(db, subscriptionId, event, remote, deps.now()),
  );
  await afterCommit(deps, paypal, subscriptionId, applied);
  return applied.outcome;
};
