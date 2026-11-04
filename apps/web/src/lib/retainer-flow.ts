import { isUuid, type Db, type UserDbRunner } from "./db";
import { toCents } from "./db-values";
import { logEvent } from "./log";
import type { PaypalClient } from "./paypal";
import { retainerDates, type RetainerStatus } from "./retainers";
import { retainerTotalCycles, startOfLocalDay, todayIn } from "./schedule";

// Server-only: auto-pay setup and cancelling. PayPal is never called inside a transaction. Each
// create call is keyed by a request id saved beforehand, and each id is saved as soon as PayPal
// gives it, so a retry after any failure carries on from the step that failed.

export type RetainerFlowDeps = { runAsUser: UserDbRunner; paypal: PaypalClient; now: Date };

type SetupRow = {
  name: string;
  amount_cents: string;
  currency: string;
  interval_unit: "week" | "month";
  interval_count: number;
  starts_on: string;
  ends_on: string | null;
  method: string;
  status: RetainerStatus;
  time_zone: string;
  client_email: string;
  paypal_product_id: string | null;
  paypal_plan_id: string | null;
  paypal_subscription_id: string | null;
  paypal_product_request_id: string;
  paypal_plan_request_id: string;
  paypal_subscription_request_id: string;
};

const loadSetup = async (db: Db, id: string): Promise<SetupRow | undefined> => {
  const { rows } = await db.query<SetupRow>(
    `SELECT r.name, r.amount_cents::text, r.currency, r.interval_unit, r.interval_count,
       r.starts_on::text, r.ends_on::text, r.method, r.status, c.time_zone, c.email AS client_email,
       r.paypal_product_id, r.paypal_plan_id, r.paypal_subscription_id,
       r.paypal_product_request_id::text, r.paypal_plan_request_id::text,
       r.paypal_subscription_request_id::text
     FROM public.retainers r JOIN public.clients c ON c.id = r.client_id
     WHERE r.id = $1`,
    [id],
  );
  return rows[0];
};

/** The column name is fixed by the caller, never from a request. */
const saveId = (
  deps: RetainerFlowDeps,
  id: string,
  column: "paypal_product_id" | "paypal_plan_id",
  value: string,
) =>
  deps.runAsUser((db) =>
    db.query(`UPDATE public.retainers SET ${column} = $2 WHERE id = $1`, [id, value]),
  );

export type SetupResult = "ok" | "not_found" | "not_needed";

/** Creates the product, plan and subscription, or finishes a setup that failed partway. */
export const setUpAutoPay = async (deps: RetainerFlowDeps, id: string): Promise<SetupResult> => {
  if (!isUuid(id)) return "not_found";
  const row = await deps.runAsUser((db) => loadSetup(db, id));
  if (!row) return "not_found";
  if (row.method !== "auto_pay" || row.status !== "pending_approval") return "not_needed";
  if (row.paypal_subscription_id) return "ok";

  const productId =
    row.paypal_product_id ??
    (await deps.paypal.createProduct({ requestId: row.paypal_product_request_id, name: row.name }))
      .id;
  if (!row.paypal_product_id) await saveId(deps, id, "paypal_product_id", productId);

  const planId =
    row.paypal_plan_id ??
    (
      await deps.paypal.createPlan({
        requestId: row.paypal_plan_request_id,
        productId,
        name: row.name,
        amountCents: toCents(row.amount_cents),
        currency: row.currency,
        unit: row.interval_unit,
        count: row.interval_count,
        totalCycles: retainerTotalCycles(retainerDates(row)),
      })
    ).id;
  if (!row.paypal_plan_id) await saveId(deps, id, "paypal_plan_id", planId);

  const startsLater = row.starts_on > todayIn(deps.now, row.time_zone);
  const subscription = await deps.paypal.createSubscription({
    requestId: row.paypal_subscription_request_id,
    planId,
    startTime: startsLater ? startOfLocalDay(row.starts_on, row.time_zone) : null,
    subscriberEmail: row.client_email,
    customId: id,
  });
  await deps.runAsUser((db) =>
    db.query(
      `UPDATE public.retainers SET paypal_subscription_id = $2, paypal_approval_link = $3
       WHERE id = $1 AND paypal_subscription_id IS NULL`,
      [id, subscription.id, subscription.approvalLink],
    ),
  );
  logEvent("retainers.subscription_created", { retainerId: id });
  return "ok";
};

const CANCEL_REASON = "Cancelled by the freelancer.";

/** PayPal can only cancel a subscription the client has approved. */
const CANCELLABLE_IN_PAYPAL = new Set(["ACTIVE", "SUSPENDED"]);

export type CancelResult = "ok" | "not_found" | "already";

/**
 * Stops future charges and invoices. Invoices already open stay open: that money is still owed.
 * PayPal goes first, so a failure there leaves the retainer as it was.
 */
export const cancelRetainer = async (deps: RetainerFlowDeps, id: string): Promise<CancelResult> => {
  if (!isUuid(id)) return "not_found";
  const row = await deps.runAsUser((db) => loadSetup(db, id));
  if (!row) return "not_found";
  if (row.status === "cancelled" || row.status === "ended") return "already";
  if (row.paypal_subscription_id) {
    const remote = await deps.paypal.getSubscription(row.paypal_subscription_id);
    if (CANCELLABLE_IN_PAYPAL.has(remote.status)) {
      await deps.paypal.cancelSubscription(row.paypal_subscription_id, CANCEL_REASON);
    }
  }
  await deps.runAsUser(async (db) => {
    await db.query(
      "UPDATE public.retainers SET status = 'cancelled', paypal_approval_link = NULL WHERE id = $1",
      [id],
    );
    await db.query(
      `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
       VALUES ((SELECT auth.uid()), 'retainer', $1, 'retainer.cancelled', $2)`,
      [id, JSON.stringify({ by: "freelancer" })],
    );
  });
  logEvent("retainers.cancelled", { retainerId: id });
  return "ok";
};
