import { z } from "zod";
import { getOwnTimeZone } from "./account";
import { isUuid } from "./db";
import { toFieldIssues } from "./field-issues";
import { formatMoney } from "./format";
import {
  METHOD_LABELS,
  PAYMENT_METHODS,
  RECORDABLE_STATUSES,
  type PaymentMethod,
} from "./invoice-closing";
import { conflict, NOT_FOUND, readBack, type FlowDeps, type InvoiceResult } from "./invoice-flow";
import { getInvoiceRecord } from "./invoices";
import { applyChange, changeFromPaypal, findInvoice } from "./paypal-webhook";
import type { PaypalPaymentMethod } from "./paypal";
import { todayIn } from "./schedule";

// Server-only: a signed-in freelancer records money that arrived outside PayPal. PayPal is told
// first, so the invoice and its pay link stop being payable; only if PayPal accepts is anything
// saved here, and our status and amount then come from PayPal's own copy of the invoice. Nothing
// from a client's email, the AI or Telegram ever reaches this: it is a form the freelancer sends.

const FOR_PAYPAL: Record<PaymentMethod, PaypalPaymentMethod> = {
  bank_transfer: "BANK_TRANSFER",
  upi: "OTHER",
  cash: "CASH",
  cheque: "CHECK",
  wise: "OTHER",
  other: "OTHER",
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const bodySchema = z.strictObject({
  method: z.enum(PAYMENT_METHODS, { error: "must be picked from the list" }),
  amountCents: z
    .int({ error: "must be a whole number of minor units (cents)" })
    .positive({ error: "must be more than zero" }),
  receivedOn: z
    .string()
    .regex(ISO_DAY, { error: "must be a date like 2026-11-12" })
    .refine((day) => !Number.isNaN(Date.parse(day)), { error: "must be a real date" }),
  reference: z.string().trim().max(200, { error: "must be 200 characters or fewer" }).optional(),
});

/** What PayPal's copy of the invoice says about this payment (never the freelancer's own words). */
const noteFor = (method: PaymentMethod, reference: string | undefined): string =>
  `Recorded by the freelancer: ${METHOD_LABELS[method]}${reference ? `, ${reference}` : ""}`.slice(
    0,
    2000,
  );

export const recordPayment = async (
  deps: FlowDeps,
  invoiceId: string,
  raw: unknown,
): Promise<InvoiceResult> => {
  if (!isUuid(invoiceId)) return NOT_FOUND;
  const loaded = await deps.runAsUser(async (db) => ({
    record: await getInvoiceRecord(db, invoiceId),
    zone: await getOwnTimeZone(db),
  }));
  const { record } = loaded;
  if (!record) return NOT_FOUND;

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
  }
  const body = parsed.data;
  if (!RECORDABLE_STATUSES.includes(record.status) || !record.paypalInvoiceId) {
    return conflict(
      record.status === "draft"
        ? `Invoice ${record.invoiceNumber} hasn't been sent yet. Send it first, then record the payment.`
        : `Invoice ${record.invoiceNumber} can't take a payment: it is ${record.status.replace("_", " ")}.`,
    );
  }
  const owed = record.amountCents - record.amountPaidCents;
  if (body.amountCents > owed) {
    return {
      ok: false,
      errors: [
        {
          field: "amountCents",
          message: `can't be more than what is still owed (${formatMoney(owed, record.currency)})`,
        },
      ],
    };
  }
  if (body.receivedOn > todayIn(deps.now, loaded.zone)) {
    return {
      ok: false,
      errors: [{ field: "receivedOn", message: "can't be in the future" }],
    };
  }

  // PayPal must agree with what we think is paid, or a half-finished earlier try could be doubled.
  const before = await deps.paypal.getInvoice(record.paypalInvoiceId);
  if (before.paidCents - before.refundedCents !== record.amountPaidCents) {
    return conflict(
      `PayPal already shows a different amount paid on invoice ${record.invoiceNumber} than this app does. Wait a minute for it to catch up, or check the invoice in PayPal, then try again.`,
    );
  }

  // PayPal first: if it refuses, the error goes to the freelancer and nothing here changes.
  const { paymentId } = await deps.paypal.recordInvoicePayment(record.paypalInvoiceId, {
    requestId: crypto.randomUUID(),
    method: FOR_PAYPAL[body.method],
    paymentDate: body.receivedOn,
    amountCents: body.amountCents,
    currency: record.currency,
    note: noteFor(body.method, body.reference),
  });
  const remote = await deps.paypal.getInvoice(record.paypalInvoiceId);

  await deps.runAsUser(async (db) => {
    const invoice = await findInvoice(
      db,
      { by: "paypal_invoice_id", value: record.paypalInvoiceId ?? "", action: "sync" },
      true,
    );
    if (!invoice) return;
    const saved = await db.query(
      `INSERT INTO public.invoice_payments
         (user_id, invoice_id, method, amount_cents, currency, received_on, reference, paypal_payment_id, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $1)
       ON CONFLICT (invoice_id, paypal_payment_id) DO NOTHING`,
      [
        invoice.user_id,
        invoice.id,
        body.method,
        body.amountCents,
        record.currency,
        body.receivedOn,
        body.reference || null,
        paymentId,
      ],
    );
    if (saved.rowCount > 0) {
      await db.query(
        `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
         VALUES ($1, 'invoice', $2, 'payment.recorded', $3)`,
        [
          invoice.user_id,
          invoice.id,
          JSON.stringify({ method: body.method, amountCents: body.amountCents }),
        ],
      );
    }
    // The same change a webhook for this payment would make; PayPal's figures, not a sum of ours.
    await applyChange(db, invoice, changeFromPaypal(invoice, remote), "payment.recorded");
  });
  return { ok: true, invoices: await readBack(deps, [record.id]), sentNow: false };
};
