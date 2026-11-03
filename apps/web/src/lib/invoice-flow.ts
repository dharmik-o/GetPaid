import { z } from "zod";
import { isUuid, type Db, type UserDbRunner } from "./db";
import { toFieldIssues, type FieldIssue } from "./field-issues";
import { formatDay, formatMoney } from "./format";
import {
  findOpenInvoice,
  getInvoiceRecord,
  insertDraftInvoice,
  markCancelled,
  markSent,
  recordPaypalId,
  toView,
  type InvoiceRecord,
  type InvoiceView,
} from "./invoices";
import { statusLabel } from "./milestone-status";
import { listMilestones, type Milestone } from "./milestones";
import type { InvoiceDraft, PaypalClient } from "./paypal";
import { getProject, type Project } from "./projects";
import { invoiceDates } from "./schedule";
import { mergeSettings, type PaymentTerms } from "./settings";

// Server-only: one PayPal invoice per milestone: create, send, cancel.
// The row (with its request id and invoice number) is committed before PayPal is called, and
// PayPal is never called inside a transaction, so a retry after any failure resumes the same
// invoice instead of creating a second one.

export type FlowDeps = { runAsUser: UserDbRunner; paypal: PaypalClient; now: Date };

export type InvoiceResult =
  | { ok: true; invoice: InvoiceView; sentNow: boolean }
  | { ok: false; errors: FieldIssue[] }
  | { ok: false; notFound: true }
  | { ok: false; conflict: string };

const NOT_FOUND = { ok: false, notFound: true } as const;

const conflict = (message: string) => ({ ok: false, conflict: message }) as const;

const PAID_ALREADY =
  "The client has already paid all or part of this invoice, so it can't be cancelled. If you agreed to give the money back, refund it in PayPal.";

const bodySchema = z.strictObject({
  minimumDueCents: z
    .int("must be a whole number of minor units (cents)")
    .min(1, "must be more than 0")
    .max(Number.MAX_SAFE_INTEGER, "is too large")
    .optional(),
});

type Context = {
  project: Project;
  milestone: Milestone;
  clientEmail: string;
  terms: PaymentTerms;
};

const loadContext = async (db: Db, milestoneId: string): Promise<Context | undefined> => {
  const { rows } = await db.query<{ project_id: string; client_email: string }>(
    `SELECT m.project_id::text, c.email AS client_email
     FROM public.milestones m
     JOIN public.projects p ON p.id = m.project_id
     JOIN public.clients c ON c.id = p.client_id
     WHERE m.id = $1`,
    [milestoneId],
  );
  const row = rows[0];
  const project = row ? await getProject(db, row.project_id) : undefined;
  if (!row || !project) return undefined;
  const milestone = (await listMilestones(db, project)).find((m) => m.id === milestoneId);
  if (!milestone) return undefined;
  const { paymentTerms } = mergeSettings({
    account: project.inherited,
    project: project.settings,
    milestone: milestone.settings,
  });
  return { project, milestone, clientEmail: row.client_email, terms: paymentTerms };
};

const BEFORE_INVOICE = ["planned", "in_progress", "delivered", "accepted"];

/** Whether this milestone can be invoiced now, with this minimum and these dates. */
const issueErrors = (
  { milestone, project }: Context,
  minimumDueCents: number | undefined,
  dates: { issuedOn: string; dueDate: string },
): FieldIssue[] => {
  const label = statusLabel(milestone.status);
  if (milestone.paymentMode === "hold") {
    return [
      {
        field: "paymentMode",
        message:
          "is Milestone hold: the client authorizes the payment at the start instead of getting an invoice.",
      },
    ];
  }
  if (!BEFORE_INVOICE.includes(milestone.status)) {
    return [{ field: "status", message: `is ${label}, so it can't get a new invoice.` }];
  }
  if (
    milestone.paymentMode === "pay_on_invoice" &&
    !["delivered", "accepted"].includes(milestone.status)
  ) {
    return [
      {
        field: "status",
        message: `is ${label}. Mark it Delivered first: pay-on-invoice milestones are billed once the work is delivered.`,
      },
    ];
  }
  const errors: FieldIssue[] = [];
  if (milestone.paymentMode === "deposit" && minimumDueCents === undefined) {
    errors.push({ field: "minimumDueCents", message: "is required for a deposit invoice" });
  }
  if (milestone.paymentMode !== "deposit" && minimumDueCents !== undefined) {
    errors.push({ field: "minimumDueCents", message: "can only be set on a deposit invoice" });
  }
  if (minimumDueCents !== undefined && minimumDueCents > milestone.cents) {
    errors.push({
      field: "minimumDueCents",
      message: `can't be more than the invoice amount, ${formatMoney(milestone.cents, project.currency)}`,
    });
  }
  if (dates.dueDate < dates.issuedOn) {
    errors.push({
      field: "paymentTerms",
      message: `say the invoice is due on ${formatDay(dates.dueDate)}, which has passed. Change the payment terms on the milestone or project, then try again.`,
    });
  }
  return errors;
};

type Prepared =
  | { ok: true; context: Context; record: InvoiceRecord }
  | { ok: false; errors: FieldIssue[] }
  | typeof NOT_FOUND;

/** One transaction: the open invoice if there is one, else a checked, saved draft row. */
const prepare = (deps: FlowDeps, milestoneId: string, raw: unknown): Promise<Prepared> =>
  deps.runAsUser(async (db) => {
    const context = await loadContext(db, milestoneId);
    if (!context) return NOT_FOUND;
    const existing = await findOpenInvoice(db, milestoneId);
    if (existing) return { ok: true, context, record: existing };

    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
    }
    const { minimumDueCents } = parsed.data;
    const dates = invoiceDates(context.terms, deps.now, context.project.clientTimeZone);
    const errors = issueErrors(context, minimumDueCents, dates);
    if (errors.length > 0) return { ok: false, errors };

    const record = await insertDraftInvoice(db, {
      milestoneId,
      amountCents: context.milestone.cents,
      currency: context.project.currency,
      dueDate: dates.dueDate,
      minimumDueCents: minimumDueCents ?? null,
      milestoneStatusBefore: context.milestone.status,
    });
    return { ok: true, context, record };
  });

const draftFor = (record: InvoiceRecord, context: Context): InvoiceDraft => ({
  requestId: record.paypalRequestId,
  invoiceNumber: record.invoiceNumber,
  currency: record.currency,
  amountCents: record.amountCents,
  // Every invoice takes partial payments (spec); deposits also set a minimum.
  partialPayment: { minimumDueCents: record.minimumDueCents },
  // PayPal's own term avoids a date that is "yesterday" in the PayPal account's time zone.
  dueDate: context.terms.kind === "on_receipt" ? null : record.dueDate,
  itemName: context.milestone.name,
  itemDescription: context.project.title,
  recipient: { email: context.clientEmail, name: context.project.clientName },
});

/** Creates (or finds) the PayPal invoice and sends it; returns the client's pay link. */
const sendThroughPaypal = async (
  deps: FlowDeps,
  record: InvoiceRecord,
  context: Context,
): Promise<{ ok: true; link: string } | ReturnType<typeof conflict>> => {
  const { paypal } = deps;
  const paypalId =
    record.paypalInvoiceId ?? (await paypal.createInvoice(draftFor(record, context))).id;
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
      "This invoice was cancelled in PayPal. Cancel it here too, then create a new one.",
    );
  }
  if (!sent.payerViewUrl) {
    throw new Error("PayPal didn't return a pay link for the sent invoice. Try again in a minute.");
  }
  return { ok: true, link: sent.payerViewUrl };
};

const readBack = async (deps: FlowDeps, id: string): Promise<InvoiceView> => {
  const saved = await deps.runAsUser((db) => getInvoiceRecord(db, id));
  if (!saved) throw new Error("The invoice could not be read back after saving.");
  return toView(saved);
};

/** Creates and sends the milestone's PayPal invoice, or returns the one it already has. */
export const issueMilestoneInvoice = async (
  deps: FlowDeps,
  milestoneId: string,
  raw: unknown,
): Promise<InvoiceResult> => {
  if (!isUuid(milestoneId)) return NOT_FOUND;
  const prepared = await prepare(deps, milestoneId, raw);
  if (!prepared.ok) return prepared;
  const { record, context } = prepared;
  if (record.status !== "draft") return { ok: true, invoice: toView(record), sentNow: false };

  const sent = await sendThroughPaypal(deps, record, context);
  if (!sent.ok) return sent;
  await deps.runAsUser((db) => markSent(db, record, sent.link));
  return { ok: true, invoice: await readBack(deps, record.id), sentNow: true };
};

/** PayPal statuses that can still be cancelled: sent, nothing paid. */
const CANCELLABLE = new Set(["SENT", "UNPAID", "SCHEDULED"]);

/** Cancels an unpaid invoice (deletes it if PayPal only has a draft). Safe to repeat. */
export const cancelInvoice = async (deps: FlowDeps, invoiceId: string): Promise<InvoiceResult> => {
  if (!isUuid(invoiceId)) return NOT_FOUND;
  const record = await deps.runAsUser((db) => getInvoiceRecord(db, invoiceId));
  if (!record) return NOT_FOUND;
  if (record.status === "cancelled") return { ok: true, invoice: toView(record), sentNow: false };
  if (record.status !== "draft" && record.status !== "sent") return conflict(PAID_ALREADY);

  if (record.paypalInvoiceId) {
    const { paypal } = deps;
    const remote = await paypal.getInvoice(record.paypalInvoiceId);
    if (remote.status === "DRAFT") await paypal.deleteInvoice(record.paypalInvoiceId);
    else if (CANCELLABLE.has(remote.status)) await paypal.cancelInvoice(record.paypalInvoiceId);
    else if (remote.status !== "CANCELLED") return conflict(PAID_ALREADY);
  }
  await deps.runAsUser((db) => markCancelled(db, record));
  return { ok: true, invoice: await readBack(deps, record.id), sentNow: false };
};
