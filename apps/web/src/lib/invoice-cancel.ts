import { z } from "zod";
import { isUuid } from "./db";
import { toFieldIssues } from "./field-issues";
import { CANCEL_REASONS } from "./invoice-closing";
import { setPlanStatus } from "./installment-plans";
import { conflict, NOT_FOUND, readBack, type FlowDeps, type InvoiceResult } from "./invoice-flow";
import {
  getInvoiceRecord,
  listOpenInvoices,
  markCancelled,
  toView,
  type InvoiceRecord,
} from "./invoices";

// Server-only: cancelling an invoice. A plain invoice is cancelled alone; an installment plan
// is cancelled as a whole, and only while nothing on it is paid. Anything with money on it is
// never cancelled. PayPal is called outside any transaction; repeating is safe.

const PAID_ALREADY =
  "The client has already paid this invoice, so it can't be cancelled. If you agreed to give the money back, refund it in PayPal.";

const planPaid = (record: InvoiceRecord): string =>
  `Installment ${String(record.installment?.number)} of this plan is already paid, so the plan can't be cancelled. The unpaid installments stay open; if you agreed to give money back, refund it in PayPal.`;

/** PayPal statuses that can still be cancelled: sent, nothing paid. */
const CANCELLABLE = new Set(["SENT", "UNPAID", "SCHEDULED"]);

const UNPAID = new Set(["draft", "sent"]);

/** The invoices one cancel covers: the invoice, or every open installment of its plan. */
const loadGroup = (deps: FlowDeps, invoiceId: string) =>
  deps.runAsUser(async (db) => {
    const record = await getInvoiceRecord(db, invoiceId);
    if (!record) return undefined;
    const group =
      record.installmentPlanId === null || record.status === "cancelled"
        ? [record]
        : (await listOpenInvoices(db, record.milestoneId)).filter(
            (r) => r.installmentPlanId === record.installmentPlanId,
          );
    return { record, group };
  });

/** Cancels (or deletes, if PayPal only has a draft) in PayPal; a message if money is on it. */
export const cancelInPaypal = async (
  deps: FlowDeps,
  record: Pick<InvoiceRecord, "paypalInvoiceId">,
  paidMessage: string,
): Promise<string | undefined> => {
  if (!record.paypalInvoiceId) return undefined;
  const { paypal } = deps;
  const remote = await paypal.getInvoice(record.paypalInvoiceId);
  if (remote.status === "DRAFT") await paypal.deleteInvoice(record.paypalInvoiceId);
  else if (CANCELLABLE.has(remote.status)) await paypal.cancelInvoice(record.paypalInvoiceId);
  else if (remote.status !== "CANCELLED") return paidMessage;
  return undefined;
};

const bodySchema = z.strictObject({
  reason: z.enum(CANCEL_REASONS, { error: "must be picked from the list" }),
});

export const cancelInvoice = async (
  deps: FlowDeps,
  invoiceId: string,
  raw: unknown,
): Promise<InvoiceResult> => {
  if (!isUuid(invoiceId)) return NOT_FOUND;
  const loaded = await loadGroup(deps, invoiceId);
  if (!loaded) return NOT_FOUND;
  const { record, group } = loaded;
  const body = bodySchema.safeParse(raw);
  if (!body.success) {
    return { ok: false, errors: toFieldIssues(body.error, { noun: "field" }) };
  }
  if (record.status === "cancelled")
    return { ok: true, invoices: [toView(record)], sentNow: false };

  const isPlan = record.installmentPlanId !== null;
  const paidOne = group.find((r) => !UNPAID.has(r.status));
  if (paidOne) return conflict(isPlan ? planPaid(paidOne) : PAID_ALREADY);

  for (const member of group) {
    const refused = await cancelInPaypal(deps, member, isPlan ? planPaid(member) : PAID_ALREADY);
    if (refused) return conflict(refused);
  }
  const restoreTo = group.find((r) => r.milestoneStatusBefore)?.milestoneStatusBefore ?? "accepted";
  await deps.runAsUser(async (db) => {
    for (const member of group) await markCancelled(db, member, restoreTo, body.data.reason);
    if (record.installmentPlanId) await setPlanStatus(db, record.installmentPlanId, "cancelled");
  });
  return {
    ok: true,
    invoices: await readBack(
      deps,
      group.map((r) => r.id),
    ),
    sentNow: false,
  };
};
