import type { Db } from "./db";
import { draftProblems } from "./draft-checks";
import { notPayable, reminderFacts } from "./drafter";
import type { Law } from "./legal";
import { loadReminderContext, type ReminderContext } from "./reminder-context";
import { rescheduledSendAt } from "./schedule";
import { storedDraftSchema, type StoredDraft } from "./stored-draft";

// Server-only: what a freelancer can do to a draft. Each runs as them (RLS), in one transaction,
// and each UPDATE repeats the state it checked, so of two racing decisions only the first counts.

export type ActionResult =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "conflict"; message: string }
  | { status: "invalid"; message: string };

const OK: ActionResult = { status: "ok" };
const NOT_FOUND: ActionResult = { status: "not_found" };

const conflict = (message: string): ActionResult => ({ status: "conflict", message });

export const ALREADY_HANDLED = conflict(
  "This draft was already handled, here or on Telegram. Refresh to see where it is now.",
);
const FAILED_CHECKS = conflict(
  "This draft failed its checks, so it can't be sent. Skip it; the next reminder gets a new draft.",
);

type State = {
  draft: unknown;
  approval_status: "waiting" | "approved" | "skipped";
  sent_at: unknown;
};

const loadState = async (db: Db, id: string): Promise<State | undefined> => {
  const { rows } = await db.query<State>(
    "SELECT draft, approval_status, sent_at FROM public.reminders WHERE id = $1 AND draft IS NOT NULL",
    [id],
  );
  return rows[0];
};

const record = (db: Db, id: string, type: string, payload: object = {}) =>
  db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ((SELECT auth.uid()), 'reminder', $1, $2, $3)`,
    [id, type, JSON.stringify(payload)],
  );

/** A reason this draft can't go to the client now, or undefined when it can. */
const cannotSend = (ctx: ReminderContext, draft: StoredDraft): string | undefined => {
  const reason = notPayable(ctx);
  if (reason) return `This draft can't go out: ${reason}. Skip it.`;
  if (!ctx.invoice.link || !draft.body.includes(ctx.invoice.link)) {
    return "This draft doesn't carry the invoice's pay link. Edit it to include the link.";
  }
  return undefined;
};

/** A claimed send can't be changed under the sender, unless nobody knows how it ended. */
const NOT_ON_ITS_WAY = "(send_attempted_at IS NULL OR send_blocked_reason = 'unknown_outcome')";

export type DecidedVia = "outbox" | "telegram";

export const approveDraft = async (
  db: Db,
  id: string,
  via: DecidedVia = "outbox",
): Promise<ActionResult> => {
  const state = await loadState(db, id);
  if (!state) return NOT_FOUND;
  if (state.approval_status !== "waiting") return ALREADY_HANDLED;
  const draft = storedDraftSchema.safeParse(state.draft);
  if (!draft.success) return FAILED_CHECKS;
  const ctx = await loadReminderContext(db, id);
  if (!ctx) return NOT_FOUND;
  const reason = cannotSend(ctx, draft.data);
  if (reason) return conflict(reason);
  const { rowCount } = await db.query(
    `UPDATE public.reminders SET approval_status = 'approved', approved_via = $2
     WHERE id = $1 AND approval_status = 'waiting'`,
    [id, via],
  );
  if (rowCount === 0) return ALREADY_HANDLED;
  await record(db, id, "reminder.approved", { via });
  return OK;
};

/** Also stops an approved draft that hasn't gone out yet. */
export const skipDraft = async (
  db: Db,
  id: string,
  via: DecidedVia = "outbox",
): Promise<ActionResult> => {
  const { rowCount } = await db.query(
    `UPDATE public.reminders SET approval_status = 'skipped', approved_via = NULL
     WHERE id = $1 AND draft IS NOT NULL AND sent_at IS NULL
       AND approval_status IN ('waiting', 'approved') AND ${NOT_ON_ITS_WAY}`,
    [id],
  );
  if (rowCount === 0) return (await loadState(db, id)) ? ALREADY_HANDLED : NOT_FOUND;
  await record(db, id, "reminder.skipped", { via });
  return OK;
};

/**
 * Saves new wording for a waiting draft, under the same checks as the AI's: it keeps the pay
 * link, adds no other link or amount, and cites only what Tier 3 was given.
 */
export const editDraft = async (
  db: Db,
  id: string,
  edit: { subject: string; body: string },
  { now, laws }: { now: Date; laws: readonly Law[] },
): Promise<ActionResult> => {
  const state = await loadState(db, id);
  if (!state) return NOT_FOUND;
  if (state.approval_status !== "waiting") return ALREADY_HANDLED;
  const current = storedDraftSchema.safeParse(state.draft);
  if (!current.success) return FAILED_CHECKS;
  const ctx = await loadReminderContext(db, id);
  if (!ctx) return NOT_FOUND;
  const reason = notPayable(ctx);
  if (reason || !ctx.invoice.link) {
    return conflict(
      `This draft can't go out: ${reason ?? "the invoice has no pay link"}. Skip it.`,
    );
  }
  const facts = reminderFacts(ctx, now, ctx.invoice.link, laws);
  if (!facts) return conflict("Retainer reminders can't be edited yet. Skip this one.");
  const problems = draftProblems(edit, { kind: ctx.tier, facts }, laws);
  if (problems.length > 0) {
    return {
      status: "invalid",
      message: `Not saved: ${problems.join("; ")}. Fix it and save again.`,
    };
  }
  const { subject, body } = edit;
  const updated: StoredDraft = { ...current.data, subject, body, editedAt: now.toISOString() };
  const { rowCount } = await db.query(
    `UPDATE public.reminders SET draft = $2, telegram_card_stale = telegram_message_id IS NOT NULL
     WHERE id = $1 AND approval_status = 'waiting'`,
    [id, JSON.stringify(updated)],
  );
  if (rowCount === 0) return ALREADY_HANDLED;
  await record(db, id, "reminder.edited", { via: "outbox" });
  return OK;
};

/** The freelancer checked their Sent mail after an unknown outcome, and wants it sent. */
export const retrySend = async (db: Db, id: string): Promise<ActionResult> => {
  const { rowCount } = await db.query(
    `UPDATE public.reminders SET send_attempted_at = NULL, send_blocked_reason = NULL
     WHERE id = $1 AND approval_status = 'approved' AND sent_at IS NULL
       AND send_blocked_reason = 'unknown_outcome'`,
    [id],
  );
  if (rowCount === 0) {
    return (await loadState(db, id))
      ? conflict("This send isn't waiting on a decision. Refresh to see where it is now.")
      : NOT_FOUND;
  }
  await record(db, id, "reminder.send_retried", { via: "outbox" });
  return OK;
};

/** Moves a draft that hasn't gone out; its approval stays as it was. */
export const rescheduleDraft = async (
  db: Db,
  id: string,
  at: string,
  now: Date,
): Promise<ActionResult> => {
  const state = await loadState(db, id);
  if (!state) return NOT_FOUND;
  if (state.approval_status === "skipped" || state.sent_at !== null) return ALREADY_HANDLED;
  const ctx = await loadReminderContext(db, id);
  if (!ctx) return NOT_FOUND;
  const sendAt = rescheduledSendAt(at, now, ctx.settings.sendWindow, ctx.client.timeZone);
  if (!sendAt) {
    return { status: "invalid", message: "Pick a date and time in the future, then save again." };
  }
  const { rowCount } = await db.query(
    `UPDATE public.reminders SET scheduled_at = $2,
       telegram_card_stale = telegram_message_id IS NOT NULL AND approval_status = 'waiting'
     WHERE id = $1 AND sent_at IS NULL AND approval_status IN ('waiting', 'approved')
       AND ${NOT_ON_ITS_WAY}`,
    [id, sendAt.toISOString()],
  );
  if (rowCount === 0) return ALREADY_HANDLED;
  await record(db, id, "reminder.rescheduled", { to: sendAt.toISOString() });
  return OK;
};
