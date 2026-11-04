import type { Db } from "./db";
import { isUuid } from "./db";
import { toCents } from "./db-values";
import { draftReminder, type DrafterDeps } from "./drafter";
import { formatDay } from "./format";
import { loadMilestoneContext } from "./invoice-context";
import { errorKind, logEvent } from "./log";
import { LIVE_HOLD_SQL, type HoldNoticeKind, type HoldStatus } from "./milestone-holds";
import { authorizeOnceApproved, PaypalError, type PaypalClient } from "./paypal";
import { holdDeadlineTooFar, holdWindow, invoiceDates, todayIn } from "./schedule";
import type { ServiceDbRunner } from "./service-db";

// Server-only: a milestone hold. PayPal is never called inside a transaction, each request id is
// saved before its call, and every step can be repeated: the scheduler finishes what a failure
// interrupted. Money only moves on capture, which needs the milestone Accepted.

export type HoldDeps = DrafterDeps & { runAsService: ServiceDbRunner; paypal: () => PaypalClient };

/** What following PayPal's own answers needs: no drafting, so a webhook can use these. */
export type HoldEventDeps = Pick<HoldDeps, "runAsService" | "paypal" | "now">;

export type HoldRow = {
  id: string;
  user_id: string;
  milestone_id: string;
  status: HoldStatus;
  amount_cents: string;
  currency: string;
  paypal_order_id: string | null;
  order_request_id: string;
  authorize_request_id: string;
  reauthorize_request_id: string;
  approval_link: string | null;
  authorization_id: string | null;
  authorized_at: Date | string | null;
  reauthorized_at: Date | string | null;
  capture_id: string | null;
  capture_failed_at: Date | string | null;
  invoice_id: string | null;
};

export const SELECT_HOLD = `
  SELECT h.id::text, h.user_id::text, h.milestone_id::text, h.status, h.amount_cents::text, h.currency,
    h.paypal_order_id, h.order_request_id::text, h.authorize_request_id::text,
    h.reauthorize_request_id::text, h.approval_link, h.authorization_id, h.authorized_at,
    h.reauthorized_at, h.capture_id, h.capture_failed_at, h.invoice_id::text
  FROM public.milestone_holds h`;

const loadLiveHold = async (db: Db, milestoneId: string): Promise<HoldRow | undefined> => {
  const { rows } = await db.query<HoldRow>(
    `${SELECT_HOLD} WHERE h.milestone_id = $1 AND h.status IN (${LIVE_HOLD_SQL})`,
    [milestoneId],
  );
  return rows[0];
};

const logHold = (db: Db, row: HoldRow, type: string, payload: object = {}) =>
  db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ($1, 'hold', $2, $3, $4)`,
    [row.user_id, row.id, type, JSON.stringify(payload)],
  );

const stopEmail = (db: Db, holdId: string) =>
  db.query(
    `UPDATE public.reminders SET approval_status = 'skipped', approved_via = NULL
     WHERE hold_id = $1 AND sent_at IS NULL AND send_attempted_at IS NULL
       AND approval_status IN ('waiting', 'approved')`,
    [holdId],
  );

const setNotice = (db: Db, holdId: string, kind: HoldNoticeKind) =>
  db.query("UPDATE public.milestone_holds SET notice_kind = $2 WHERE id = $1", [holdId, kind]);

// Starting ---------------------------------------------------------------------------------------

const STARTABLE = new Set(["planned", "in_progress"]);

export type StartResult =
  | { status: "started" | "already"; warning: string | null }
  | { status: "not_found" }
  | { status: "conflict"; message: string };

const farDeadlineWarning = (deadline: string, today: string): string | null =>
  holdDeadlineTooFar(deadline, today)
    ? `The deadline, ${formatDay(deadline)}, is more than 29 days away, and PayPal holds money for 29 days at most. The hold could expire before the work is accepted.`
    : null;

type Prepared =
  | { kind: "stop"; result: StartResult }
  | { kind: "go"; hold: HoldRow; description: string; warning: string | null };

const prepareStart = async (db: Db, milestoneId: string, now: Date): Promise<Prepared> => {
  const context = await loadMilestoneContext(db, milestoneId);
  if (!context) return { kind: "stop", result: { status: "not_found" } };
  const { milestone, project } = context;
  const today = todayIn(now, project.clientTimeZone);
  const warning = farDeadlineWarning(milestone.deadline, today);
  const live = await loadLiveHold(db, milestoneId);
  if (live && live.status !== "creating") {
    return { kind: "stop", result: { status: "already", warning } };
  }
  if (milestone.paymentMode !== "hold") {
    return {
      kind: "stop",
      result: { status: "conflict", message: "This milestone isn't set to Milestone hold." },
    };
  }
  if (!STARTABLE.has(milestone.status)) {
    return {
      kind: "stop",
      result: {
        status: "conflict",
        message:
          "A hold is authorized at the start of a milestone, and this one is past that. Change how it's paid to invoice it.",
      },
    };
  }
  const description = `${project.title}: ${milestone.name}`;
  if (live) return { kind: "go", hold: live, description, warning };
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.milestone_holds (user_id, milestone_id, amount_cents, currency)
     VALUES ((SELECT auth.uid()), $1, $2, $3) RETURNING id::text`,
    [milestoneId, milestone.cents, project.currency],
  );
  const created = await loadLiveHold(db, milestoneId);
  if (!rows[0] || !created) throw new Error("The new hold could not be read back after saving.");
  return { kind: "go", hold: created, description, warning };
};

/** The email asking the client to authorize. A draft for approval: nothing here can send. */
const draftHoldEmail = async (deps: HoldDeps, hold: HoldRow): Promise<void> => {
  const runAs = deps.runAsUser(hold.user_id);
  const reminderId = await runAs(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO public.reminders (user_id, hold_id, tier, scheduled_at)
       VALUES ((SELECT auth.uid()), $1, 'hold_approval', $2)
       ON CONFLICT (hold_id) WHERE sent_at IS NULL AND approval_status IN ('waiting', 'approved')
       DO NOTHING RETURNING id::text`,
      [hold.id, deps.now().toISOString()],
    );
    return rows[0]?.id;
  });
  if (!reminderId) return;
  try {
    await draftReminder(deps, { userId: hold.user_id, reminderId });
  } catch (error) {
    // The row stays with no draft, and the scheduler's next run writes it.
    logEvent("holds.email_failed", { holdId: hold.id, error: errorKind(error) });
  }
};

/** Creates the PayPal order, or finishes one that failed partway, and drafts the email. */
export const startHold = async (
  deps: HoldDeps,
  { userId, milestoneId }: { userId: string; milestoneId: string },
): Promise<StartResult> => {
  if (!isUuid(milestoneId)) return { status: "not_found" };
  const runAs = deps.runAsUser(userId);
  const prepared = await runAs((db) => prepareStart(db, milestoneId, deps.now()));
  if (prepared.kind === "stop") return prepared.result;
  const { hold, description, warning } = prepared;
  const order = await deps.paypal().createHoldOrder({
    requestId: hold.order_request_id,
    amountCents: toCents(hold.amount_cents),
    currency: hold.currency,
    description,
  });
  await runAs(async (db) => {
    await db.query(
      `UPDATE public.milestone_holds
       SET status = 'pending_approval', paypal_order_id = $2, approval_link = $3
       WHERE id = $1 AND status = 'creating'`,
      [hold.id, order.id, order.approvalLink],
    );
    await logHold(db, hold, "hold.started", { amountCents: toCents(hold.amount_cents) });
  });
  await draftHoldEmail(deps, hold);
  logEvent("holds.started", { holdId: hold.id });
  return { status: "started", warning };
};

// Authorizing ------------------------------------------------------------------------------------

/** The client approved, per PayPal's own copy of the order: authorize. Safe to repeat. */
export const authorizeIfApproved = async (deps: HoldEventDeps, hold: HoldRow): Promise<boolean> => {
  if (hold.status !== "pending_approval" || !hold.paypal_order_id) return false;
  const authorizationId = await authorizeOnceApproved(
    deps.paypal(),
    hold.paypal_order_id,
    hold.authorize_request_id,
  );
  if (!authorizationId) return false;
  return deps.runAsService(async (db) => {
    // Voided while PayPal was being asked: the scheduler or a person will see the authorization.
    const { rowCount } = await db.query(
      `UPDATE public.milestone_holds
       SET status = 'authorized', authorization_id = $2, authorized_at = $3, approval_link = NULL,
         notice_kind = 'authorized'
       WHERE id = $1 AND status = 'pending_approval'`,
      [hold.id, authorizationId, deps.now().toISOString()],
    );
    if (rowCount === 0) return false;
    await stopEmail(db, hold.id);
    await logHold(db, hold, "hold.authorized");
    return true;
  });
};

// Capturing --------------------------------------------------------------------------------------

/** The money is in: the hold, the invoice recording it, and the milestone. Run once per hold. */
const recordCaptured = async (db: Db, hold: HoldRow, captureId: string): Promise<void> => {
  const { rowCount } = await db.query(
    `UPDATE public.milestone_holds
     SET status = 'captured', capture_id = $2, notice_kind = 'captured', capture_failed_at = NULL
     WHERE id = $1 AND status IN ('authorized', 'capturing')`,
    [hold.id, captureId],
  );
  if (rowCount === 0) return;
  await db.query(
    `UPDATE public.invoices SET status = 'paid', amount_paid_cents = amount_cents
     WHERE id = (SELECT invoice_id FROM public.milestone_holds WHERE id = $1)`,
    [hold.id],
  );
  await db.query(
    "UPDATE public.milestones SET status = 'paid' WHERE id = $1 AND status = 'accepted'",
    [hold.milestone_id],
  );
  await logHold(db, hold, "hold.captured", { amountCents: toCents(hold.amount_cents) });
};

const recordDenied = async (db: Db, hold: HoldRow): Promise<void> => {
  const { rowCount } = await db.query(
    `UPDATE public.milestone_holds SET status = 'failed', notice_kind = 'capture_denied'
     WHERE id = $1 AND status IN ('authorized', 'capturing')`,
    [hold.id],
  );
  if (rowCount === 0) return;
  await cancelDraftInvoice(db, hold);
  await logHold(db, hold, "hold.capture_denied");
};

const cancelDraftInvoice = (db: Db, hold: HoldRow) =>
  db.query(
    `UPDATE public.invoices SET status = 'cancelled'
     WHERE id = (SELECT invoice_id FROM public.milestone_holds WHERE id = $1) AND status = 'draft'`,
    [hold.id],
  );

/** PayPal's answer about a capture, wherever it came from. */
export const applyCaptureStatus = async (
  deps: HoldEventDeps,
  hold: HoldRow,
  captureId: string,
  status: string,
): Promise<"captured" | "pending" | "denied"> =>
  deps.runAsService(async (db) => {
    if (status === "COMPLETED") {
      await recordCaptured(db, hold, captureId);
      return "captured";
    }
    if (status === "PENDING") {
      await db.query(
        `UPDATE public.milestone_holds SET status = 'capturing', capture_id = $2
         WHERE id = $1 AND status IN ('authorized', 'capturing')`,
        [hold.id, captureId],
      );
      return "pending";
    }
    await recordDenied(db, hold);
    return "denied";
  });

/** The invoice recording this payment. Its number goes to PayPal, and its request id keys the call. */
const ensureInvoice = async (
  db: Db,
  hold: HoldRow,
  now: Date,
): Promise<{ invoiceNumber: string; requestId: string }> => {
  const { rows: existing } = await db.query<{ invoice_number: string; paypal_request_id: string }>(
    `SELECT i.invoice_number, i.paypal_request_id::text FROM public.invoices i
     JOIN public.milestone_holds h ON h.invoice_id = i.id WHERE h.id = $1`,
    [hold.id],
  );
  if (existing[0]) {
    return { invoiceNumber: existing[0].invoice_number, requestId: existing[0].paypal_request_id };
  }
  const context = await loadMilestoneContext(db, hold.milestone_id);
  if (!context) throw new Error("The hold's milestone could not be read.");
  const { dueDate } = invoiceDates({ kind: "on_receipt" }, now, context.project.clientTimeZone);
  const { rows } = await db.query<{
    id: string;
    invoice_number: string;
    paypal_request_id: string;
  }>(
    `INSERT INTO public.invoices (user_id, milestone_id, paypal_order_id, amount_cents, currency, due_date)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id::text, invoice_number, paypal_request_id::text`,
    [
      hold.user_id,
      hold.milestone_id,
      hold.paypal_order_id,
      toCents(hold.amount_cents),
      hold.currency,
      dueDate,
    ],
  );
  const invoice = rows[0];
  if (!invoice) throw new Error("Saving the hold's invoice returned no row.");
  await db.query("UPDATE public.milestone_holds SET invoice_id = $2 WHERE id = $1", [
    hold.id,
    invoice.id,
  ]);
  return { invoiceNumber: invoice.invoice_number, requestId: invoice.paypal_request_id };
};

/** Past day 3: a fresh authorization, if PayPal allows it. A refusal doesn't stop the capture. */
const reauthorizeIfDue = async (
  deps: HoldDeps,
  paypal: PaypalClient,
  hold: HoldRow,
  now: Date,
): Promise<string> => {
  const current = hold.authorization_id ?? "";
  if (!hold.authorized_at) return current;
  const { pastHonor } = holdWindow({
    authorizedAt: new Date(hold.authorized_at),
    reauthorizedAt: hold.reauthorized_at === null ? null : new Date(hold.reauthorized_at),
    now,
  });
  if (!pastHonor) return current;
  try {
    const { authorizationId } = await paypal.reauthorize(current, {
      requestId: hold.reauthorize_request_id,
      amountCents: toCents(hold.amount_cents),
      currency: hold.currency,
    });
    await deps.runAsService(async (db) => {
      await db.query(
        `UPDATE public.milestone_holds
         SET authorization_id = $2, reauthorized_at = $3, reauthorize_request_id = gen_random_uuid()
         WHERE id = $1`,
        [hold.id, authorizationId, now.toISOString()],
      );
      await logHold(db, hold, "hold.reauthorized");
    });
    return authorizationId;
  } catch (error) {
    if (!(error instanceof PaypalError)) throw error;
    logEvent("holds.reauthorize_refused", {
      holdId: hold.id,
      status: error.status,
      issue: error.issue,
    });
    return current;
  }
};

const expireHold = (deps: HoldDeps, hold: HoldRow) =>
  deps.runAsService(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE public.milestone_holds SET status = 'expired', notice_kind = 'expired'
       WHERE id = $1 AND status = 'authorized'`,
      [hold.id],
    );
    if (rowCount === 0) return;
    await cancelDraftInvoice(db, hold);
    await logHold(db, hold, "hold.expired");
  });

const noteCaptureFailed = (deps: HoldDeps, hold: HoldRow, now: Date) =>
  deps.runAsService(async (db) => {
    // Told once, however many times the scheduler retries.
    const { rowCount } = await db.query(
      `UPDATE public.milestone_holds SET capture_failed_at = $2
       WHERE id = $1 AND capture_failed_at IS NULL`,
      [hold.id, now.toISOString()],
    );
    if (rowCount > 0) await setNotice(db, hold.id, "capture_failed");
  });

export type CaptureResult =
  | { status: "captured" | "pending" | "denied" | "expired" | "no_hold" | "not_accepted" }
  | { status: "refused"; message: string };

/** Capture on acceptance. Reauthorizes first if it's past day 3. Never more than the hold's amount. */
export const captureHold = async (
  deps: HoldDeps,
  { userId, milestoneId }: { userId: string; milestoneId: string },
): Promise<CaptureResult> => {
  const now = deps.now();
  const loaded = await deps.runAsUser(userId)(async (db) => {
    const hold = await loadLiveHold(db, milestoneId);
    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM public.milestones WHERE id = $1",
      [milestoneId],
    );
    return { hold, milestoneStatus: rows[0]?.status };
  });
  const { hold, milestoneStatus } = loaded;
  if (hold?.status !== "authorized" || !hold.authorization_id || !hold.authorized_at) {
    return { status: hold?.status === "capturing" ? "pending" : "no_hold" };
  }
  if (milestoneStatus !== "accepted") return { status: "not_accepted" };
  const { expired } = holdWindow({
    authorizedAt: new Date(hold.authorized_at),
    reauthorizedAt: hold.reauthorized_at === null ? null : new Date(hold.reauthorized_at),
    now,
  });
  if (expired) {
    await expireHold(deps, hold);
    return { status: "expired" };
  }
  const paypal = deps.paypal();
  const invoice = await deps.runAsService((db) => ensureInvoice(db, hold, now));
  try {
    const authorizationId = await reauthorizeIfDue(deps, paypal, hold, now);
    const capture = await paypal.captureAuthorization(authorizationId, invoice);
    const status = await applyCaptureStatus(deps, hold, capture.id, capture.status);
    logEvent("holds.capture", { holdId: hold.id, status });
    return { status };
  } catch (error) {
    if (!(error instanceof PaypalError)) throw error;
    logEvent("holds.capture_refused", {
      holdId: hold.id,
      status: error.status,
      issue: error.issue,
    });
    await noteCaptureFailed(deps, hold, now);
    return { status: "refused", message: error.message };
  }
};

// Voiding ----------------------------------------------------------------------------------------

export type VoidResult =
  { status: "voided" } | { status: "not_found" } | { status: "conflict"; message: string };

const recordVoided = async (db: Db, hold: HoldRow, notice?: HoldNoticeKind): Promise<void> => {
  await db.query("UPDATE public.milestone_holds SET status = 'voided' WHERE id = $1", [hold.id]);
  if (notice) await setNotice(db, hold.id, notice);
  await stopEmail(db, hold.id);
  await cancelDraftInvoice(db, hold);
  await logHold(db, hold, "hold.voided", { by: notice ? "paypal" : "freelancer" });
};

/** Releases the money. PayPal goes first, so a failure there leaves the hold as it was. */
export const voidHold = async (
  deps: HoldDeps,
  { userId, milestoneId }: { userId: string; milestoneId: string },
): Promise<VoidResult> => {
  if (!isUuid(milestoneId)) return { status: "not_found" };
  const runAs = deps.runAsUser(userId);
  const loaded = await runAs(async (db) => {
    const { rows } = await db.query("SELECT 1 FROM public.milestones WHERE id = $1", [milestoneId]);
    return { exists: rows.length > 0, hold: await loadLiveHold(db, milestoneId) };
  });
  if (!loaded.exists) return { status: "not_found" };
  const { hold } = loaded;
  if (!hold) return { status: "conflict", message: "There's no hold in progress to void." };
  if (hold.status === "capturing") {
    return {
      status: "conflict",
      message: "PayPal is finishing the capture, so this can't be voided.",
    };
  }
  if (hold.status === "authorized" && hold.authorization_id) {
    await deps.paypal().voidAuthorization(hold.authorization_id);
  }
  await deps.runAsService((db) => recordVoided(db, hold));
  logEvent("holds.voided", { holdId: hold.id });
  return { status: "voided" };
};

/** PayPal's own copy says it's voided, for instance from its site. */
export const applyVoidedInPaypal = (deps: HoldEventDeps, hold: HoldRow): Promise<boolean> =>
  deps.runAsService(async (db) => {
    if (hold.status !== "authorized") return false;
    await recordVoided(db, hold, "voided_in_paypal");
    return true;
  });

// The scheduler ----------------------------------------------------------------------------------

const RUN_LIMIT = 100;

type RunRow = HoldRow & { milestone_status: string };

const continueOne = async (deps: HoldDeps, hold: RunRow): Promise<void> => {
  if (hold.status === "pending_approval") {
    await authorizeIfApproved(deps, hold);
    return;
  }
  if (hold.status === "capturing" && hold.capture_id) {
    const capture = await deps.paypal().getCapture(hold.capture_id);
    await applyCaptureStatus(deps, hold, hold.capture_id, capture.status);
    return;
  }
  if (hold.status !== "authorized" || !hold.authorized_at) return;
  const { expired } = holdWindow({
    authorizedAt: new Date(hold.authorized_at),
    reauthorizedAt: hold.reauthorized_at === null ? null : new Date(hold.reauthorized_at),
    now: deps.now(),
  });
  if (expired) {
    await expireHold(deps, hold);
    return;
  }
  if (hold.milestone_status === "accepted") {
    await captureHold(deps, { userId: hold.user_id, milestoneId: hold.milestone_id });
  }
};

/** Finishes what a lost webhook or a PayPal failure interrupted, and expires what's run out. */
export const runHolds = async (deps: HoldDeps): Promise<void> => {
  const holds = await deps.runAsService(async (db) => {
    const { rows } = await db.query<RunRow>(
      `SELECT h.id::text, h.user_id::text, h.milestone_id::text, h.status, h.amount_cents::text,
         h.currency, h.paypal_order_id, h.order_request_id::text, h.authorize_request_id::text,
         h.reauthorize_request_id::text, h.approval_link, h.authorization_id, h.authorized_at,
         h.reauthorized_at, h.capture_id, h.capture_failed_at, h.invoice_id::text,
         m.status AS milestone_status
       FROM public.milestone_holds h JOIN public.milestones m ON m.id = h.milestone_id
       WHERE h.status IN ('pending_approval', 'authorized', 'capturing')
       ORDER BY h.created_at LIMIT ${String(RUN_LIMIT)}`,
    );
    return rows;
  });
  for (const hold of holds) {
    try {
      await continueOne(deps, hold);
    } catch (error) {
      logEvent("holds.run_failed", { holdId: hold.id, error: errorKind(error) });
    }
  }
};
