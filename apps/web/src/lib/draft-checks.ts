import { z } from "zod";
import { draftSchema, type Draft } from "./ai-schemas";
import { unknownDates } from "./draft-dates";
import type { DraftRequest } from "./draft-facts";
import { legalProblem, type Law } from "./legal";

// Checks on a drafted email beyond its JSON shape. A draft that fails them is treated like
// one that fails the schema: the router retries once, then uses the fixed template, and a
// failing draft is never stored or sent. Pure.

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

/** Links in a text, without the full stop or comma that ends a sentence. */
const urlsIn = (text: string): string[] =>
  [...text.matchAll(URL_PATTERN)].map(([url]) => url.replace(/[.,;:!?]+$/, ""));

const CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));
const SYMBOLS = "$€£¥₹";
/** A number that isn't the tail of a word or code (FPR-000042). */
const NUMBER = String.raw`(?<![\w-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?`;
/** Between a code and its number: a space at most, never a line break. */
const GAP = `[ ${String.fromCharCode(0xa0)}]?`;
const AMOUNT_PATTERN = new RegExp(
  String.raw`(?:\b([A-Z]{3})${GAP}|([${SYMBOLS}])${GAP})${NUMBER}|${NUMBER}${GAP}([A-Z]{3})\b`,
  "g",
);

/** "1,500.00" and "1500" are the same amount: digits only, trailing zero decimals dropped. */
const amountKey = (whole: string, fraction: string | undefined): string => {
  const digits = whole.replace(/,/g, "").replace(/^0+(?=\d)/, "");
  const decimals = (fraction ?? "").replace(/0+$/, "");
  return decimals ? `${digits}.${decimals}` : digits;
};

/** Money amounts in a text (with a currency code or symbol), as comparable keys. URLs skipped. */
export const amountsIn = (text: string): string[] => {
  const keys: string[] = [];
  for (const match of text.replace(URL_PATTERN, " ").matchAll(AMOUNT_PATTERN)) {
    const [, codeBefore, symbol, whole, fraction, wholeAfter, fractionAfter, codeAfter] = match;
    const code = codeBefore ?? codeAfter;
    if (!symbol && !(code && CURRENCY_CODES.has(code))) continue;
    const amount = whole ?? wholeAfter;
    if (amount) keys.push(amountKey(amount, whole ? fraction : fractionAfter));
  }
  return keys;
};

const factTexts = (request: DraftRequest): string[] =>
  Object.values(request.facts).flatMap((value) => {
    if (typeof value === "string") return [value];
    if (value && typeof value === "object") return Object.values(value).map(String);
    return [];
  });

/** Names a draft may quote word for word, even if one looks like a date ("March 15 launch"). */
const quotedNames = (request: DraftRequest): string[] => {
  const { facts } = request;
  if (request.kind === "auto_pay_approval") {
    return [facts.freelancerName, facts.clientName, request.facts.retainerName];
  }
  if (request.kind === "maintenance") {
    return [request.facts.freelancerName, request.facts.clientName, request.facts.projectTitle, request.facts.task];
  }
  const reminder = request.facts;
  return [
    facts.freelancerName,
    facts.clientName,
    reminder.projectTitle,
    reminder.milestoneName,
    reminder.deliverable ?? "",
    reminder.invoiceNumber,
    reminder.citation?.text ?? "",
  ];
};

export type DraftCheckOptions = {
  /** The freelancer's own words: a date they named or already approved can stay in the draft. */
  alsoAllowed?: readonly string[];
};

/** Problems with a schema-valid draft, in words the log and tests can show. Empty = fine. */
export const draftProblems = (
  draft: Draft,
  request: DraftRequest,
  laws: readonly Law[] = [],
  { alsoAllowed = [] }: DraftCheckOptions = {},
): string[] => {
  const problems: string[] = [];
  const text = `${draft.subject}\n${draft.body}`;
  if (/[\r\n]/.test(draft.subject)) problems.push("the subject has a line break");
  if (request.kind === "auto_pay_approval") {
    const { approvalLink } = request.facts;
    if (!draft.body.includes(approvalLink)) {
      problems.push("the body doesn't include the approval link");
    }
    if (urlsIn(text).some((url) => url !== approvalLink)) {
      problems.push("it has a link other than the approval link");
    }
  } else if (request.kind !== "maintenance") {
    const { payLink } = request.facts;
    if (!draft.body.includes(payLink)) problems.push("the body doesn't include the pay link");
    if (urlsIn(text).some((url) => url !== payLink)) {
      problems.push("it has a link other than the pay link");
    }
  } else if (urlsIn(text).length > 0) {
    problems.push("it has a link, but a maintenance heads-up has none");
  }
  const allowed = new Set(factTexts(request).flatMap(amountsIn));
  const invented = amountsIn(text).filter((key) => !allowed.has(key));
  if (invented.length > 0) problems.push("it mentions an amount that isn't in the facts");
  const dates = unknownDates(text, {
    facts: factTexts(request),
    quoted: quotedNames(request),
    alsoAllowed,
  });
  for (const date of dates) {
    problems.push(`it mentions a date that isn't in the facts: ${date}`);
  }
  // Legal gating: only Tier 3 may cite, and only what it was given.
  const legal = legalProblem(text, {
    citation: request.kind === "tier3" ? request.facts.citation : null,
    contractTerms:
      request.kind === "maintenance" || request.kind === "auto_pay_approval"
        ? null
        : request.facts.contractTerms,
    laws,
  });
  if (legal) problems.push(legal);
  return problems;
};

/** The draft schema plus these checks, for the router: a failure counts as an invalid answer. */
export const checkedDraftSchema = (
  request: DraftRequest,
  laws: readonly Law[] = [],
  options: DraftCheckOptions = {},
): z.ZodType<Draft> =>
  draftSchema.superRefine((draft, ctx) => {
    for (const message of draftProblems(draft, request, laws, options)) {
      ctx.addIssue({ code: "custom", message });
    }
  });
