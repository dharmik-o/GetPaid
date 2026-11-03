import { z } from "zod";
import { toFieldIssues, type FieldIssue } from "./field-issues";
import { formatFullDay, formatMoney } from "./format";

// Installments replace PayPal partial payments: one milestone split into 2 to 12 separate
// invoices with fixed amounts. Integer cents only (BigInt where a sum could pass 2^53).
// Pure: safe in client components.

export const MIN_INSTALLMENTS = 2;
export const MAX_INSTALLMENTS = 12;

/** One installment: its amount, and its due date (null = per the payment terms when invoiced). */
export type InstallmentItem = { amountCents: number; dueDate: string | null };

const itemSchema = z.strictObject({
  amountCents: z
    .int("must be a whole number of minor units (cents)")
    .min(1, "must be more than 0")
    .max(Number.MAX_SAFE_INTEGER, "is too large"),
  dueDate: z.iso.date({ error: "must be a date like 2026-12-31" }).nullable(),
});

export const installmentItemsSchema = z.array(itemSchema, { error: "must be a list" });

export type ParsedItems =
  { ok: true; items: InstallmentItem[] } | { ok: false; errors: FieldIssue[] };

/** Checks the shape of each installment; `checkInstallments` checks the plan as a whole. */
export const parseInstallmentItems = (raw: unknown): ParsedItems => {
  const parsed = installmentItemsSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, items: parsed.data }
    : { ok: false, errors: toFieldIssues(parsed.error, { prefix: "items", noun: "field" }) };
};

const countMessage = `must have ${String(MIN_INSTALLMENTS)} to ${String(MAX_INSTALLMENTS)} installments`;

/**
 * Even shares: each total ÷ count rounded half up, and the last absorbs the remainder (the same
 * rule as milestone percentages), so the parts always add up to the total exactly.
 */
export const splitEvenly = (totalCents: number, count: number): number[] => {
  if (!Number.isInteger(count) || count < MIN_INSTALLMENTS || count > MAX_INSTALLMENTS) {
    throw new Error(`A plan ${countMessage}; got ${String(count)}.`);
  }
  const total = BigInt(totalCents);
  const parts = BigInt(count);
  const share = (2n * total + parts) / (2n * parts);
  const last = total - share * (parts - 1n);
  if (share < 1n || last < 1n) {
    throw new Error(
      `The amount is too small to split into ${String(count)} installments of at least one minor unit each.`,
    );
  }
  return [...Array<number>(count - 1).fill(Number(share)), Number(last)];
};

/** A deposit plan: the deposit at kickoff, the rest on delivery; each due per the terms then. */
export const depositItems = (depositCents: number, milestoneCents: number): InstallmentItem[] => [
  { amountCents: depositCents, dueDate: null },
  { amountCents: milestoneCents - depositCents, dueDate: null },
];

export type PlanRules = {
  totalCents: number;
  currency: string;
  /** Setup and client-request plans need a date on every installment. */
  datesRequired: boolean;
  /** Today in the client's time zone; due dates before it are refused. */
  today: string;
};

const sumOf = (items: readonly InstallmentItem[]): bigint =>
  items.reduce((sum, item) => sum + BigInt(item.amountCents), 0n);

const dateIssues = (items: readonly InstallmentItem[], rules: PlanRules): FieldIssue[] =>
  items.flatMap((item, index): FieldIssue[] => {
    const field = `items.${String(index)}.dueDate`;
    if (item.dueDate === null) {
      return rules.datesRequired ? [{ field, message: "is required" }] : [];
    }
    if (item.dueDate < rules.today) {
      return [
        {
          field,
          message: `has passed (${formatFullDay(item.dueDate)}). Pick today or a later date.`,
        },
      ];
    }
    const previousIndex = items.slice(0, index).findLastIndex((other) => other.dueDate !== null);
    const previousDate = items[previousIndex]?.dueDate;
    if (previousDate && item.dueDate < previousDate) {
      return [
        {
          field,
          message: `is before installment ${String(previousIndex + 1)}'s due date. Put the installments in date order.`,
        },
      ];
    }
    return [];
  });

/** Whole-plan checks: 2 to 12 installments, exact total, due dates present, in order, not past. */
export const checkInstallments = (
  items: readonly InstallmentItem[],
  rules: PlanRules,
): FieldIssue[] => {
  if (items.length < MIN_INSTALLMENTS || items.length > MAX_INSTALLMENTS) {
    return [{ field: "items", message: countMessage }];
  }
  const sum = sumOf(items);
  if (sum !== BigInt(rules.totalCents)) {
    const shown =
      sum > BigInt(Number.MAX_SAFE_INTEGER)
        ? "more than that"
        : formatMoney(Number(sum), rules.currency);
    return [
      {
        field: "items",
        message: `add up to ${shown}, but they must add up to ${formatMoney(rules.totalCents, rules.currency)}. Change them so they match.`,
      },
    ];
  }
  return dateIssues(items, rules);
};

export type InstallmentTextInput = {
  projectTitle: string;
  milestoneName: string;
  currency: string;
  milestoneCents: number;
  /** Paid on this milestone's other invoices so far. */
  paidSoFarCents: number;
  number: number;
  count: number;
  amountCents: number;
  /** The other installments: their due date (null = due when the work is delivered). */
  others: { number: number; dueDate: string | null; paid: boolean }[];
};

/**
 * What the PayPal invoice says about the installment: the item description and the note.
 * Every figure comes from the database; money from the one money formatter.
 */
export const installmentText = (input: InstallmentTextInput) => {
  const money = (cents: number) => formatMoney(cents, input.currency);
  const label = (n: number) => `Installment ${String(n)} of ${String(input.count)}`;
  const description = `${label(input.number)} for ${input.projectTitle}: ${input.milestoneName}`;
  const remaining = input.milestoneCents - input.paidSoFarCents - input.amountCents;
  const totals = [
    `Milestone total ${money(input.milestoneCents)}`,
    `Paid so far ${money(input.paidSoFarCents)}`,
    `This installment ${money(input.amountCents)}`,
    `Remaining after this ${money(Math.max(0, remaining))}`,
  ].join(" · ");
  const others = [...input.others]
    .sort((a, b) => a.number - b.number)
    .map((other) => {
      const due = other.dueDate
        ? `due ${formatFullDay(other.dueDate)}`
        : "due when the work is delivered";
      return `${label(other.number)}: ${due}${other.paid ? " (paid)" : ""}`;
    });
  return { description, note: [description, totals, ...others].join("\n") };
};
