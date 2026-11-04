import { z } from "zod";
import { draftSchema, type Draft } from "./ai-schemas";
import { CURRENCY_SYMBOLS } from "./currencies";
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
/** Between a unit and its number: a space at most, never a line break. */
const GAP = `[ ${String.fromCharCode(0xa0)}]?`;
const LETTER_SYMBOLS = Object.keys(CURRENCY_SYMBOLS)
  .filter((symbol) => /^\p{L}+$/u.test(symbol))
  .join("|");
const UNIT_BEFORE = String.raw`(?:[A-Z]{1,3})?\p{Sc}|\b[A-Z]{3}|\b(?:${LETTER_SYMBOLS})`;
const UNIT_AFTER = String.raw`\p{Sc}|[A-Z]{3}\b|(?:${LETTER_SYMBOLS})(?![\p{L}\p{N}])`;
/**
 * A number with a unit on either side. With no unit before, it can't be the tail of a word or code
 * (FPR-000042). A unit after it can't start the next amount ("2026 USD 1,500" is one amount).
 */
const AMOUNT_PATTERN = new RegExp(
  String.raw`(?:(${UNIT_BEFORE})${GAP}|(?<![\w-]))(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?` +
    String.raw`(?:${GAP}(${UNIT_AFTER})(?!${GAP}\d))?`,
  "gu",
);

/** "1,500.00" and "1500" are the same amount: digits only, trailing zero decimals dropped. */
const amountKey = (whole: string, fraction: string | undefined): string => {
  const digits = whole.replace(/,/g, "").replace(/^0+(?=\d)/, "");
  const decimals = (fraction ?? "").replace(/0+$/, "");
  return decimals ? `${digits}.${decimals}` : digits;
};

/** Three capitals that aren't a currency code are just a word ("INV 2026"). */
const isUnit = (text: string | undefined): text is string =>
  text !== undefined && (!/^[A-Z]{3}$/.test(text) || CURRENCY_CODES.has(text));

export type Money = { unit: string; amount: string; written: string };

/** Money amounts in a text, with the code or symbol they're written in. URLs skipped. */
export const moneyIn = (text: string): Money[] => {
  const found: Money[] = [];
  for (const match of text.replace(URL_PATTERN, " ").matchAll(AMOUNT_PATTERN)) {
    const [written, before, whole, fraction, after] = match;
    const unit = [before, after].find(isUnit);
    if (unit && whole) found.push({ unit, amount: amountKey(whole, fraction), written });
  }
  return found;
};

/** The currencies a unit can mean: "USD$" is USD, "X$" is any $, and an unknown symbol only itself. */
const currenciesOf = (unit: string): readonly string[] => {
  if (CURRENCY_CODES.has(unit)) return [unit];
  const beforeSymbol = unit.slice(0, -1);
  if (CURRENCY_CODES.has(beforeSymbol)) return [beforeSymbol];
  return CURRENCY_SYMBOLS[unit] ?? CURRENCY_SYMBOLS[unit.slice(-1)] ?? [unit];
};

const sameCurrency = (a: Money, b: Money): boolean => {
  const others = currenciesOf(b.unit);
  return currenciesOf(a.unit).some((currency) => others.includes(currency));
};

const factTexts = (request: DraftRequest): string[] =>
  Object.values(request.facts).flatMap((value) => {
    if (typeof value === "string") return [value];
    if (value && typeof value === "object") return Object.values(value).map(String);
    return [];
  });

/** Every amount must be in the facts, in a currency the facts give it in. */
const amountProblems = (text: string, request: DraftRequest): string[] => {
  const facts = factTexts(request).flatMap(moneyIn);
  const problems = new Set<string>();
  for (const money of moneyIn(text)) {
    const matches = facts.filter((fact) => fact.amount === money.amount);
    if (matches.length === 0) problems.add("it mentions an amount that isn't in the facts");
    else if (!matches.some((fact) => sameCurrency(fact, money))) {
      problems.add(`it gives an amount in the wrong currency: ${money.written}`);
    }
  }
  return [...problems];
};

/** Names a draft may quote word for word, even if one looks like a date ("March 15 launch"). */
const quotedNames = (request: DraftRequest): string[] => {
  const { facts } = request;
  if (request.kind === "auto_pay_approval") {
    return [facts.freelancerName, facts.clientName, request.facts.retainerName];
  }
  if (request.kind === "hold_approval") {
    return [
      facts.freelancerName,
      facts.clientName,
      request.facts.projectTitle,
      request.facts.milestoneName,
    ];
  }
  if (request.kind === "maintenance") {
    return [
      request.facts.freelancerName,
      request.facts.clientName,
      request.facts.projectTitle,
      request.facts.task,
    ];
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
  /** A hand edit: every date in it is the freelancer's own. Only the AI's dates are checked. */
  typedByFreelancer?: boolean;
};

/** Problems with a schema-valid draft, in words the log and tests can show. Empty = fine. */
export const draftProblems = (
  draft: Draft,
  request: DraftRequest,
  laws: readonly Law[] = [],
  { alsoAllowed = [], typedByFreelancer = false }: DraftCheckOptions = {},
): string[] => {
  const problems: string[] = [];
  const text = `${draft.subject}\n${draft.body}`;
  if (/[\r\n]/.test(draft.subject)) problems.push("the subject has a line break");
  if (request.kind === "auto_pay_approval" || request.kind === "hold_approval") {
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
  problems.push(...amountProblems(text, request));
  const dates = typedByFreelancer
    ? []
    : unknownDates(text, {
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
      request.kind === "maintenance" ||
      request.kind === "auto_pay_approval" ||
      request.kind === "hold_approval"
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
