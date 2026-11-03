import { describe, expect, it } from "vitest";
import {
  checkInstallments,
  depositItems,
  installmentText,
  parseInstallmentItems,
  splitEvenly,
} from "@/lib/installments";

// Installments replace PayPal partial payments: integer cents, exact totals, 2 to 12 parts.

/** formatMoney puts a no-break space after the currency code. */
const plain = (text: string): string => text.replace(/\u00a0/gu, " ");

describe("splitEvenly", () => {
  it("splits evenly when it divides", () => {
    expect(splitEvenly(150000, 2)).toEqual([75000, 75000]);
  });

  it("rounds each share half up and the last absorbs the remainder", () => {
    expect(splitEvenly(100000, 3)).toEqual([33333, 33333, 33334]);
    // 1001 / 2 = 500.5, which rounds up to 501; the last takes what is left.
    expect(splitEvenly(1001, 2)).toEqual([501, 500]);
    expect(splitEvenly(100, 12).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("always adds up to the total exactly, even for huge amounts", () => {
    const total = Number.MAX_SAFE_INTEGER;
    const parts = splitEvenly(total, 7);
    expect(parts.reduce((sum, part) => sum + BigInt(part), 0n)).toBe(BigInt(total));
  });

  it("refuses fewer than 2 or more than 12 installments", () => {
    expect(() => splitEvenly(1000, 1)).toThrow(/2 to 12/);
    expect(() => splitEvenly(1000, 13)).toThrow(/2 to 12/);
  });

  it("refuses a total too small to give every installment at least 1 cent", () => {
    expect(() => splitEvenly(2, 3)).toThrow(/too small/);
  });
});

describe("depositItems", () => {
  it("is the deposit, then the rest; both due per the terms when invoiced", () => {
    expect(depositItems(30000, 90000)).toEqual([
      { amountCents: 30000, dueDate: null },
      { amountCents: 60000, dueDate: null },
    ]);
  });
});

describe("parseInstallmentItems", () => {
  it("accepts amounts in cents and dates or null", () => {
    const parsed = parseInstallmentItems([
      { amountCents: 75000, dueDate: "2026-11-03" },
      { amountCents: 75000, dueDate: "2026-11-15" },
    ]);
    expect(parsed.ok).toBe(true);
  });

  it("refuses fractional cents, zero amounts, bad dates and unknown fields", () => {
    const parsed = parseInstallmentItems([
      { amountCents: 750.5, dueDate: "2026-11-03" },
      { amountCents: 0, dueDate: "2026-02-30" },
      { amountCents: 1, dueDate: null, partialPayment: true },
    ]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((e) => e.field)).toEqual(
      expect.arrayContaining([
        "items.0.amountCents",
        "items.1.amountCents",
        "items.1.dueDate",
        "items.2.partialPayment",
      ]),
    );
  });
});

describe("checkInstallments", () => {
  const base = { totalCents: 150000, currency: "USD", datesRequired: true, today: "2026-11-03" };
  const fields = (issues: { field: string }[]) => issues.map((issue) => issue.field);

  it("passes a valid split", () => {
    const items = [
      { amountCents: 75000, dueDate: "2026-11-03" },
      { amountCents: 75000, dueDate: "2026-11-15" },
    ];
    expect(checkInstallments(items, base)).toEqual([]);
  });

  it("needs the amounts to add up to the total exactly", () => {
    const items = [
      { amountCents: 75000, dueDate: "2026-11-03" },
      { amountCents: 74999, dueDate: "2026-11-15" },
    ];
    const [issue] = checkInstallments(items, base);
    expect(issue?.field).toBe("items");
    expect(issue?.message).toMatch(/USD\s1,499\.99.*USD\s1,500\.00/);
  });

  it("needs 2 to 12 installments", () => {
    expect(
      fields(checkInstallments([{ amountCents: 150000, dueDate: "2026-11-03" }], base)),
    ).toEqual(["items"]);
    const thirteen = Array.from({ length: 13 }, (_, i) => ({
      amountCents: i < 12 ? 11538 : 150000 - 11538 * 12,
      dueDate: "2026-11-20",
    }));
    expect(checkInstallments(thirteen, base)[0]?.message).toMatch(/2 to 12/);
  });

  it("needs a due date on each when dates are required", () => {
    const items = [
      { amountCents: 75000, dueDate: "2026-11-03" },
      { amountCents: 75000, dueDate: null },
    ];
    expect(fields(checkInstallments(items, base))).toEqual(["items.1.dueDate"]);
  });

  it("needs the due dates in order and not in the past", () => {
    const items = [
      { amountCents: 50000, dueDate: "2026-11-02" },
      { amountCents: 50000, dueDate: "2026-11-20" },
      { amountCents: 50000, dueDate: "2026-11-10" },
    ];
    const issues = checkInstallments(items, base);
    expect(fields(issues)).toEqual(["items.0.dueDate", "items.2.dueDate"]);
    expect(issues[0]?.message).toMatch(/passed/);
    expect(issues[1]?.message).toMatch(/before installment 2/);
  });
});

describe("installmentText", () => {
  const input = {
    projectTitle: "Website redesign",
    milestoneName: "Build",
    currency: "USD",
    milestoneCents: 150000,
    paidSoFarCents: 50000,
    number: 2,
    count: 3,
    amountCents: 50000,
    others: [
      { number: 1, dueDate: "2026-11-03", paid: true },
      { number: 3, dueDate: "2026-12-15", paid: false },
    ],
  };

  it("names the installment, the milestone and the project", () => {
    expect(installmentText(input).description).toBe(
      "Installment 2 of 3 for Website redesign: Build",
    );
  });

  it("states the totals, worked out in cents and formatted by the one money formatter", () => {
    const note = plain(installmentText(input).note);
    expect(note).toContain(
      "Milestone total USD 1,500.00 · Paid so far USD 500.00 · This installment USD 500.00 · Remaining after this USD 500.00",
    );
  });

  it("lists the other installments' due dates, and says which are paid", () => {
    const note = plain(installmentText(input).note);
    expect(note).toContain("Installment 1 of 3: due 3 Nov 2026 (paid)");
    expect(note).toContain("Installment 3 of 3: due 15 Dec 2026");
    expect(note).not.toMatch(/overdue/i);
  });

  it("says an installment without a date yet is due when the work is delivered", () => {
    const { note: raw } = installmentText({
      ...input,
      number: 1,
      count: 2,
      paidSoFarCents: 0,
      amountCents: 30000,
      milestoneCents: 90000,
      others: [{ number: 2, dueDate: null, paid: false }],
    });
    const note = plain(raw);
    expect(note).toContain("Installment 2 of 2: due when the work is delivered");
    expect(note).toContain("Remaining after this USD 600.00");
  });
});
