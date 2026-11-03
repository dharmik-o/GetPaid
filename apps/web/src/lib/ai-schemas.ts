import { z } from "zod";

// The shapes every AI answer must match. These zod schemas are the source; the JSON Schema
// files in prompts/schemas are generated from them (a test keeps the two identical), so
// checking with zod is checking against the JSON files. Pure: safe in client components.

/** The six reply labels from the spec's reply-handling table. */
export const REPLY_LABELS = [
  "promise",
  "installments",
  "paid_elsewhere",
  "dispute",
  "out_of_office",
  "unclear",
] as const;

const isoDate = z.iso.date();

/** How the AI sorts a client reply. A suggestion only: it never changes status or amounts. */
export const classificationSchema = z.strictObject({
  label: z.enum(REPLY_LABELS),
  /** For "promise": the date the client says they'll pay (YYYY-MM-DD), else null. */
  promisedDate: isoDate.nullable(),
  /** For "out_of_office": the date they're back (YYYY-MM-DD), else null. */
  returnDate: isoDate.nullable(),
  /** One plain sentence for the freelancer. */
  summary: z.string().min(1).max(500),
});

export type Classification = z.infer<typeof classificationSchema>;

/** A drafted email. Nothing is sent without approval, and a draft that fails this is never sent. */
export const draftSchema = z.strictObject({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
});

export type Draft = z.infer<typeof draftSchema>;

/**
 * The text tags of an invoice document: the only parts the AI writes. Never amounts or dates
 * (lib/invoice-text.ts checks); everything else on the invoice comes from the database.
 */
export const invoiceTextSchema = z.strictObject({
  greeting: z.string().min(1).max(200),
  thank_you_note: z.string().min(1).max(400),
  project_summary: z.string().min(1).max(800),
  notes: z.string().max(800),
});

export type InvoiceText = z.infer<typeof invoiceTextSchema>;

export const AI_SCHEMAS = {
  classification: classificationSchema,
  draft: draftSchema,
  invoiceText: invoiceTextSchema,
} as const;

export type AiSchemaName = keyof typeof AI_SCHEMAS;

export const AI_SCHEMA_NAMES = Object.keys(AI_SCHEMAS) as [AiSchemaName, ...AiSchemaName[]];

/** "invoiceText" is saved as prompts/schemas/invoice-text.schema.json. */
export const schemaFileName = (name: AiSchemaName): string =>
  `${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.schema.json`;

/** The JSON Schema file content for one schema (what prompts/schemas/<name>.schema.json holds). */
export const jsonSchemaFor = (name: AiSchemaName): Record<string, unknown> => ({
  $comment: `Generated from apps/web/src/lib/ai-schemas.ts (${name}Schema); tests/ai-schemas.test.ts keeps them identical.`,
  ...z.toJSONSchema(AI_SCHEMAS[name]),
});
