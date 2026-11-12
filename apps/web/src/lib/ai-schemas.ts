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
  /** "promise": the date they say they'll pay. "installments": the last date they name. Else null. */
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

const clock = z
  .string()
  .regex(/^\d{2}:\d{2}$/)
  .nullable();

/** One change the assistant may propose. It happens only when the freelancer presses Apply. */
export const calendarProposalSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("move"),
    key: z.string().max(80),
    startsOn: isoDate,
    startTime: clock,
    endTime: clock,
    reason: z.string().max(200),
  }),
  z.strictObject({
    op: z.literal("create"),
    title: z.string().min(1).max(200),
    kind: z.enum(["task", "event", "deadline", "call"]),
    startsOn: isoDate,
    startTime: clock,
    endTime: clock,
    clientName: z.string().max(120).nullable(),
    reason: z.string().max(200),
  }),
  z.strictObject({
    op: z.literal("mark_done"),
    key: z.string().max(80),
    reason: z.string().max(200),
  }),
  z.strictObject({
    op: z.literal("delete"),
    key: z.string().max(80),
    reason: z.string().max(200),
  }),
]);

/**
 * The calendar assistant's answer: text for the freelancer plus proposals they must press Apply on.
 * A proposal never happens by itself (lib/calendar-assistant.ts checks and applies them).
 */
export const calendarAnswerSchema = z.strictObject({
  answer: z.string().min(1).max(1500),
  /** Keys of the calendar items the answer is based on. */
  references: z.array(z.string().max(80)).max(30),
  proposals: z.array(calendarProposalSchema).max(10),
});

/**
 * The help assistant's answer: plain steps from the manual, which sections it used, and pages to
 * open. Links are only ever shown from an allowlist (lib/help-links.ts), and sources only if they
 * were among the sections it was given (lib/help-assistant.ts).
 */
export const helpAnswerSchema = z.strictObject({
  answer: z.string().min(1).max(1200),
  /** Ids of the manual sections the answer is based on. */
  sources: z.array(z.string().max(120)).max(6),
  /** App routes to open, such as /settings/ai. */
  links: z.array(z.string().max(80)).max(6),
});

export type HelpAnswer = z.infer<typeof helpAnswerSchema>;
export type CalendarAnswer = z.infer<typeof calendarAnswerSchema>;
export type CalendarProposal = z.infer<typeof calendarProposalSchema>;

export const AI_SCHEMAS = {
  classification: classificationSchema,
  draft: draftSchema,
  invoiceText: invoiceTextSchema,
  calendarAnswer: calendarAnswerSchema,
  helpAnswer: helpAnswerSchema,
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
