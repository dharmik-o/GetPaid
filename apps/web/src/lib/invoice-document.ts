import type { InvoiceText } from "./ai-schemas";
import { formatFullDay, formatMoney } from "./format";
import { payQrDataUrl } from "./pay-qr";
import { SAMPLE_SIGNATURE_DATA_URL } from "./sample-signature";

// What an invoice document shows, and the tag values a template is filled with. Every value
// comes from the database (money from the one money formatter, dates as "18 Nov 2026");
// only the text tags were written by the AI or the freelancer. Pure.

export type InvoiceDocument = {
  freelancer: {
    name: string;
    businessName: string | null;
    email: string;
    address: string | null;
    logoDataUrl: string | null;
  };
  client: { name: string; company: string | null; email: string; address: string | null };
  invoice: {
    number: string;
    /** YYYY-MM-DD. */
    issueDate: string;
    dueDate: string;
    title: string;
    payLink: string | null;
    /** Show a QR code of the pay link, when there is one. */
    showQr: boolean;
    terms: string;
    lateFeeClause: string | null;
  };
  currency: string;
  items: { name: string; description: string | null; quantity: number; unitCents: number }[];
  taxCents: number;
  discountCents: number;
  installment: {
    number: number;
    count: number;
    paidSoFarCents: number;
    remainingCents: number;
    schedule: {
      number: number;
      amountCents: number;
      dueDate: string | null;
      status: "paid" | "due" | "this invoice";
    }[];
  } | null;
  text: InvoiceText;
  /** Null when this invoice goes without one, or none has been set up. */
  signature: { imageDataUrl: string; name: string | null; title: string | null } | null;
};

export const EXPENSE_SHORTCUT_COUNT = 10;

export const documentTotalCents = (doc: InvoiceDocument): number =>
  doc.items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0) +
  doc.taxCents -
  doc.discountCents;

/** The view Mustache fills the template from. Missing values are empty strings, never "null". */
export const invoiceView = (doc: InvoiceDocument): Record<string, unknown> => {
  const money = (cents: number) => formatMoney(cents, doc.currency);
  const items = doc.items.map((item) => ({
    name: item.name,
    description: item.description ?? "",
    quantity: String(item.quantity),
    unit_price: money(item.unitCents),
    amount: money(item.quantity * item.unitCents),
  }));
  const subtotal = doc.items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0);
  const expenses = Object.fromEntries(
    Array.from({ length: EXPENSE_SHORTCUT_COUNT }, (_, i) => {
      const item = items[i];
      return [`expense_${String(i + 1)}`, item ? `${item.name}: ${item.amount}` : ""];
    }),
  );
  const { installment, signature } = doc;
  const payLink = doc.invoice.payLink ?? "";
  return {
    freelancer: {
      name: doc.freelancer.name,
      business_name: doc.freelancer.businessName ?? "",
      email: doc.freelancer.email,
      address: doc.freelancer.address ?? "",
      logo: doc.freelancer.logoDataUrl ?? "",
    },
    client: {
      name: doc.client.name,
      company: doc.client.company ?? "",
      email: doc.client.email,
      address: doc.client.address ?? "",
    },
    invoice: {
      number: doc.invoice.number,
      issue_date: formatFullDay(doc.invoice.issueDate),
      due_date: formatFullDay(doc.invoice.dueDate),
      title: doc.invoice.title,
      pay_link: payLink,
      pay_qr: doc.invoice.showQr && payLink ? payQrDataUrl(payLink) : "",
      terms: doc.invoice.terms,
      late_fee_clause: doc.invoice.lateFeeClause ?? "",
    },
    items,
    ...expenses,
    totals: {
      subtotal: money(subtotal),
      tax: money(doc.taxCents),
      discount: money(doc.discountCents),
      total: money(documentTotalCents(doc)),
    },
    currency: doc.currency,
    installment: {
      number: installment ? String(installment.number) : "",
      count: installment ? String(installment.count) : "",
      paid_so_far: installment ? money(installment.paidSoFarCents) : "",
      remaining: installment ? money(installment.remainingCents) : "",
      schedule: (installment?.schedule ?? []).map((row) => ({
        number: String(row.number),
        amount: money(row.amountCents),
        due_date: row.dueDate ? formatFullDay(row.dueDate) : "when the work is delivered",
        status: row.status,
      })),
    },
    greeting: doc.text.greeting,
    thank_you_note: doc.text.thank_you_note,
    project_summary: doc.text.project_summary,
    notes: doc.text.notes,
    // False, not an empty object, so {{#signature}} leaves its whole block out.
    signature: signature
      ? {
          image: signature.imageDataUrl,
          name: signature.name ?? "",
          title: signature.title ?? "",
        }
      : false,
  };
};

/** Made-up data for the template preview; the freelancer's own name and logo replace these. */
export const SAMPLE_DOCUMENT: InvoiceDocument = {
  freelancer: {
    name: "Alex Rivera",
    businessName: "Rivera Studio",
    email: "alex@example.test",
    address: "1 Sample Street, Lisbon",
    logoDataUrl: null,
  },
  client: {
    name: "Sam Lee",
    company: "Example Co",
    email: "sam@example.test",
    address: "500 Example Avenue, New York",
  },
  invoice: {
    number: "FPR-000042",
    issueDate: "2026-11-03",
    dueDate: "2026-11-17",
    title: "Website redesign: Build",
    payLink: "https://www.sandbox.paypal.com/invoice/p/#INV2-SAMP-LE00-0000",
    showQr: true,
    terms: "Net 14",
    lateFeeClause: "Late invoices incur 1.5% interest per month.",
  },
  currency: "USD",
  items: [
    {
      name: "Build",
      description: "Installment 2 of 2 for Website redesign: Build",
      quantity: 1,
      unitCents: 75000,
    },
  ],
  taxCents: 0,
  discountCents: 0,
  installment: {
    number: 2,
    count: 2,
    paidSoFarCents: 75000,
    remainingCents: 0,
    schedule: [
      { number: 1, amountCents: 75000, dueDate: "2026-11-03", status: "paid" },
      { number: 2, amountCents: 75000, dueDate: "2026-11-17", status: "this invoice" },
    ],
  },
  text: {
    greeting: "Hello Sam,",
    thank_you_note: "Thank you for working with me. It's been a pleasure.",
    project_summary:
      "This invoice covers the Build milestone for Website redesign: the new website.",
    notes: "",
  },
  signature: { imageDataUrl: SAMPLE_SIGNATURE_DATA_URL, name: "Alex Rivera", title: "Founder" },
};
