import { z } from "zod";
import type { Citation } from "./draft-facts";

// Legal gating for Tier 3. A final notice may cite only the contract's own late-fee clause or
// a law from legal/statutes.json for the client's country; with neither, it's a plain final
// notice that cites nothing. Pure: the table is passed in.

const lawSchema = z.strictObject({
  /** Stable id, e.g. "uk-late-payment-1998". */
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  /** The law's name as it's cited, e.g. "Late Payment of Commercial Debts (Interest) Act 1998". */
  name: z.string().min(3).max(200),
  /** ISO 3166 alpha-2 codes of the client countries it applies to. */
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
  /** The one sentence a notice may include, written and checked by a person. */
  citation: z.string().min(10).max(600),
  sourceUrl: z.url({ protocol: /^https$/ }),
  checkedOn: z.iso.date(),
  /** Only an entry the owner has checked against its source is ever used. */
  approved: z.boolean().default(false),
  /** What the stored facts must show before the law is cited. All listed conditions must hold. */
  appliesWhen: z
    .strictObject({
      clientRegions: z.array(z.string().regex(/^[A-Z0-9]{1,3}$/)).optional(),
      clientIsBusiness: z.boolean().optional(),
      freelancerHasUdyam: z.boolean().optional(),
      minAmountCents: z.number().int().positive().optional(),
      amountCurrency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
    })
    .default({}),
  /**
   * Anything else that decides whether it applies (a city, a registered business type). The app
   * can't check these, so a law with a condition is never cited automatically.
   */
  condition: z.string().min(3).max(300).optional(),
  /** How statutory interest is worked out (C4). Rates come from legal/reference-rates.json. */
  interest: z
    .discriminatedUnion("method", [
      z.strictObject({
        method: z.literal("simple_daily_over_reference"),
        basis: z.enum(["BOE_BASE", "ECB_MRO"]),
        marginBp: z.number().int().positive(),
        referenceDate: z.enum(["half_year_start", "due_date"]),
      }),
      z.strictObject({
        method: z.literal("monthly_compound_multiple"),
        basis: z.literal("RBI_BANK"),
        multiple: z.number().int().positive(),
        paymentDays: z.strictObject({
          withAgreement: z.number().int(),
          withoutAgreement: z.number().int(),
        }),
      }),
      z.strictObject({ method: z.literal("none") }),
    ])
    .default({ method: "none" }),
  /** Fixed sums by debt size, in the debt's own currency. `upToCents: null` is the top band. */
  compensation: z
    .array(
      z.strictObject({
        upToCents: z.number().int().positive().nullable(),
        amountCents: z.number().int().positive(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      }),
    )
    .default([]),
  /** Remedies that are text only, such as double damages. Never calculated. */
  damagesNote: z.string().max(300).optional(),
});

export const statuteTableSchema = z.strictObject({
  $comment: z.string().optional(),
  laws: z.array(lawSchema),
});

export type Law = z.output<typeof lawSchema>;

/** Reads the table, or says exactly what's wrong with it. */
export const parseStatuteTable = (raw: unknown): Law[] => {
  const parsed = statuteTableSchema.safeParse(raw);
  if (parsed.success) return parsed.data.laws;
  const where = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
  throw new Error(
    `legal/statutes.json is not valid (${where}). Fix the entry and run npm run ai:prompts.`,
  );
};

/** The stored facts a law's `appliesWhen` is checked against. */
export type LawFacts = {
  clientRegion: string | null;
  clientIsBusiness: boolean;
  freelancerHasUdyam: boolean;
  /** The debt being collected, in minor units. */
  amountCents: number;
  currency: string;
};

/** Whether an approved law's conditions are all met by the stored facts. */
export const lawApplies = (law: Law, country: string, facts: LawFacts): boolean => {
  const when = law.appliesWhen;
  return (
    law.approved &&
    law.condition === undefined &&
    law.countries.includes(country) &&
    (when.clientRegions === undefined ||
      (facts.clientRegion !== null && when.clientRegions.includes(facts.clientRegion))) &&
    (when.clientIsBusiness === undefined || when.clientIsBusiness === facts.clientIsBusiness) &&
    (when.freelancerHasUdyam === undefined ||
      when.freelancerHasUdyam === facts.freelancerHasUdyam) &&
    (when.amountCurrency === undefined || when.amountCurrency === facts.currency) &&
    (when.minAmountCents === undefined ||
      (when.amountCurrency !== undefined && facts.amountCents >= when.minAmountCents))
  );
};

export type CitationInput = {
  /** The project's late-fee clause, as written in the contract. */
  lateFeeClause: string | null;
  /** The client's country (ISO alpha-2). */
  country: string;
  facts: LawFacts;
  laws: readonly Law[];
};

/**
 * The contract clause first (it's what the client agreed to), then the first approved law whose
 * conditions the stored facts meet. A threshold without a currency never matches: an amount in
 * another currency can't be compared.
 */
export const pickCitation = ({
  lateFeeClause,
  country,
  facts,
  laws,
}: CitationInput): Citation | null => {
  const clause = lateFeeClause?.replace(/\s+/g, " ").trim();
  if (clause)
    return { kind: "contract", text: `Our contract's late-payment clause says: "${clause}"` };
  const law = laws.find((l) => lawApplies(l, country, facts));
  return law ? { kind: "statute", lawId: law.id, text: law.citation } : null;
};

/** Words that make a reference to law, fees or collection. Only the citation may hold them. */
const LEGAL_WORDS =
  /\b(laws?|legal(ly)?|statut(e|es|ory)|legislation|directive|regulations?|courts?|tribunal|lawsuit|sue|suing|attorneys?|lawyers?|solicitors?|collection agency|debt collect(or|ors|ion)|late fees?|interest|penalt(y|ies)|litigation|proceedings)\b/i;
/** "Act" as in a law's name; the verb "act" is fine. */
const ACT = /\bAct\b/;

/**
 * Whether a reminder's text makes a legal or fee reference it wasn't given. The citation and
 * the contract terms (quoted from the facts) are taken out first; anything left is invented.
 */
export const legalProblem = (
  text: string,
  {
    citation,
    contractTerms,
    laws,
  }: { citation: Citation | null; contractTerms: string | null; laws: readonly Law[] },
): string | undefined => {
  const quoted = [citation?.text, contractTerms].filter((t): t is string => Boolean(t));
  const rest = quoted.reduce((left, part) => left.split(part).join(" "), text);
  const named = laws.find((law) => rest.toLowerCase().includes(law.name.toLowerCase()));
  if (named || LEGAL_WORDS.test(rest) || ACT.test(rest)) {
    return citation
      ? "it makes a legal or fee reference other than the given citation"
      : "it makes a legal or fee reference, but this notice may cite nothing";
  }
  return undefined;
};
