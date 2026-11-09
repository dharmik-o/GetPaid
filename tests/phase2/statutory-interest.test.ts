import { describe, expect, it } from "vitest";
import { parseStatuteTable, type Law } from "@/lib/legal";
import { parseReferenceRates, type ReferenceRates } from "@/lib/reference-rates";
import { statutoryClaim, type ClaimInput } from "@/lib/statutory-interest";

// C-M1: interest and compensation are money, so they are checked to the cent against hand
// calculations. Every figure below is worked out in a comment, not by the code under test.

const SOURCE = { source: "https://example.test/rate", checkedOn: "2026-11-09" };
const entry = (from: string, bp: number, approved = true) => ({ from, bp, approved, ...SOURCE });

const RATES: ReferenceRates = parseReferenceRates({
  BOE_BASE: [
    entry("2025-01-01", 525),
    entry("2025-06-01", 450),
    entry("2025-12-01", 400),
    entry("2026-05-01", 350),
  ],
  ECB_MRO: [],
  RBI_BANK: [entry("2025-01-01", 650)],
});

const law = (id: string, country: string, extra: Record<string, unknown>): Law => {
  const [parsed] = parseStatuteTable({
    laws: [
      {
        id,
        name: "Test Act",
        countries: [country],
        citation: "Under the Test Act, interest may apply to late payments.",
        sourceUrl: "https://example.test/law",
        checkedOn: "2026-11-09",
        approved: true,
        ...extra,
      },
    ],
  });
  if (!parsed) throw new Error("law did not parse");
  return parsed;
};

const BANDS = [
  { upToCents: 99_999, amountCents: 4_000, currency: "GBP" },
  { upToCents: 999_999, amountCents: 7_000, currency: "GBP" },
  { upToCents: null, amountCents: 10_000, currency: "GBP" },
];
const UK = law("test-uk", "GB", {
  interest: {
    method: "simple_daily_over_reference",
    basis: "BOE_BASE",
    marginBp: 800,
    referenceDate: "half_year_start",
  },
  compensation: BANDS,
});
const INDIA = law("test-in", "IN", {
  interest: {
    method: "monthly_compound_multiple",
    basis: "RBI_BANK",
    multiple: 3,
    paymentDays: { withAgreement: 45, withoutAgreement: 15 },
  },
});

const claim = (overrides: Partial<ClaimInput>) =>
  statutoryClaim({
    law: UK,
    principalCents: 200_000,
    currency: "GBP",
    dueOn: "2026-03-15",
    asOf: "2026-04-29",
    rates: RATES,
    hasAgreement: false,
    ...overrides,
  });

describe("simple daily interest over a reference rate (UK)", () => {
  // GBP 2,000.00 due 15 Mar 2026, claimed 29 Apr 2026: 16 days left in March + 29 in April = 45 days.
  // The debt fell due in the first half of the year, so the rate is the one in force on 31 Dec 2025:
  // base rate 4.00% (400 bp) + 8.00% (800 bp) = 12.00% (1,200 bp).
  //   200,000 cents × 1,200 × 45 ÷ (10,000 × 365) = 10,800,000,000 ÷ 3,650,000 = 2,958.9041... → 2,959 cents.
  // The fixed sum for a debt of GBP 1,000.00 to under GBP 10,000.00 is GBP 70.00 (7,000 cents).
  it("works out the exact interest, the fixed sum and the total", () => {
    expect(claim({})).toMatchObject({
      principalCents: 200_000,
      interestCents: 2_959,
      compensationCents: 7_000,
      totalCents: 209_959,
      rateBp: 1_200,
      days: 45,
      method: "simple_daily_over_reference",
      lawId: "test-uk",
    });
  });

  // The plan's worked example: 1,325 bp for 45 days. Base 5.25% (525 bp) + 8.00% = 13.25%.
  //   200,000 × 1,325 × 45 ÷ 3,650,000 = 11,925,000,000 ÷ 3,650,000 = 3,267.1232... → 3,267 cents.
  it("gives 3,267 cents at 1,325 bp for 45 days on GBP 2,000.00, in words", () => {
    const result = claim({
      rates: parseReferenceRates({
        BOE_BASE: [entry("2025-01-01", 525)],
        ECB_MRO: [],
        RBI_BANK: [],
      }),
    });
    expect(result.interestCents).toBe(3_267);
    expect(result.rateBp).toBe(1_325);
    expect(result.totalCents).toBe(200_000 + 3_267 + 7_000);
    expect(result.explanation).toBe(
      "8.00% above the Bank of England base rate of 5.25% = 13.25% a year, simple, for 45 days on GBP 2,000.00.",
    );
  });

  it("takes the half-year reference date: 31 December for a first-half debt, 30 June for a second-half one", () => {
    expect(claim({ dueOn: "2026-03-15", asOf: "2026-04-01" }).rateBp).toBe(400 + 800); // rate on 31 Dec 2025
    expect(claim({ dueOn: "2026-08-15", asOf: "2026-09-01" }).rateBp).toBe(350 + 800); // rate on 30 Jun 2026
    // 30 June is still the first half of the year; 1 July is the second.
    expect(claim({ dueOn: "2026-06-30", asOf: "2026-07-10" }).rateBp).toBe(400 + 800);
    expect(claim({ dueOn: "2026-07-01", asOf: "2026-07-10" }).rateBp).toBe(350 + 800);
  });

  it("doesn't count the due date itself, and never goes negative", () => {
    expect(claim({ dueOn: "2026-04-29" })).toMatchObject({ days: 0, interestCents: 0 });
    expect(claim({ dueOn: "2026-05-30" })).toMatchObject({ days: 0, interestCents: 0 });
  });

  it("gives no interest, not a guess, when the rate isn't approved or doesn't exist yet", () => {
    const unapproved = parseReferenceRates({
      BOE_BASE: [entry("2025-01-01", 525, false)],
      ECB_MRO: [],
      RBI_BANK: [],
    });
    const before = parseReferenceRates({
      BOE_BASE: [entry("2026-04-01", 525)],
      ECB_MRO: [],
      RBI_BANK: [],
    });
    for (const rates of [unapproved, before]) {
      const result = claim({ rates });
      expect(result.interestCents).toBeNull();
      expect(result.rateBp).toBeNull();
      // The fixed sum still applies: it needs no rate.
      expect(result).toMatchObject({ compensationCents: 7_000, totalCents: 207_000 });
      expect(result.explanation).toContain("No approved reference rate");
    }
  });
});

describe("the fixed sum", () => {
  it("steps at the band edges: GBP 999.99 → 40, GBP 1,000.00 → 70, GBP 9,999.99 → 70, GBP 10,000.00 → 100", () => {
    expect(claim({ principalCents: 99_999 }).compensationCents).toBe(4_000);
    expect(claim({ principalCents: 100_000 }).compensationCents).toBe(7_000);
    expect(claim({ principalCents: 999_999 }).compensationCents).toBe(7_000);
    expect(claim({ principalCents: 1_000_000 }).compensationCents).toBe(10_000);
  });

  it("is nothing in another currency, but interest is still worked out", () => {
    const result = claim({ currency: "USD" });
    expect(result.compensationCents).toBe(0);
    expect(result.interestCents).toBe(2_959);
  });

  it("is nothing for a law with no bands, and a law with no interest has none", () => {
    const none = law("test-us", "US", { interest: { method: "none" } });
    expect(claim({ law: none })).toMatchObject({
      interestCents: null,
      rateBp: null,
      compensationCents: 0,
      totalCents: 200_000,
      method: "none",
    });
  });
});

describe("monthly compound interest at a multiple of the bank rate (MSMED)", () => {
  // INR 100,000.00 = 10,000,000 paise, due 1 Jan 2026. Bank rate 6.50% (650 bp); three times is
  // 19.50% (1,950 bp) a year, so 1,950 ÷ 12 = 162.5 bp = 1.625% a month.
  // After 3 full months (1 Apr 2026): 1.01625³ = 1.049546478515625 (1.01625² = 1.0327640625).
  //   10,000,000 × 1.049546478515625 = 10,495,464.78515625 → 10,495,465 → interest 495,465 paise.
  it("compounds each full month", () => {
    const result = claim({
      law: INDIA,
      principalCents: 10_000_000,
      currency: "INR",
      dueOn: "2026-01-01",
      asOf: "2026-04-01",
    });
    expect(result).toMatchObject({
      interestCents: 495_465,
      rateBp: 1_950,
      compensationCents: 0,
      totalCents: 10_495_465,
    });
    expect(result.explanation).toBe(
      "Three times the Reserve Bank of India's bank rate of 6.50% = 19.50% a year, compounded monthly, for 3 months on INR 100,000.00.",
    );
  });

  // 10 days later (11 Apr 2026): simple interest on the compounded balance for 10 of 30 days at 1.625% a month:
  //   10,495,464.78515625 × 0.01625 × 10 ÷ 30 = 56,850.43425... ; balance 10,552,315.2194... → 10,552,315 → interest 552,315.
  it("adds the leftover days as simple interest for a 30-day month", () => {
    const result = claim({
      law: INDIA,
      principalCents: 10_000_000,
      currency: "INR",
      dueOn: "2026-01-01",
      asOf: "2026-04-11",
    });
    expect(result.interestCents).toBe(552_315);
    expect(result.days).toBe(100);
    expect(result.explanation).toContain("for 3 months and 10 days");
  });

  it("is simple interest only for less than a month", () => {
    // 15 days: 10,000,000 × (1 + 0.01625 × 15 ÷ 30) = 10,000,000 × 1.008125 = 10,081,250 → 81,250 paise.
    expect(
      claim({
        law: INDIA,
        principalCents: 10_000_000,
        currency: "INR",
        dueOn: "2026-01-01",
        asOf: "2026-01-16",
      }).interestCents,
    ).toBe(81_250);
  });

  it("starts from acceptance plus the legal period when no due date was agreed", () => {
    const base = {
      law: INDIA,
      principalCents: 10_000_000,
      currency: "INR",
      dueOn: null,
      acceptedOn: "2026-01-01",
      asOf: "2026-02-01",
    };
    // Without a written agreement: 15 days → appointed 16 Jan 2026, so 16 days (1 Month would need 16 Feb).
    expect(claim({ ...base, hasAgreement: false }).days).toBe(16);
    // With one: 45 days → appointed 15 Feb 2026, which is after the claim date: no days, no interest.
    expect(claim({ ...base, hasAgreement: true })).toMatchObject({ days: 0, interestCents: 0 });
    expect(claim({ ...base, acceptedOn: null }).interestCents).toBeNull();
  });

  it("gives no interest without an approved bank rate", () => {
    const none = parseReferenceRates({ BOE_BASE: [], ECB_MRO: [], RBI_BANK: [] });
    expect(
      claim({
        law: INDIA,
        principalCents: 10_000_000,
        currency: "INR",
        dueOn: "2026-01-01",
        rates: none,
      }).interestCents,
    ).toBeNull();
  });
});

describe("every amount is a whole number of minor units", () => {
  it("never produces a fraction, whatever the inputs", () => {
    for (const principalCents of [1, 99, 12_345, 99_999, 7_654_321]) {
      for (const asOf of ["2026-03-16", "2026-04-29", "2027-03-15"]) {
        for (const target of [UK, INDIA]) {
          const result = claim({ law: target, principalCents, asOf, currency: "GBP" });
          for (const value of [result.interestCents, result.compensationCents, result.totalCents]) {
            if (value !== null) expect(Number.isInteger(value)).toBe(true);
          }
        }
      }
    }
  });
});
