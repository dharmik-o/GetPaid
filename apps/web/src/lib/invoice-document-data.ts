import { invoiceTextSchema, type InvoiceText } from "./ai-schemas";
import type { Db } from "./db";
import { formatPaymentTerms } from "./format";
import { getClientDetails, getFreelancerDetails } from "./invoice-details";
import type { InvoiceDocument } from "./invoice-document";
import { loadMilestoneContext, type MilestoneContext } from "./invoice-context";
import { textFor } from "./invoice-flow";
import { invoiceTextTemplate, textFactsFor, type InvoiceTextFacts } from "./invoice-text";
import { CLASSIC_TEMPLATE_ID, getTemplate, type Template } from "./invoice-templates";
import { getInvoiceRecord, type InvoiceRecord } from "./invoices";
import { todayIn } from "./schedule";

// Server-only: everything one invoice's PDF is made from, read as the signed-in user (RLS).
// Names, amounts, dates, numbers, installments and the pay link all come from the database.

export type LoadedDocument = {
  userId: string;
  invoiceId: string;
  pdfPath: string | null;
  template: Template;
  document: InvoiceDocument;
};

type Extra = {
  template_id: string | null;
  invoice_text: unknown;
  pdf_path: string | null;
  created_at: Date | string;
  user_id: string;
};

const installmentOf = (
  record: InvoiceRecord,
  context: MilestoneContext,
): InvoiceDocument["installment"] => {
  const { plan, open, milestone } = context;
  if (!record.installment || !plan) return null;
  const paidSoFar = open
    .filter((other) => other.id !== record.id)
    .reduce((sum, other) => sum + other.amountPaidCents, 0);
  return {
    number: record.installment.number,
    count: record.installment.count,
    paidSoFarCents: paidSoFar,
    remainingCents: Math.max(0, milestone.cents - paidSoFar - record.amountCents),
    schedule: plan.items.map((item, index) => {
      const number = index + 1;
      const invoice = open.find((other) => other.installment?.number === number);
      const status =
        number === record.installment?.number
          ? "this invoice"
          : invoice?.status === "paid"
            ? "paid"
            : "due";
      return {
        number,
        amountCents: invoice?.amountCents ?? item.amountCents,
        dueDate: invoice?.dueDate ?? item.dueDate,
        status,
      };
    }),
  };
};

const storedText = (raw: unknown, facts: InvoiceTextFacts): InvoiceText => {
  const parsed = invoiceTextSchema.safeParse(raw);
  return parsed.success ? parsed.data : invoiceTextTemplate(facts);
};

export const loadInvoiceDocument = async (
  db: Db,
  invoiceId: string,
): Promise<LoadedDocument | undefined> => {
  const record = await getInvoiceRecord(db, invoiceId);
  const { rows } = await db.query<Extra>(
    `SELECT template_id::text, invoice_text, pdf_path, created_at, user_id::text
     FROM public.invoices WHERE id = $1`,
    [invoiceId],
  );
  const extra = rows[0];
  if (!record || !extra) return undefined;
  const context = await loadMilestoneContext(db, record.milestoneId);
  const freelancer = await getFreelancerDetails(db);
  const client = await getClientDetails(db, context?.project.clientId ?? "");
  if (!context || !freelancer || !client) return undefined;
  const template =
    (extra.template_id ? await getTemplate(db, extra.template_id) : undefined) ??
    (await getTemplate(db, CLASSIC_TEMPLATE_ID));
  if (!template) throw new Error("The Classic template is missing. Run npm run db:migrate.");
  const { description } = textFor(record, context);
  const createdAt = new Date(extra.created_at);
  return {
    userId: extra.user_id,
    invoiceId,
    pdfPath: extra.pdf_path,
    template,
    document: {
      freelancer: {
        name: freelancer.name,
        businessName: freelancer.businessName,
        email: freelancer.email,
        address: freelancer.address,
        logoDataUrl: freelancer.logoDataUrl,
      },
      client: {
        name: context.project.clientName,
        company: client.company,
        email: context.clientEmail,
        address: client.address,
      },
      invoice: {
        number: record.invoiceNumber,
        issueDate: todayIn(createdAt, context.project.clientTimeZone),
        dueDate: record.dueDate,
        title: `${context.project.title}: ${context.milestone.name}`,
        payLink: record.link,
        terms: formatPaymentTerms(context.terms),
        lateFeeClause: context.project.lateFeeClause,
      },
      currency: record.currency,
      items: [
        { name: context.milestone.name, description, quantity: 1, unitCents: record.amountCents },
      ],
      taxCents: 0,
      discountCents: 0,
      installment: installmentOf(record, context),
      text: storedText(extra.invoice_text, textFactsFor(context, freelancer.name)),
    },
  };
};
