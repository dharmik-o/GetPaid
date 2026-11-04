import type { Db } from "./db";
import { errorKind, logEvent } from "./log";
import type { PaypalClient, PaypalSubscription } from "./paypal";
import type { AlertKind } from "./retainer-alerts";
import {
  insertCycleInvoice,
  issueRetainerInvoice,
  loadCycleRow,
  type RetainerInvoiceDeps,
} from "./retainer-invoices";

// Server-only: the order that stops a client paying twice for a failed charge. The subscription is
// suspended in PayPal first, and PayPal's own copy must say so before a catch-up invoice can exist.
// It's reactivated once that invoice is paid. Each step is saved, PayPal is never called inside a
// transaction, and the scheduler finishes whatever a failure interrupted.

const SUSPEND_REASON = "Payment failed. Paused while the client pays this charge by invoice.";
const ACTIVATE_REASON = "The failed charge has been paid.";

type HoldRow = {
  user_id: string;
  status: string;
  paypal_subscription_id: string | null;
  hold_cycle_on: string | null;
  held_at: Date | string | null;
};

const loadHold = async (db: Db, retainerId: string): Promise<HoldRow | undefined> => {
  const { rows } = await db.query<HoldRow>(
    `SELECT user_id::text, status, paypal_subscription_id,
       auto_pay_hold_cycle_on::text AS hold_cycle_on, auto_pay_held_at AS held_at
     FROM public.retainers WHERE id = $1`,
    [retainerId],
  );
  return rows[0];
};

const addAlert = (db: Db, row: HoldRow, retainerId: string, kind: AlertKind) =>
  db.query("INSERT INTO public.retainer_alerts (user_id, retainer_id, kind) VALUES ($1, $2, $3)", [
    row.user_id,
    retainerId,
    kind,
  ]);

/**
 * PayPal shows a payment since the last failure, and nothing outstanding. Outstanding alone can't
 * say this: PayPal adds a failed charge to it only after its retries run out.
 */
export const failedChargeCollected = (remote: PaypalSubscription): boolean =>
  remote.outstandingCents === 0 &&
  remote.lastFailedAt !== null &&
  remote.lastPaymentAt !== null &&
  remote.lastPaymentAt > remote.lastFailedAt;

const clearHold = (db: Db, retainerId: string, status: string) =>
  db.query(
    `UPDATE public.retainers
     SET auto_pay_hold_cycle_on = NULL, auto_pay_held_at = NULL, status = $2
     WHERE id = $1`,
    [retainerId, status],
  );

/** A hold ends with auto-pay running again. A subscription that's gone stays gone. */
const endHold = async (
  deps: RetainerInvoiceDeps,
  paypal: PaypalClient,
  retainerId: string,
  subscriptionId: string,
  alert: AlertKind | null,
): Promise<void> => {
  const remote = await paypal.getSubscription(subscriptionId);
  if (remote.status === "SUSPENDED") {
    await paypal.activateSubscription(subscriptionId, ACTIVATE_REASON);
  }
  const running = remote.status === "SUSPENDED" || remote.status === "ACTIVE";
  await deps.runAsService(async (db) => {
    const row = await loadHold(db, retainerId);
    if (!row?.hold_cycle_on) return;
    await clearHold(db, retainerId, running ? "active" : row.status);
    if (alert) await addAlert(db, row, retainerId, alert);
  });
  logEvent("retainers.hold_ended", { retainerId, alert });
};

/** Suspends, confirms it, and only then makes the invoice. Safe to repeat. */
export const placeHold = async (
  deps: RetainerInvoiceDeps,
  paypal: PaypalClient,
  retainerId: string,
): Promise<void> => {
  const row = await deps.runAsService((db) => loadHold(db, retainerId));
  if (!row?.hold_cycle_on || !row.paypal_subscription_id) return;
  const subscriptionId = row.paypal_subscription_id;
  if (!row.held_at) {
    const before = await paypal.getSubscription(subscriptionId);
    if (failedChargeCollected(before)) {
      await endHold(deps, paypal, retainerId, subscriptionId, "recovered");
      return;
    }
    if (before.status === "ACTIVE") {
      await paypal.suspendSubscription(subscriptionId, SUSPEND_REASON);
    }
    const after = await paypal.getSubscription(subscriptionId);
    if (after.status !== "SUSPENDED") {
      throw new Error(
        `PayPal shows this subscription as ${after.status} after suspending it, so no invoice was made. The next scheduler run tries again.`,
      );
    }
    // A retry that landed just before the suspension took effect has already collected this.
    if (failedChargeCollected(after)) {
      await endHold(deps, paypal, retainerId, subscriptionId, "recovered");
      return;
    }
  }
  const invoiceId = await deps.runAsService((db) =>
    saveHeldInvoice(db, retainerId, row.hold_cycle_on ?? "", deps.now()),
  );
  if (invoiceId) await issueRetainerInvoice(deps, { userId: row.user_id, invoiceId });
};

const saveHeldInvoice = async (
  db: Db,
  retainerId: string,
  cycleOn: string,
  now: Date,
): Promise<string | undefined> => {
  await db.query(
    `UPDATE public.retainers SET status = 'suspended', auto_pay_held_at = coalesce(auto_pay_held_at, $2)
     WHERE id = $1 AND auto_pay_hold_cycle_on IS NOT NULL`,
    [retainerId, now.toISOString()],
  );
  const cycle = await loadCycleRow(db, retainerId);
  if (!cycle) return undefined;
  await insertCycleInvoice(db, retainerId, cycle, {
    on: cycleOn,
    // The charge date has passed, so the reminder tiers count from there.
    dueDate: cycleOn,
    reason: "payment_failed",
  });
  const { rows } = await db.query<{ id: string }>(
    `SELECT id::text FROM public.invoices
     WHERE retainer_id = $1 AND retainer_cycle_on = $2 AND status = 'draft'`,
    [retainerId, cycleOn],
  );
  return rows[0]?.id;
};

/** Reactivates once the catch-up invoice is paid. An unpaid or cancelled one leaves it suspended. */
export const releaseHoldIfPaid = async (
  deps: RetainerInvoiceDeps,
  paypal: PaypalClient,
  retainerId: string,
): Promise<void> => {
  const ready = await deps.runAsService(async (db) => {
    const row = await loadHold(db, retainerId);
    if (!row?.hold_cycle_on || !row.held_at || !row.paypal_subscription_id) return undefined;
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM public.invoices
       WHERE retainer_id = $1 AND retainer_cycle_on = $2 AND status <> 'cancelled'`,
      [retainerId, row.hold_cycle_on],
    );
    return rows[0]?.status === "paid" ? row.paypal_subscription_id : undefined;
  });
  if (ready) await endHold(deps, paypal, retainerId, ready, "reactivated");
};

/** PayPal's retry collected the charge: auto-pay runs again, with no invoice needed. */
export const endHoldAfterRetry = async (
  deps: RetainerInvoiceDeps,
  paypal: PaypalClient,
  retainerId: string,
): Promise<void> => {
  const row = await deps.runAsService((db) => loadHold(db, retainerId));
  if (!row?.hold_cycle_on || !row.paypal_subscription_id) return;
  await endHold(deps, paypal, retainerId, row.paypal_subscription_id, null);
};

const RUN_LIMIT = 100;

/** The scheduler's part: finishes each hold a PayPal failure interrupted. One failing stops none. */
export const continueHolds = async (deps: RetainerInvoiceDeps): Promise<void> => {
  const held = await deps.runAsService(async (db) => {
    const { rows } = await db.query<{ id: string; placed: boolean }>(
      `SELECT id::text, auto_pay_held_at IS NOT NULL AS placed FROM public.retainers
       WHERE auto_pay_hold_cycle_on IS NOT NULL LIMIT ${String(RUN_LIMIT)}`,
    );
    return rows;
  });
  for (const { id, placed } of held) {
    try {
      const work = placed ? releaseHoldIfPaid : placeHold;
      await work(deps, deps.paypal(), id);
    } catch (error) {
      logEvent("retainers.hold_failed", { retainerId: id, error: errorKind(error) });
    }
  }
};
