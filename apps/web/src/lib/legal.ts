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
  /**
   * When it applies beyond the country (a city, a registered business type). The app can't
   * check these, so a law with a condition is never cited automatically.
   */
  condition: z.string().min(3).max(300).optional(),
});

export const statuteTableSchema = z.strictObject({
  $comment: z.string().optional(),
  laws: z.array(lawSchema),
});

export type Law = z.infer<typeof lawSchema>;

/** Reads the table, or says exactly what's wrong with it. */
export const parseStatuteTable = (raw: unknown): Law[] => {
  const parsed = statuteTableSchema.safeParse(raw);
  if (parsed.success) return parsed.data.laws;
  const where = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
  throw new Error(
    `legal/statutes.json is not valid (${where}). Fix the entry and run npm run ai:prompts.`,
  );
};

export type CitationInput = {
  /** The project's late-fee clause, as written in the contract. */
  lateFeeClause: string | null;
  /** The client's country (ISO alpha-2). */
  country: string;
  laws: readonly Law[];
};

/** The contract clause first (it's what the client agreed to), then a law for the country. */
export const pickCitation = ({ lateFeeClause, country, laws }: CitationInput): Citation | null => {
  const clause = lateFeeClause?.replace(/\s+/g, " ").trim();
  if (clause)
    return { kind: "contract", text: `Our contract's late-payment clause says: "${clause}"` };
  const law = laws.find((l) => l.countries.includes(country) && l.condition === undefined);
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
