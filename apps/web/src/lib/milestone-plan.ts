import type { FieldIssue } from "./field-issues";
import { formatDay, formatMoney } from "./format";

// Milestone totals: percentages to minor units, and the plan-level checks.
// Integer maths only (BigInt where a product could pass 2^53). Pure: safe in client components.

export type PlanItem = {
  name: string;
  deadline: string;
} & (
  { amountCents: number; percentBp?: undefined } | { percentBp: number; amountCents?: undefined }
);

export type PlanCheck = { errors: FieldIssue[]; warnings: FieldIssue[] };

const BP_WHOLE = 10000n;

/** total × bp / 10000, rounded half up. */
const shareOf = (totalCents: number, percentBp: number): bigint =>
  (BigInt(totalCents) * BigInt(percentBp) + BP_WHOLE / 2n) / BP_WHOLE;

/**
 * Each milestone's amount in minor units. Percentages are rounded, and the last percentage
 * milestone absorbs the remainder, so a valid plan always adds up to the project total exactly.
 * Typed amounts are never changed.
 */
export const milestoneCents = (items: readonly PlanItem[], totalCents: number): number[] => {
  const cents = items.map((item) =>
    item.amountCents === undefined ? shareOf(totalCents, item.percentBp) : BigInt(item.amountCents),
  );
  const lastPercent = items.findLastIndex((item) => item.amountCents === undefined);
  if (lastPercent >= 0) {
    const others = cents.reduce(
      (sum, value, index) => (index === lastPercent ? sum : sum + value),
      0n,
    );
    cents[lastPercent] = BigInt(totalCents) - others;
  }
  return cents.map(Number);
};

const formatPercentBp = (bp: bigint): string => {
  const whole = bp / 100n;
  const fraction = (bp % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction}%` : `${whole.toString()}%`;
};

const totalsError = (
  items: readonly PlanItem[],
  totalCents: number,
  currency: string,
): FieldIssue[] => {
  const amounts = items.reduce((sum, item) => sum + BigInt(item.amountCents ?? 0), 0n);
  const percents = items.reduce((sum, item) => sum + BigInt(item.percentBp ?? 0), 0n);
  const total = BigInt(totalCents);
  // amounts + total × percents / 10000 must equal total exactly (compared without dividing).
  if (amounts * BP_WHOLE + total * percents === total * BP_WHOLE) return [];

  const fix = "Change them so they match.";
  const message =
    amounts === 0n
      ? `Milestones add up to ${formatPercentBp(percents)}, but they must add up to 100%. ${fix}`
      : `Milestones add up to ${formatMoney(
          Number(amounts + (total * percents) / BP_WHOLE),
          currency,
        )}, but the project total is ${formatMoney(totalCents, currency)}. ${fix}`;
  return [{ field: "milestones", message }];
};

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isFullDate = (value: string): boolean =>
  FULL_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** A warning for each milestone due before the one listed above it. */
const orderWarnings = (items: readonly PlanItem[]): FieldIssue[] =>
  items.flatMap((item, index) => {
    const previous = items[index - 1];
    // A row still being typed has no full date yet: nothing to compare.
    if (!previous || !isFullDate(item.deadline) || !isFullDate(previous.deadline)) return [];
    if (item.deadline >= previous.deadline) return [];
    return [
      {
        field: `milestones.${String(index)}.deadline`,
        message: `${item.name} is due (${formatDay(item.deadline)}) before ${previous.name} (${formatDay(
          previous.deadline,
        )}). You can still save; check the order is right.`,
      },
    ];
  });

/** Totals must match the project (or 100%); deadlines out of order only warn. An empty plan is fine. */
export const checkPlan = (
  items: readonly PlanItem[],
  totalCents: number,
  currency: string,
): PlanCheck =>
  items.length === 0
    ? { errors: [], warnings: [] }
    : { errors: totalsError(items, totalCents, currency), warnings: orderWarnings(items) };
