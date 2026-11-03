import { routeTask } from "./ai-router";
import { loadAiConnections, type AiConnection } from "./ai-settings";
import type { SecretBox } from "./crypto";
import type { UserDbRunner } from "./db";
import { checkedDraftSchema } from "./draft-checks";
import type { ReminderFacts } from "./draft-facts";
import { draftMessages } from "./draft-prompts";
import { draftTemplate } from "./draft-templates";
import { formatFullDay, formatMoney, formatPaymentTerms } from "./format";
import { logEvent } from "./log";
import { loadReminderContext, type ReminderContext } from "./reminder-context";
import { daysOverdue, type Tier } from "./schedule";
import type { StoredDraft } from "./stored-draft";

// Server-only: the drafter (02_drafter relays here). Builds the facts from the database, asks
// the AI router (local first, then cloud if allowed, then the fixed template), keeps only a
// draft that passes the schema and the content checks, and saves it on the reminder. Safe to
// re-run: a reminder that already has a draft, or was handled, is left alone.

export type DraftOutcome =
  | { status: "drafted"; draft: StoredDraft }
  | { status: "exists" }
  | { status: "not_found" }
  | { status: "handled" }
  | { status: "not_payable"; reason: string }
  | { status: "unsupported"; reason: string };

export type DrafterDeps = {
  runAsUser: (userId: string) => UserDbRunner;
  box: () => SecretBox;
  now: () => Date;
};

const PAYABLE = new Set(["sent", "partially_paid"]);
const CONTRACT_TERMS_MAX = 2000;

const notPayable = (ctx: ReminderContext): string | undefined => {
  const { invoice } = ctx;
  if (!PAYABLE.has(invoice.status)) return `the invoice is ${invoice.status.replace("_", " ")}`;
  if (invoice.amountCents - invoice.amountPaidCents <= 0) return "nothing is left to pay";
  return undefined;
};

export const reminderFacts = (
  ctx: ReminderContext,
  now: Date,
  payLink: string,
): ReminderFacts | undefined => {
  const { invoice, milestone, project } = ctx;
  if (!milestone || !project) return undefined;
  return {
    freelancerName: ctx.freelancerName,
    clientName: ctx.client.name,
    projectTitle: project.title,
    milestoneName: milestone.name,
    deliverable: milestone.deliverable,
    invoiceNumber: invoice.number,
    amountDue: formatMoney(invoice.amountCents - invoice.amountPaidCents, invoice.currency),
    dueDate: formatFullDay(invoice.dueDate),
    daysOverdue: daysOverdue(invoice.dueDate, now, ctx.client.timeZone),
    paymentTerms: formatPaymentTerms(ctx.settings.paymentTerms),
    contractTerms: project.contractTerms?.slice(0, CONTRACT_TERMS_MAX) ?? null,
    installment: invoice.installment
      ? `Installment ${String(invoice.installment.number)} of ${String(invoice.installment.count)}`
      : null,
    payLink,
    citation: null,
  };
};

type Ready = { kind: Tier; facts: ReminderFacts; connections: AiConnection[] };

const prepare = (
  deps: DrafterDeps,
  userId: string,
  reminderId: string,
  now: Date,
): Promise<DraftOutcome | Ready> =>
  deps.runAsUser(userId)(async (db): Promise<DraftOutcome | Ready> => {
    const ctx = await loadReminderContext(db, reminderId);
    if (!ctx) return { status: "not_found" };
    if (ctx.approvalStatus !== "waiting") return { status: "handled" };
    if (ctx.hasDraft) return { status: "exists" };
    const reason = notPayable(ctx);
    if (reason) return { status: "not_payable", reason };
    if (!ctx.invoice.link) return { status: "not_payable", reason: "the invoice has no pay link" };
    const facts = reminderFacts(ctx, now, ctx.invoice.link);
    if (!facts) return { status: "unsupported", reason: "retainer reminders are drafted from M8" };
    const task = ctx.tier === "tier3" ? "tier3" : "draft";
    return { kind: ctx.tier, facts, connections: await loadAiConnections(db, task, deps.box()) };
  });

const save = (
  deps: DrafterDeps,
  userId: string,
  reminderId: string,
  draft: StoredDraft,
): Promise<DraftOutcome> =>
  deps.runAsUser(userId)(async (db): Promise<DraftOutcome> => {
    // Only a still-waiting reminder with no draft: a second run (or a race) changes nothing.
    const { rowCount } = await db.query(
      `UPDATE public.reminders SET draft = $2
       WHERE id = $1 AND draft IS NULL AND approval_status = 'waiting'`,
      [reminderId, JSON.stringify(draft)],
    );
    if (rowCount === 0) return { status: "exists" };
    const payload = {
      tier: draft.kind,
      via: draft.via,
      model: draft.model,
      citation: draft.citation,
    };
    await db.query(
      `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
       VALUES ((SELECT auth.uid()), 'reminder', $1, 'reminder.drafted', $2)`,
      [reminderId, JSON.stringify(payload)],
    );
    return { status: "drafted", draft };
  });

export const draftReminder = async (
  deps: DrafterDeps,
  { userId, reminderId }: { userId: string; reminderId: string },
): Promise<DraftOutcome> => {
  const now = deps.now();
  const prepared = await prepare(deps, userId, reminderId, now);
  if ("status" in prepared) return prepared;
  const request = { kind: prepared.kind, facts: prepared.facts };
  // The model call runs outside any transaction: it can take a minute on a local model.
  const result = await routeTask(prepared.connections, {
    messages: draftMessages(request),
    schema: checkedDraftSchema(request),
    template: draftTemplate(request),
  });
  if (!result.ok) {
    throw new Error("The router gave no draft even with a template. Check draft-templates.ts.");
  }
  const { citation } = request.facts;
  const draft: StoredDraft = {
    ...result.output,
    kind: request.kind,
    via: result.via,
    model: result.via === "model" ? result.model : null,
    isLocal: result.via === "model" ? result.isLocal : null,
    citation: request.kind === "tier3" ? (citation?.kind ?? null) : null,
    lawId: request.kind === "tier3" && citation?.kind === "statute" ? citation.lawId : null,
    notLegalAdvice: request.kind === "tier3",
    draftedAt: now.toISOString(),
  };
  const outcome = await save(deps, userId, reminderId, draft);
  logEvent("drafter.done", {
    reminderId,
    status: outcome.status,
    via: result.via,
    attempts: result.attempts.length,
  });
  return outcome;
};
