import { invoiceTextSchema, type InvoiceText } from "./ai-schemas";
import type { Db } from "./db";
import { toCents } from "./db-values";
import { formatFullDay, formatPaymentTerms } from "./format";
import type { PaperSize } from "./invoice-pdf";
import { getClientDetails, getFreelancerDetails, type FreelancerDetails } from "./invoice-details";
import type { InvoiceDocument } from "./invoice-document";
import { loadMilestoneContext, type MilestoneContext } from "./invoice-context";
import { textFor } from "./invoice-flow";
import { invoiceTextTemplate, textFactsFor, type InvoiceTextFacts } from "./invoice-text";
import { CLASSIC_TEMPLATE_ID, getTemplate, type Template } from "./invoice-templates";
import { getInvoiceRecord, type InvoiceRecord } from "./invoices";
import { todayIn } from "./schedule";
import { mergeSettings } from "./settings";

// Server-only: everything one invoice's PDF is made from, read as the signed-in user (RLS).
// Names, amounts, dates, numbers, installments and the pay link all come from the database.

export type LoadedDocument = {
  userId: string;
  invoiceId: string;
  pdfPath: string | null;
  template: Template;
  document: InvoiceDocument;
  paper: PaperSize;
};

type Extra = {
  template_id: string | null;
  invoice_text: unknown;
  pdf_path: string | null;
  created_at: Date | string;
  user_id: string;
  include_signature: boolean;
};

const paperOf = (freelancer: FreelancerDetails): PaperSize => freelancer.invoicePaper;

/** On when this invoice asks for it and one is set up. Read when the document is made. */
const signatureOf = (
  freelancer: FreelancerDetails,
  include: boolean,
): InvoiceDocument["signature"] =>
  include && freelancer.signatureImageDataUrl
    ? {
        imageDataUrl: freelancer.signatureImageDataUrl,
        name: freelancer.signatureName,
        title: freelancer.signatureTitle,
      }
    : null;

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

type RetainerDocumentRow = Extra & {
  invoice_number: string;
  amount_cents: string;
  currency: string;
  due_date: string;
  link: string | null;
  retainer_cycle_on: string | null;
  retainer_name: string;
  client_id: string;
  client_name: string;
  client_email: string;
  time_zone: string;
  project_title: string | null;
  late_fee_clause: string | null;
  account_settings: unknown;
  client_settings: unknown;
  project_settings: unknown;
};

const loadRetainerDocument = async (
  db: Db,
  invoiceId: string,
): Promise<LoadedDocument | undefined> => {
  const { rows } = await db.query<RetainerDocumentRow>(
    `SELECT i.template_id::text, i.invoice_text, i.pdf_path, i.created_at, i.user_id::text,
       i.include_signature, i.invoice_number, i.amount_cents::text, i.currency, i.due_date::text, i.link,
       i.retainer_cycle_on::text, r.name AS retainer_name, c.id::text AS client_id,
       c.name AS client_name, c.email AS client_email, c.time_zone, p.title AS project_title,
       p.late_fee_clause, u.default_settings AS account_settings, c.settings AS client_settings,
       p.settings AS project_settings
     FROM public.invoices i
     JOIN public.retainers r ON r.id = i.retainer_id
     JOIN public.clients c ON c.id = r.client_id
     JOIN public.users u ON u.id = i.user_id
     LEFT JOIN public.projects p ON p.id = r.project_id
     WHERE i.id = $1`,
    [invoiceId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const freelancer = await getFreelancerDetails(db);
  const client = await getClientDetails(db, row.client_id);
  if (!freelancer || !client) return undefined;
  const template =
    (row.template_id ? await getTemplate(db, row.template_id) : undefined) ??
    (await getTemplate(db, CLASSIC_TEMPLATE_ID));
  if (!template) throw new Error("The Classic template is missing. Run npm run db:migrate.");
  const { paymentTerms } = mergeSettings({
    account: row.account_settings,
    client: row.client_settings,
    project: row.project_settings,
  });
  const title = row.project_title
    ? `${row.project_title}: ${row.retainer_name}`
    : row.retainer_name;
  const description = row.retainer_cycle_on
    ? `${row.retainer_name}, charge of ${formatFullDay(row.retainer_cycle_on)}`
    : row.retainer_name;
  const facts: InvoiceTextFacts = {
    freelancerName: freelancer.name,
    clientName: row.client_name,
    projectTitle: row.project_title ?? "your retainer",
    milestoneName: row.retainer_name,
    deliverable: null,
  };
  return {
    userId: row.user_id,
    invoiceId,
    pdfPath: row.pdf_path,
    template,
    paper: paperOf(freelancer),
    document: {
      freelancer: {
        name: freelancer.name,
        businessName: freelancer.businessName,
        email: freelancer.email,
        address: freelancer.address,
        logoDataUrl: freelancer.logoDataUrl,
      },
      client: {
        name: row.client_name,
        company: client.company,
        email: row.client_email,
        address: client.address,
      },
      invoice: {
        number: row.invoice_number,
        issueDate: todayIn(new Date(row.created_at), row.time_zone),
        dueDate: row.due_date,
        title,
        payLink: row.link,
        showQr: freelancer.invoiceShowQr,
        terms: formatPaymentTerms(paymentTerms),
        lateFeeClause: row.late_fee_clause,
      },
      currency: row.currency,
      items: [
        {
          name: row.retainer_name,
          description,
          quantity: 1,
          unitCents: toCents(row.amount_cents),
        },
      ],
      taxCents: 0,
      discountCents: 0,
      installment: null,
      text: storedText(row.invoice_text, facts),
      signature: signatureOf(freelancer, row.include_signature),
    },
  };
};

export const loadInvoiceDocument = async (
  db: Db,
  invoiceId: string,
): Promise<LoadedDocument | undefined> => {
  const { rows: source } = await db.query<{ retainer_id: string | null }>(
    "SELECT retainer_id::text FROM public.invoices WHERE id = $1",
    [invoiceId],
  );
  if (source[0]?.retainer_id) return loadRetainerDocument(db, invoiceId);
  const record = await getInvoiceRecord(db, invoiceId);
  const { rows } = await db.query<Extra>(
    `SELECT template_id::text, invoice_text, pdf_path, created_at, user_id::text,
       include_signature
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
    paper: paperOf(freelancer),
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
        showQr: freelancer.invoiceShowQr,
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
      signature: signatureOf(freelancer, extra.include_signature),
    },
  };
};
