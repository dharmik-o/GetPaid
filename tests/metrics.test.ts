import { describe, expect, it } from "vitest";
import { computeMetrics, type MetricInvoice } from "@/lib/metrics";

// The recovery metrics, as the spec's Success metrics table defines them.

const NOW = new Date("2026-12-20T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const invoice = (overrides: Partial<MetricInvoice>): MetricInvoice => ({
  id: "i1",
  invoiceNumber: "FPR-000001",
  clientId: "c1",
  clientName: "Acme",
  status: "paid",
  amountCents: 150000,
  amountPaidCents: 150000,
  currency: "USD",
  dueDate: "2026-12-01",
  firstDueDate: "2026-12-01",
  paidAt: new Date("2026-12-11T15:00:00Z"),
  firstReminderAt: new Date("2026-12-03T15:00:00Z"),
  timeZone: "America/New_York",
  ...overrides,
});

const metrics = (rows: MetricInvoice[], usualDaysLate: number | null = null) =>
  computeMetrics(rows, { now: NOW, usualDaysLate });

describe("amount recovered", () => {
  it("is what was paid on invoices that went overdue", () => {
    expect(metrics([invoice({})]).recovered).toEqual([{ currency: "USD", cents: 150000 }]);
  });

  it("leaves out an invoice paid on time", () => {
    const onTime = invoice({ paidAt: new Date("2026-12-01T15:00:00Z") });
    expect(metrics([onTime]).recovered).toEqual([]);
  });

  it("keeps one total per currency, never converted", () => {
    const rows = [
      invoice({ id: "a" }),
      invoice({ id: "b", amountPaidCents: 2000 }),
      invoice({ id: "c", currency: "EUR", amountPaidCents: 5000 }),
    ];
    expect(metrics(rows).recovered).toEqual([
      { currency: "EUR", cents: 5000 },
      { currency: "USD", cents: 152000 },
    ]);
  });

  it("counts only what's kept after a refund", () => {
    const refunded = invoice({ status: "refunded", amountPaidCents: 50000 });
    expect(metrics([refunded]).recovered).toEqual([{ currency: "USD", cents: 50000 }]);
  });

  it("leaves out money under dispute and cancelled invoices", () => {
    const rows = [
      invoice({ id: "a", status: "disputed" }),
      invoice({ id: "b", status: "cancelled" }),
    ];
    expect(metrics(rows).recovered).toEqual([]);
  });

  it("counts an installment that replaced an overdue invoice, though it was paid on its own date", () => {
    const installment = invoice({
      dueDate: "2026-12-15",
      firstDueDate: "2026-12-01",
      paidAt: new Date("2026-12-15T15:00:00Z"),
      amountCents: 75000,
      amountPaidCents: 75000,
    });
    expect(metrics([installment]).recovered).toEqual([{ currency: "USD", cents: 75000 }]);
  });
});

describe("days late per invoice", () => {
  it("counts from the first due date to the paid date", () => {
    expect(metrics([invoice({})]).daysLate).toEqual([
      expect.objectContaining({ invoiceNumber: "FPR-000001", days: 10 }),
    ]);
  });

  it("counts calendar days in the client's zone", () => {
    // 03:00 UTC on the 2nd is still the 1st in New York: on time.
    const inZone = invoice({ paidAt: new Date("2026-12-02T03:00:00Z") });
    expect(metrics([inZone]).daysLate).toEqual([]);
    const tokyo = invoice({ paidAt: new Date("2026-12-01T16:00:00Z"), timeZone: "Asia/Tokyo" });
    expect(metrics([tokyo]).daysLate).toEqual([expect.objectContaining({ days: 1 })]);
  });

  it("a split invoice's lateness runs from the invoice it replaced", () => {
    const installment = invoice({ dueDate: "2026-12-15", firstDueDate: "2026-12-01" });
    expect(metrics([installment]).daysLate).toEqual([expect.objectContaining({ days: 10 })]);
  });

  it("the median of an odd and an even number of invoices", () => {
    const late = (id: string, days: number) =>
      invoice({ id, paidAt: new Date(Date.UTC(2026, 11, 1 + days, 15)) });
    expect(metrics([late("a", 2), late("b", 10), late("c", 4)]).medianDaysLate).toBe(4);
    expect(metrics([late("a", 2), late("b", 5)]).medianDaysLate).toBe(3.5);
  });

  it("has no median when nothing was paid late", () => {
    expect(metrics([]).medianDaysLate).toBeNull();
  });

  it("an unpaid invoice has no days late yet", () => {
    const open = invoice({ status: "sent", paidAt: null, amountPaidCents: 0 });
    expect(metrics([open]).daysLate).toEqual([]);
  });
});

describe("recovery rate", () => {
  const first = new Date("2026-12-03T15:00:00Z");

  it("counts an overdue invoice paid within 30 days of the first reminder", () => {
    expect(metrics([invoice({ firstReminderAt: first })]).recovery).toEqual({ paid: 1, total: 1 });
  });

  it("an invoice paid after 30 days counts against it", () => {
    const slow = invoice({
      dueDate: "2026-10-01",
      firstDueDate: "2026-10-01",
      firstReminderAt: new Date("2026-10-03T15:00:00Z"),
      paidAt: new Date("2026-12-10T15:00:00Z"),
    });
    expect(metrics([slow]).recovery).toEqual({ paid: 0, total: 1 });
  });

  it("an unpaid invoice past its 30 days counts against it", () => {
    const stuck = invoice({
      status: "sent",
      paidAt: null,
      amountPaidCents: 0,
      firstReminderAt: new Date(NOW.getTime() - 31 * DAY),
    });
    expect(metrics([stuck]).recovery).toEqual({ paid: 0, total: 1 });
  });

  it("an unpaid invoice still inside its 30 days isn't counted yet", () => {
    const open = invoice({
      status: "sent",
      paidAt: null,
      amountPaidCents: 0,
      firstReminderAt: new Date(NOW.getTime() - 5 * DAY),
    });
    expect(metrics([open]).recovery).toEqual({ paid: 0, total: 0 });
  });

  it("an invoice paid on time isn't counted, and neither is one no reminder went out for", () => {
    const rows = [
      invoice({ id: "a", paidAt: new Date("2026-12-01T15:00:00Z") }),
      invoice({ id: "b", firstReminderAt: null }),
    ];
    expect(metrics(rows).recovery).toEqual({ paid: 0, total: 0 });
  });
});

describe("days saved", () => {
  it("compares the median with the delay the freelancer told us is usual", () => {
    expect(metrics([invoice({})], 30)).toMatchObject({ usualDaysLate: 30, daysSaved: 20 });
  });

  it("is unknown without a usual delay: nothing is assumed", () => {
    expect(metrics([invoice({})], null).daysSaved).toBeNull();
  });

  it("is unknown with nothing paid late yet", () => {
    expect(metrics([], 30).daysSaved).toBeNull();
  });

  it("never goes below zero", () => {
    expect(metrics([invoice({})], 3).daysSaved).toBe(0);
  });
});

describe("overdue now", () => {
  it("lists open invoices past their own due date, most overdue first", () => {
    const rows = [
      invoice({ id: "a", status: "sent", paidAt: null, amountPaidCents: 0, dueDate: "2026-12-10" }),
      invoice({ id: "b", status: "sent", paidAt: null, amountPaidCents: 0, dueDate: "2026-12-01" }),
    ];
    expect(metrics(rows).overdue.map(({ id, days }) => [id, days])).toEqual([
      ["b", 19],
      ["a", 10],
    ]);
  });

  it("leaves out what's due today or later, paid or cancelled", () => {
    const rows = [
      invoice({ id: "a", status: "sent", paidAt: null, amountPaidCents: 0, dueDate: "2026-12-20" }),
      invoice({ id: "b" }),
      invoice({ id: "c", status: "cancelled", paidAt: null }),
    ];
    expect(metrics(rows).overdue).toEqual([]);
  });

  it("shows what's still owed", () => {
    const part = invoice({ status: "partially_paid", paidAt: null, amountPaidCents: 50000 });
    expect(metrics([part]).overdue[0]).toMatchObject({ remainingCents: 100000, currency: "USD" });
  });
});
