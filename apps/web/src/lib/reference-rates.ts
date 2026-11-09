import { z } from "zod";

// Reference rates for statutory interest (legal/reference-rates.json), kept by the owner. Pure:
// the table is passed in. Only entries the owner marked approved are ever used.

export const RATE_BASES = ["BOE_BASE", "ECB_MRO", "RBI_BANK"] as const;
export type RateBasis = (typeof RATE_BASES)[number];

const entrySchema = z.strictObject({
  /** The first day the rate applies. */
  from: z.iso.date(),
  /** Basis points: 100 bp = 1%. */
  bp: z.number().int().min(0).max(10_000),
  source: z.url({ protocol: /^https$/ }),
  checkedOn: z.iso.date(),
  approved: z.boolean().default(false),
});

const rateList = z.array(entrySchema);

export const referenceRatesSchema = z.strictObject({
  $comment: z.string().optional(),
  BOE_BASE: rateList,
  ECB_MRO: rateList,
  RBI_BANK: rateList,
});

export type RateEntry = z.output<typeof entrySchema>;
export type ReferenceRates = Record<RateBasis, RateEntry[]>;

/** Reads the table, or says exactly what's wrong with it. */
export const parseReferenceRates = (raw: unknown): ReferenceRates => {
  const parsed = referenceRatesSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `legal/reference-rates.json is not valid (${where}). Fix the entry and run npm run ai:prompts.`,
    );
  }
  const { BOE_BASE, ECB_MRO, RBI_BANK } = parsed.data;
  return { BOE_BASE, ECB_MRO, RBI_BANK };
};

/**
 * The approved rate in force on an ISO date (the latest entry that started on or before it), or
 * null when there is none. An unapproved entry is skipped, never replaced by an older rate: a
 * date whose rate hasn't been checked has no rate.
 */
export const rateOn = (rates: ReferenceRates, basis: RateBasis, date: string): number | null => {
  const inForce = rates[basis]
    .filter((entry) => entry.from <= date)
    .reduce<RateEntry | undefined>(
      (latest, entry) => (latest && latest.from > entry.from ? latest : entry),
      undefined,
    );
  return inForce?.approved ? inForce.bp : null;
};
