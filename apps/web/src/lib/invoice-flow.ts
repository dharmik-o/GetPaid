import { isUuid, type Db, type UserDbRunner } from "./db";
import { toFieldIssues, type FieldIssue } from "./field-issues";
import { BEFORE_INVOICE, loadMilestoneContext, type MilestoneContext } from "./invoice-context";
import {
  alreadyInvoiced,
  issueBodySchema,
  issueTargets,
  requestedNumbers,
  type IssueBody,
  type Target,
} from "./invoice-targets";
import { insertPlan } from "./installment-plans";
import { installmentText } from "./installments";
import {
  getInvoiceRecord,
  insertDraftInvoice,
  listOpenInvoices,
  markSent,
  recordPaypalId,
  toView,
  type InvoiceRecord,
  type InvoiceView,
} from "./invoices";
import type { InvoiceDraft, PaypalClient } from "./paypal";
import { invoiceDates } from "./schedule";
import type { InvoiceText } from "./ai-schemas";
import { getFreelancerDetails } from "./invoice-details";
import { invoiceTextIssues, invoiceTextTemplate, textFactsFor } from "./invoice-text";
import { getTemplate, resolveTemplateId } from "./invoice-templates";
import { errorKind, logEvent } from "./log";

// Server-only: one PayPal invoice per milestone, or one per installment: create and send.
// Rows (with their request ids and invoice numbers) are committed before PayPal is called, and
// PayPal is never called inside a transaction, so a retry after any failure resumes the same
// invoices instead of creating new ones. Never PayPal partial payments.

export type FlowDeps = {
  runAsUser: UserDbRunner;
  paypal: PaypalClient;
  now: Date;
  /** Makes and stores an invoice's PDF; a failure is logged and never undoes the invoice. */
  pdf?: (invoiceId: string) => Promise<unknown>;
};

export type InvoiceResult =
  | { ok: true; invoices: InvoiceView[]; sentNow: boolean }
  | { ok: false; errors: FieldIssue[] }
  | { ok: false; notFound: true }
  | { ok: false; conflict: string };

export const NOT_FOUND = { ok: false, notFound: true } as const;

export const conflict = (message: string) => ({ ok: false, conflict: message }) as const;

type Prepared =
  | { ok: true; context: MilestoneContext; records: InvoiceRecord[]; issuedOn: string }
  | { ok: false; errors: FieldIssue[] }
  | typeof NOT_FOUND;

const recordsFor = (context: MilestoneContext, numbers: (number | null)[]): InvoiceRecord[] =>
  context.open.filter((record) => numbers.includes(record.installment?.number ?? null));

type DocumentChoice = { templateId: string; invoiceText: InvoiceText };

const saveDrafts = async (
  db: Db,
  context: MilestoneContext,
  targets: Target[],
  dueDate: string,
  planId: string | null,
  count: number,
  document: DocumentChoice,
): Promise<void> => {
  const { milestone, project } = context;
  for (const target of targets) {
    await insertDraftInvoice(db, {
      ...document,
      milestoneId: milestone.id,
      amountCents: target.amountCents,
      currency: project.currency,
      dueDate: target.dueDate ?? dueDate,
      milestoneStatusBefore: BEFORE_INVOICE.includes(milestone.status) ? milestone.status : null,
      installment:
        target.number === null || planId === null ? null : { number: target.number, count, planId },
    });
  }
};

/**
 * The template and text for new invoices: the freelancer's pick, or the defaults. Their own
 * text is held to the AI's rule (no amounts or dates): those come from the records.
 */
export const documentChoice = async (
  db: Db,
  context: MilestoneContext,
  body: IssueBody,
): Promise<{ ok: true; choice: DocumentChoice } | { ok: false; errors: FieldIssue[] }> => {
  if (body.templateId && !(await getTemplate(db, body.templateId))) {
    return {
      ok: false,
      errors: [{ field: "templateId", message: "must be picked from the list" }],
    };
  }
  const freelancer = await getFreelancerDetails(db);
  const facts = textFactsFor(context, freelancer?.name ?? "");
  const invoiceText = body.text ?? invoiceTextTemplate(facts);
  const errors = invoiceTextIssues(invoiceText, facts);
  if (errors.length > 0) return { ok: false, errors };
  const templateId = await resolveTemplateId(db, {
    picked: body.templateId ?? null,
    clientId: context.project.clientId,
  });
  return { ok: true, choice: { templateId, invoiceText } };
};

/** One transaction: the invoices already there, or checked and saved new draft rows. */
const prepare = (deps: FlowDeps, milestoneId: string, raw: unknown): Promise<Prepared> =>
  deps.runAsUser(async (db) => {
    const context = await loadMilestoneContext(db, milestoneId);
    if (!context) return NOT_FOUND;
    const parsed = issueBodySchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
    }
    const body = parsed.data;
    const dates = invoiceDates(context.terms, deps.now, context.project.clientTimeZone);
    if (!alreadyInvoiced(context, body)) {
      const planned = issueTargets(context, body, dates);
      if (!planned.ok) return planned;
      const document = await documentChoice(db, context, body);
      if (!document.ok) return document;
      const plan = planned.newPlan
        ? await insertPlan(db, { milestoneId, ...planned.newPlan })
        : context.plan;
      const count = plan?.count ?? 0;
      await saveDrafts(
        db,
        context,
        planned.targets,
        dates.dueDate,
        plan?.id ?? null,
        count,
        document.choice,
      );
      context.plan = plan;
      context.open = await listOpenInvoices(db, milestoneId);
    }
    const records = recordsFor(context, requestedNumbers(context, body));
    return { ok: true, context, records, issuedOn: dates.issuedOn };
  });

/** The line item's description and the PayPal note (installment line, totals, other dates). */
export const textFor = (record: InvoiceRecord, context: MilestoneContext) => {
  const { plan, open, milestone, project } = context;
  if (!record.installment || !plan) return { description: project.title, note: null };
  // A split of what's left continues after the installments already settled.
  const offset = record.installment.count - plan.items.length;
  const others = plan.items
    .map((item, index) => {
      const number = index + 1 + offset;
      const invoice = open.find((r) => r.installment?.number === number);
      return {
        number,
        dueDate: invoice ? invoice.dueDate : item.dueDate,
        paid: invoice?.status === "paid",
      };
    })
    .filter((other) => other.number !== record.installment?.number);
  const paidSoFar = open
    .filter((r) => r.id !== record.id)
    .reduce((sum, r) => sum + r.amountPaidCents, 0);
  return installmentText({
    projectTitle: project.title,
    milestoneName: milestone.name,
    currency: project.currency,
    milestoneCents: milestone.cents,
    paidSoFarCents: paidSoFar,
    number: record.installment.number,
    count: record.installment.count,
    amountCents: record.amountCents,
    others,
  });
};

export const draftFor = (
  record: InvoiceRecord,
  context: MilestoneContext,
  issuedOn: string,
): InvoiceDraft => {
  const { description, note } = textFor(record, context);
  return {
    requestId: record.paypalRequestId,
    invoiceNumber: record.invoiceNumber,
    currency: record.currency,
    amountCents: record.amountCents,
    // Due today (or a resumed invoice whose date has passed) uses PayPal's own term: a date
    // could be "yesterday" in the PayPal account's time zone.
    dueDate: record.dueDate <= issuedOn ? null : record.dueDate,
    itemName: context.milestone.name,
    itemDescription: description,
    note,
    recipient: { email: context.clientEmail, name: context.project.clientName },
  };
};

/** Creates (or finds) the PayPal invoice and sends it; returns the client's pay link. */
export const sendThroughPaypal = async (
  deps: FlowDeps,
  record: InvoiceRecord,
  draft: InvoiceDraft,
): Promise<{ ok: true; link: string } | ReturnType<typeof conflict>> => {
  const { paypal } = deps;
  const paypalId = record.paypalInvoiceId ?? (await paypal.createInvoice(draft)).id;
  if (!record.paypalInvoiceId) {
    await deps.runAsUser((db) => recordPaypalId(db, record.id, paypalId));
  }
  try {
    await paypal.sendInvoice(paypalId);
  } catch (error) {
    // A repeated send is refused once the invoice has gone out; only a draft is a real failure.
    if ((await paypal.getInvoice(paypalId)).status === "DRAFT") throw error;
  }
  const sent = await paypal.getInvoice(paypalId);
  if (sent.status === "CANCELLED") {
    return conflict(
      `Invoice ${record.invoiceNumber} was cancelled in PayPal. Cancel it here too, then create a new one.`,
    );
  }
  if (!sent.payerViewUrl) {
    throw new Error("PayPal didn't return a pay link for the sent invoice. Try again in a minute.");
  }
  return { ok: true, link: sent.payerViewUrl };
};

/** The PDF follows the sent invoice; if it fails, the download or the next email makes it. */
export const makePdf = async (deps: FlowDeps, invoiceId: string): Promise<void> => {
  if (!deps.pdf) return;
  try {
    await deps.pdf(invoiceId);
  } catch (error) {
    logEvent("invoices.pdf_failed", { invoiceId, error: errorKind(error) });
  }
};

export const readBack = async (deps: FlowDeps, ids: string[]): Promise<InvoiceView[]> =>
  deps.runAsUser(async (db) => {
    const views: InvoiceView[] = [];
    for (const id of ids) {
      const saved = await getInvoiceRecord(db, id);
      if (!saved) throw new Error("An invoice could not be read back after saving.");
      views.push(toView(saved));
    }
    return views;
  });

/**
 * Creates and sends the milestone's PayPal invoice (or the installments this request covers),
 * or returns the ones it already has.
 */
export const issueMilestoneInvoice = async (
  deps: FlowDeps,
  milestoneId: string,
  raw: unknown,
): Promise<InvoiceResult> => {
  if (!isUuid(milestoneId)) return NOT_FOUND;
  const prepared = await prepare(deps, milestoneId, raw);
  if (!prepared.ok) return prepared;
  const { records, context, issuedOn } = prepared;

  let sentNow = false;
  for (const record of records) {
    if (record.status !== "draft") continue;
    const sent = await sendThroughPaypal(deps, record, draftFor(record, context, issuedOn));
    if (!sent.ok) return sent;
    await deps.runAsUser((db) => markSent(db, record, sent.link));
    sentNow = true;
    await makePdf(deps, record.id);
  }
  return {
    ok: true,
    invoices: await readBack(
      deps,
      records.map((record) => record.id),
    ),
    sentNow,
  };
};
