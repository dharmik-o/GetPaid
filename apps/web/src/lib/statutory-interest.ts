import { DateTime } from "luxon";
import { formatMoney } from "./format";
import type { Law } from "./legal";
import { rateOn, type RateBasis, type ReferenceRates } from "./reference-rates";

// Statutory interest and fixed compensation on an overdue invoice, for one law from
// legal/statutes.json and the owner-approved reference rates. Pure. Money is integer minor units,
// and all of the maths is exact integers (BigInt), rounded half up once, at the end. A rate that
// isn't approved gives no interest at all: the number is `null`, never a guess. Nothing here writes
// law: the law's own entry says which method and which margin to use.

export type Claim = {
  principalCents: number;
  /** null when there is no approved rate to calculate with, or the law has no interest. */
  interestCents: number | null;
  compensationCents: number;
  totalCents: number;
  /** The yearly rate in basis points the interest was worked out at. */
  rateBp: number | null;
  /** Days from the appointed day to `asOf`. */
  days: number;
  method: Law["interest"]["method"];
  lawId: string;
  /** One plain sentence saying how the interest was worked out. */
  explanation: string;
};

export type ClaimInput = {
  law: Law;
  principalCents: number;
  currency: string;
  /** The agreed due date, or null when none was agreed (MSMED then counts from acceptance). */
  dueOn: string | null;
  asOf: string;
  rates: ReferenceRates;
  /** A written agreement exists: it decides which MSMED payment period applies without a due date. */
  hasAgreement: boolean;
  /** The day the goods or services were accepted; used only with no agreed due date (MSMED). */
  acceptedOn?: string | null;
};

const BASIS_NAMES: Record<RateBasis, string> = {
  BOE_BASE: "the Bank of England base rate",
  ECB_MRO: "the European Central Bank's main refinancing rate",
  RBI_BANK: "the Reserve Bank of India's bank rate",
};

const MULTIPLES: Record<number, string> = { 2: "Two", 3: "Three", 4: "Four" };

const day = (iso: string): DateTime => DateTime.fromISO(iso, { zone: "utc" });

const daysBetween = (from: string, to: string): number =>
  Math.max(0, Math.round(day(to).diff(day(from), "days").days));

/** Basis points as a percentage, with integers only: 1175 is "11.75%". */
const percent = (bp: number): string =>
  `${String(Math.floor(bp / 100))}.${String(bp % 100).padStart(2, "0")}%`;

const plural = (count: number, unit: string): string =>
  `${String(count)} ${unit}${count === 1 ? "" : "s"}`;

/** numerator ÷ denominator, rounded half up. Both are positive. */
const roundHalfUp = (numerator: bigint, denominator: bigint): bigint =>
  (2n * numerator + denominator) / (2n * denominator);

/**
 * The reference date for a "half year" law. The UK rule takes the rate in force on 31 December for
 * a debt falling due from 1 January to 30 June, and on 30 June for one falling due from 1 July to
 * 31 December. The Irish rule uses the same two dates here (a rate change on exactly 1 January or
 * 1 July could differ by a day: see docs/DECISIONS.md).
 */
const halfYearReference = (dueOn: string): string => {
  const due = day(dueOn);
  return due.month <= 6 ? `${String(due.year - 1)}-12-31` : `${String(due.year)}-06-30`;
};

type Interest = { cents: number | null; rateBp: number | null; sentence: string };

const simpleDaily = (
  method: Extract<Law["interest"], { method: "simple_daily_over_reference" }>,
  input: ClaimInput,
  days: number,
): Interest => {
  const { principalCents, currency, dueOn, rates } = input;
  const reference =
    dueOn === null ? null : method.referenceDate === "due_date" ? dueOn : halfYearReference(dueOn);
  const base = reference === null ? null : rateOn(rates, method.basis, reference);
  if (base === null) {
    return {
      cents: null,
      rateBp: null,
      sentence: "No approved reference rate is available, so no interest is calculated",
    };
  }
  const rateBp = base + method.marginBp;
  const cents = roundHalfUp(BigInt(principalCents) * BigInt(rateBp) * BigInt(days), 10_000n * 365n);
  return {
    cents: Number(cents),
    rateBp,
    sentence: `${percent(method.marginBp)} above ${BASIS_NAMES[method.basis]} of ${percent(base)} = ${percent(rateBp)} a year, simple, for ${plural(days, "day")} on ${formatMoney(principalCents, currency)}`,
  };
};

/**
 * MSMED Act (India), section 16: compound interest with monthly rests at a multiple of the bank rate
 * (three times, in the law's entry). The appointed day is the agreed due date, or, with none,
 * acceptance plus the law's payment period. The method, written out so it can be checked:
 *   - yearly rate R = multiple × the bank rate in force on the appointed day, in basis points;
 *   - each full calendar month from the appointed day multiplies the balance by (1 + R / 12);
 *   - the days left over add simple interest on that balance at R / 12 for a 30-day month;
 *   - the interest is the result minus the principal, rounded half up once, as exact integers.
 * The 30-day month for the leftover days is a convention the owner should confirm with an
 * accountant or lawyer (docs/NEEDS_YOU.md).
 */
const monthlyCompound = (
  method: Extract<Law["interest"], { method: "monthly_compound_multiple" }>,
  input: ClaimInput,
): { interest: Interest; days: number } => {
  const { principalCents, currency, dueOn, asOf, rates, hasAgreement, acceptedOn } = input;
  const period = hasAgreement
    ? method.paymentDays.withAgreement
    : method.paymentDays.withoutAgreement;
  const appointed =
    dueOn ?? (acceptedOn ? day(acceptedOn).plus({ days: period }).toISODate() : null);
  if (appointed === null) {
    return {
      days: 0,
      interest: {
        cents: null,
        rateBp: null,
        sentence: "No due date or acceptance date is known, so no interest is calculated",
      },
    };
  }
  const days = daysBetween(appointed, asOf);
  const bank = rateOn(rates, method.basis, appointed);
  if (bank === null) {
    return {
      days,
      interest: {
        cents: null,
        rateBp: null,
        sentence: "No approved reference rate is available, so no interest is calculated",
      },
    };
  }
  const yearlyBp = method.multiple * bank;
  const start = day(appointed);
  const end = day(asOf);
  let months = 0;
  while (start.plus({ months: months + 1 }) <= end) months += 1;
  const leftover = Math.max(0, Math.round(end.diff(start.plus({ months }), "days").days));
  const rate = BigInt(yearlyBp);
  // balance = P × ((120000 + R) / 120000)^months × (1 + R × leftover / (120000 × 30)), all exact.
  const monthly = 120_000n;
  const dailyScale = 3_600_000n;
  const numerator =
    BigInt(principalCents) *
    (monthly + rate) ** BigInt(months) *
    (dailyScale + rate * BigInt(leftover));
  const denominator = monthly ** BigInt(months) * dailyScale;
  const total = roundHalfUp(numerator, denominator);
  const multiple = MULTIPLES[method.multiple] ?? String(method.multiple);
  const length = [
    months > 0 ? plural(months, "month") : null,
    leftover > 0 || months === 0 ? plural(leftover, "day") : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" and ");
  return {
    days,
    interest: {
      cents: Number(total) - principalCents,
      rateBp: yearlyBp,
      sentence: `${multiple} times ${BASIS_NAMES[method.basis]} of ${percent(bank)} = ${percent(yearlyBp)} a year, compounded monthly, for ${length} on ${formatMoney(principalCents, currency)}`,
    },
  };
};

/** The fixed sum for this size of debt, only in the currency the law states it in. */
const compensation = (law: Law, principalCents: number, currency: string): number => {
  const band = law.compensation.find((b) => b.upToCents === null || principalCents <= b.upToCents);
  return band?.currency === currency ? band.amountCents : 0;
};

const plain = (text: string): string => text.replaceAll(String.fromCharCode(160), " ");

export const statutoryClaim = (input: ClaimInput): Claim => {
  const { law, principalCents, currency, dueOn, asOf } = input;
  const method = law.interest;
  let days = dueOn === null ? 0 : daysBetween(dueOn, asOf);
  let interest: Interest = {
    cents: null,
    rateBp: null,
    sentence: "This law sets no interest rate",
  };
  if (method.method === "simple_daily_over_reference") interest = simpleDaily(method, input, days);
  if (method.method === "monthly_compound_multiple") {
    const worked = monthlyCompound(method, input);
    interest = worked.interest;
    days = worked.days;
  }
  const compensationCents = compensation(law, principalCents, currency);
  return {
    principalCents,
    interestCents: interest.cents,
    compensationCents,
    totalCents: principalCents + (interest.cents ?? 0) + compensationCents,
    rateBp: interest.rateBp,
    days,
    method: method.method,
    lawId: law.id,
    explanation: plain(`${interest.sentence}.`),
  };
};
