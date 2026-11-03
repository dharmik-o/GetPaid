import { z } from "zod";
import type { ChatMessage } from "./ai-client";
import { invoiceTextSchema, type InvoiceText } from "./ai-schemas";
import type { FieldIssue } from "./field-issues";
import type { MilestoneContext } from "./invoice-context";
import { PROMPT_TEXT } from "./prompt-text";

// The text tags of an invoice document (greeting, thank-you note, project summary, notes): the
// only parts the AI writes. Text that mentions an amount or a date is rejected, whether a
// model or the freelancer wrote it, because every amount and date on the invoice comes from
// the database. Pure: safe in client components.

export const INVOICE_TEXT_FIELDS = [
  "greeting",
  "thank_you_note",
  "project_summary",
  "notes",
] as const;

/** Database values the text may quote (a project called "Website v2" isn't an invented number). */
export type InvoiceTextFacts = {
  freelancerName: string;
  clientName: string;
  projectTitle: string;
  milestoneName: string;
  deliverable: string | null;
};

/** The facts for one milestone's invoice text. */
export const textFactsFor = (
  context: MilestoneContext,
  freelancerName: string,
): InvoiceTextFacts => ({
  freelancerName,
  clientName: context.project.clientName,
  projectTitle: context.project.title,
  milestoneName: context.milestone.name,
  deliverable: context.milestone.deliverable,
});

const MONTHS = "january|february|march|april|june|july|august|september|october|november|december";
const MONTH_ABBREVIATIONS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const RELATIVE =
  "today|tomorrow|yesterday|tonight|next (week|month|year)|last (week|month|year)|this (week|month|year)|end of (the )?(week|month|year)|deadline|due date";
const MONEY_WORDS =
  "dollars?|euros?|pounds?|rupees?|yen|francs?|pesos?|cents?|bucks|usd|eur|gbp|inr|aud|cad|jpy|chf|sgd";
const NUMBER_WORDS =
  "hundred|thousand|million|billion|half|quarter|fifty|twenty|thirty|forty|sixty|seventy|eighty|ninety";

const AMOUNT_OR_DATE = [
  /\d/,
  /[$€£¥₹¢]/,
  new RegExp(`\\b(${MONTHS}|${WEEKDAYS}|${RELATIVE})\\b`, "i"),
  new RegExp(`\\b(${MONTH_ABBREVIATIONS})\\b\\.?`),
  new RegExp(`\\b(${MONEY_WORDS}|${NUMBER_WORDS})\\b`, "i"),
];

/** Whether the text names an amount or a date, after the facts it may quote are taken out. */
export const mentionsAmountOrDate = (text: string, facts: InvoiceTextFacts): boolean => {
  const quoted = Object.values(facts).filter((v): v is string => typeof v === "string" && v !== "");
  const rest = quoted.reduce((left, value) => left.split(value).join(" "), text);
  return AMOUNT_OR_DATE.some((pattern) => pattern.test(rest));
};

const MESSAGE =
  "mentions an amount or a date; the invoice shows those from your records, so leave them out";

export const invoiceTextIssues = (text: InvoiceText, facts: InvoiceTextFacts): FieldIssue[] =>
  INVOICE_TEXT_FIELDS.filter((field) => mentionsAmountOrDate(text[field], facts)).map((field) => ({
    field: `text.${field}`,
    message: MESSAGE,
  }));

/** The schema plus the amount-and-date check, for the router: a failure is an invalid answer. */
export const checkedInvoiceTextSchema = (facts: InvoiceTextFacts): z.ZodType<InvoiceText> =>
  invoiceTextSchema.superRefine((text, ctx) => {
    for (const issue of invoiceTextIssues(text, facts)) {
      ctx.addIssue({ code: "custom", path: [issue.field.slice(5)], message: issue.message });
    }
  });

/** Used when no model gives valid text. Built from the facts only. */
export const invoiceTextTemplate = (facts: InvoiceTextFacts): InvoiceText => ({
  greeting: `Hello ${facts.clientName},`,
  thank_you_note: "Thank you for working with me. It's been a pleasure.",
  project_summary: `This invoice covers ${facts.milestoneName} for ${facts.projectTitle}${
    facts.deliverable ? `: ${facts.deliverable}` : ""
  }.`,
  notes: "",
});

const quoted = (value: object): string =>
  JSON.stringify(value).replace(/</g, `${String.fromCharCode(92)}u003c`);

export const invoiceTextMessages = (facts: InvoiceTextFacts): ChatMessage[] => [
  { role: "system", content: PROMPT_TEXT.invoice_text },
  { role: "user", content: `<facts>${quoted(facts)}</facts>` },
];
