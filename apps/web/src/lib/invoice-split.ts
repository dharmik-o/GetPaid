import { z } from "zod";
import { isUuid, type Db } from "./db";
import type { FieldIssue } from "./field-issues";
import { loadMilestoneContext, type MilestoneContext } from "./invoice-context";
import { cancelInPaypal } from "./invoice-cancel";
import {
  conflict,
  documentChoice,
  makePdf,
  NOT_FOUND,
  readBack,
  sendThroughPaypal,
  draftFor,
  type FlowDeps,
} from "./invoice-flow";
import { insertPlan, setPlanStatus } from "./installment-plans";
import {
  checkInstallments,
  MAX_INSTALLMENTS,
  parseInstallmentItems,
  splitEvenly,
  type InstallmentItem,
} from "./installments";
import {
  insertDraftInvoice,
  listOpenInvoices,
  markCancelled,
  markSent,
  type InvoiceRecord,
  type InvoiceView,
} from "./invoices";
import { logEvent } from "./log";
import { addCalendarDays, invoiceDates, todayIn } from "./schedule";

// Server-only: a client asked to pay in parts and the freelancer approved a split of the unpaid
// remainder. In one step, the open unpaid invoices are cancelled and the installment invoices are
// created. An invoice with money on it is never cancelled, and neither PayPal nor a reply can
// change that: the amounts are the freelancer's, checked against what's really unpaid. PayPal is
// never called inside a transaction, and a retry after any failure resumes the same plan.

export type SplitResult =
  | { ok: true; invoices: InvoiceView[] }
  | { ok: false; errors: FieldIssue[] }
  | { ok: false; notFound: true }
  | { ok: false; conflict: string };

const DEFAULT_COUNT = 2;
const DAYS_TO_SECOND = 14;

const NOTHING_UNPAID =
  "There's nothing unpaid left on this milestone to split. Refresh to see where it is now.";
const ALREADY_SPLIT =
  "This reply was already handled, here or on Telegram. Refresh to see where it is now.";
const PAID_MEANWHILE =
  "PayPal says the client has already paid one of these invoices, so nothing was cancelled. Wait for the payment to show here, then split what's left.";

/**
 * The first offer: two even parts, due today and on the date the client named, or two weeks on.
 * The freelancer edits it. Only the date can come from the AI's reading, and only as an offer.
 */
export const proposedSplit = (
  remainderCents: number,
  today: string,
  lastDate: string | null = null,
): InstallmentItem[] =>
  splitEvenly(remainderCents, DEFAULT_COUNT).map((amountCents, index) => ({
    amountCents,
    dueDate: index === 0 ? today : (lastDate ?? addCalendarDays(today, DAYS_TO_SECOND)),
  }));

const isUnpaid = (record: InvoiceRecord): boolean =>
  (record.status === "draft" || record.status === "sent") && record.amountPaidCents === 0;

/** The unpaid remainder a split must add up to. */
export const unpaidRemainder = (records: readonly InvoiceRecord[]): number =>
  records.filter(isUnpaid).reduce((sum, record) => sum + record.amountCents, 0);

const replySchema = z.object({
  milestone_id: z.string(),
  review_status: z.string().nullable(),
  split_plan_id: z.string().nullable(),
  thread_id: z.string().nullable(),
});

type Reply = z.infer<typeof replySchema>;

const loadReply = async (db: Db, id: string): Promise<Reply | undefined> => {
  const { rows } = await db.query(
    `SELECT i.milestone_id::text, msg.review_status, msg.split_plan_id::text, msg.thread_id
     FROM public.messages msg JOIN public.invoices i ON i.id = msg.invoice_id
     WHERE msg.id = $1 AND msg.direction = 'in' AND msg.review_status IS NOT NULL
       AND i.milestone_id IS NOT NULL`,
    [id],
  );
  return rows[0] ? replySchema.parse(rows[0]) : undefined;
};

type Checked =
  | {
      ok: true;
      context: MilestoneContext;
      reply: Reply;
      unpaid: InvoiceRecord[];
      items: InstallmentItem[];
      /** How many installments are already settled: new ones are numbered after them. */
      offset: number;
    }
  | { ok: false; result: SplitResult };

const fail = (result: SplitResult): { ok: false; result: SplitResult } => ({ ok: false, result });

/** One transaction: is this reply still open, and does this split fit what's really unpaid? */
const check = (deps: FlowDeps, replyId: string, raw: unknown): Promise<Checked> =>
  deps.runAsUser(async (db): Promise<Checked> => {
    const reply = await loadReply(db, replyId);
    if (!reply) return fail(NOT_FOUND);
    if (reply.review_status !== "pending") return fail(conflict(ALREADY_SPLIT));
    const context = await loadMilestoneContext(db, reply.milestone_id);
    if (!context) return fail(NOT_FOUND);
    const unpaid = context.open.filter(isUnpaid);
    const parsed = parseInstallmentItems(raw);
    if (reply.split_plan_id) {
      // Picking up after a failure: the plan is saved, and only sending is left.
      return { ok: true, context, reply, unpaid, items: [], offset: 0 };
    }
    if (unpaid.length === 0) return fail(conflict(NOTHING_UNPAID));
    if (!parsed.ok) return fail({ ok: false, errors: parsed.errors });
    const settled = context.open.filter((record) => !isUnpaid(record));
    const offset = Math.max(0, ...settled.map((record) => record.installment?.number ?? 0));
    if (offset + parsed.items.length > MAX_INSTALLMENTS) {
      return fail({
        ok: false,
        errors: [
          {
            field: "items",
            message: `can't go past ${String(MAX_INSTALLMENTS)} installments, counting the ${String(offset)} already settled`,
          },
        ],
      });
    }
    const errors = checkInstallments(parsed.items, {
      totalCents: unpaidRemainder(context.open),
      currency: context.project.currency,
      datesRequired: true,
      today: todayIn(deps.now, context.project.clientTimeZone),
    });
    if (errors.length > 0) return fail({ ok: false, errors });
    return { ok: true, context, reply, unpaid, items: parsed.items, offset };
  });

/** Asks PayPal about every invoice first, so one paid invoice stops the whole split. */
const cancelAllInPaypal = async (
  deps: FlowDeps,
  unpaid: readonly InvoiceRecord[],
): Promise<string | undefined> => {
  for (const record of unpaid) {
    if (!record.paypalInvoiceId) continue;
    const remote = await deps.paypal.getInvoice(record.paypalInvoiceId);
    if (!["DRAFT", "SENT", "UNPAID", "SCHEDULED", "CANCELLED"].includes(remote.status)) {
      return PAID_MEANWHILE;
    }
  }
  for (const record of unpaid) {
    const refused = await cancelInPaypal(deps, record, PAID_MEANWHILE);
    if (refused) return refused;
  }
  return undefined;
};

/** One transaction: the old invoices cancelled, and the plan and new draft invoices saved. */
const replaceRows = (
  deps: FlowDeps,
  replyId: string,
  checked: Extract<Checked, { ok: true }>,
): Promise<void> =>
  deps.runAsUser(async (db) => {
    const { context, reply, unpaid, items, offset } = checked;
    const restoreTo =
      unpaid.find((record) => record.milestoneStatusBefore)?.milestoneStatusBefore ?? "accepted";
    for (const record of unpaid) await markCancelled(db, record, restoreTo);
    if (context.plan) await setPlanStatus(db, context.plan.id, "cancelled");
    const remainder = items.reduce((sum, item) => sum + item.amountCents, 0);
    const plan = await insertPlan(db, {
      milestoneId: context.milestone.id,
      totalCents: remainder,
      currency: context.project.currency,
      items,
      createdFrom: "client_request",
    });
    const document = await documentChoice(db, context, {});
    if (!document.ok) throw new Error("The default invoice text failed its own checks.");
    const dates = invoiceDates(context.terms, deps.now, context.project.clientTimeZone);
    let number = offset;
    for (const item of items) {
      number += 1;
      await insertDraftInvoice(db, {
        ...document.choice,
        milestoneId: context.milestone.id,
        amountCents: item.amountCents,
        currency: context.project.currency,
        dueDate: item.dueDate ?? dates.dueDate,
        milestoneStatusBefore: restoreTo,
        installment: { number, count: offset + items.length, planId: plan.id },
      });
    }
    // The client keeps one conversation: the new invoices stay on the same thread and subject.
    await db.query(
      `UPDATE public.invoices new SET gmail_thread_id = old.gmail_thread_id,
         gmail_thread_subject = old.gmail_thread_subject
       FROM (SELECT gmail_thread_id, gmail_thread_subject FROM public.invoices WHERE id = $1) old
       WHERE new.installment_plan_id = $2`,
      [unpaid[0]?.id, plan.id],
    );
    await db.query("UPDATE public.messages SET split_plan_id = $2 WHERE id = $1", [
      replyId,
      plan.id,
    ]);
    await db.query(
      `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
       VALUES ((SELECT auth.uid()), 'invoice', $1, 'invoice.split', $2)`,
      [
        unpaid[0]?.id,
        JSON.stringify({
          count: items.length,
          totalCents: remainder,
          createdFrom: "client_request",
        }),
      ],
    );
    logEvent("replies.split_saved", { milestoneId: reply.milestone_id, count: items.length });
  });

/** Creates and sends each new invoice still in draft. Safe to repeat. */
const sendNew = async (deps: FlowDeps, milestoneId: string): Promise<SplitResult> => {
  const loaded = await deps.runAsUser(async (db) => {
    const context = await loadMilestoneContext(db, milestoneId);
    return context
      ? {
          context,
          issuedOn: invoiceDates(context.terms, deps.now, context.project.clientTimeZone).issuedOn,
        }
      : undefined;
  });
  if (!loaded) return NOT_FOUND;
  const { context, issuedOn } = loaded;
  const plan = context.plan;
  const records = context.open.filter(
    (record) => plan !== undefined && record.installmentPlanId === plan.id,
  );
  for (const record of records) {
    if (record.status !== "draft") continue;
    const sent = await sendThroughPaypal(deps, record, draftFor(record, context, issuedOn));
    if (!sent.ok) return sent;
    await deps.runAsUser((db) => markSent(db, record, sent.link));
    await makePdf(deps, record.id);
  }
  return {
    ok: true,
    invoices: await readBack(
      deps,
      records.map((record) => record.id),
    ),
  };
};

const finish = (deps: FlowDeps, replyId: string) =>
  deps.runAsUser(async (db) => {
    await db.query(
      `UPDATE public.messages SET review_status = 'done', reviewed_at = $2, reviewed_action = 'split'
       WHERE id = $1 AND review_status = 'pending'`,
      [replyId, deps.now.toISOString()],
    );
  });

export const replaceWithInstallments = async (
  deps: FlowDeps,
  replyId: string,
  raw: unknown,
): Promise<SplitResult> => {
  if (!isUuid(replyId)) return NOT_FOUND;
  const checked = await check(deps, replyId, raw);
  if (!checked.ok) return checked.result;
  const { reply } = checked;
  if (!reply.split_plan_id) {
    const refused = await cancelAllInPaypal(deps, checked.unpaid);
    if (refused) return conflict(refused);
    await replaceRows(deps, replyId, checked);
  }
  const result = await sendNew(deps, reply.milestone_id);
  if (result.ok) await finish(deps, replyId);
  return result;
};

/** What a pending reply's split starts from: the remainder and the first offer. */
export const splitOffer = async (
  db: Db,
  milestoneId: string,
  today: string,
  lastDate: string | null,
): Promise<{ remainderCents: number; items: InstallmentItem[] } | undefined> => {
  const records = await listOpenInvoices(db, milestoneId);
  const remainderCents = unpaidRemainder(records);
  if (remainderCents < 2) return undefined;
  return { remainderCents, items: proposedSplit(remainderCents, today, lastDate) };
};
