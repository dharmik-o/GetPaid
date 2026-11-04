import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NeedsAttention } from "@/components/NeedsAttention";
import { RecoveryMetrics } from "@/components/RecoveryMetrics";
import { formatMoney } from "@/lib/format";
import type { Metrics } from "@/lib/metrics";

// The Home page's metrics and Needs attention cards, rendered on the server.

const metrics = (overrides: Partial<Metrics> = {}): Metrics => ({
  recovered: [],
  daysLate: [],
  medianDaysLate: null,
  recovery: { paid: 0, total: 0 },
  usualDaysLate: null,
  daysSaved: null,
  overdue: [],
  ...overrides,
});

const LATE = {
  id: "i1",
  invoiceNumber: "FPR-000001",
  clientId: "c1",
  clientName: "Acme",
  days: 14,
  amountCents: 75000,
  currency: "USD",
};

const OVERDUE = {
  id: "i2",
  invoiceNumber: "FPR-000002",
  clientId: "c1",
  clientName: "Acme",
  days: 14,
  remainingCents: 150000,
  currency: "USD",
};

const render = (value: Metrics) =>
  renderToStaticMarkup(createElement(RecoveryMetrics, { metrics: value })).replace(
    /<!-- -->/gu,
    "",
  );

describe("RecoveryMetrics", () => {
  it("explains itself before anything has gone overdue", () => {
    expect(render(metrics())).toContain("Nothing has gone overdue yet");
  });

  it("shows each currency's total on its own", () => {
    const html = render(
      metrics({
        recovered: [
          { currency: "EUR", cents: 5000 },
          { currency: "USD", cents: 75000 },
        ],
        daysLate: [LATE],
      }),
    );
    expect(html).toContain(formatMoney(5000, "EUR"));
    expect(html).toContain(formatMoney(75000, "USD"));
  });

  it("shows a rate with its counts, so a small number isn't mistaken for a big one", () => {
    const html = render(metrics({ daysLate: [LATE], recovery: { paid: 1, total: 2 } }));
    expect(html).toContain("50%");
    expect(html).toContain("1 of 2");
  });

  it("shows no rate with nothing to count", () => {
    const html = render(metrics({ daysLate: [LATE], recovery: { paid: 0, total: 0 } }));
    expect(html).not.toContain("NaN");
    expect(html).toContain("None to count yet");
  });

  it("shows days saved beside the delay it's measured against", () => {
    const html = render(
      metrics({ daysLate: [LATE], medianDaysLate: 14, usualDaysLate: 30, daysSaved: 16 }),
    );
    expect(html).toContain("16 days");
    expect(html).toContain("the 30 days");
  });

  it("asks for the usual delay instead of guessing days saved", () => {
    const html = render(metrics({ daysLate: [LATE], medianDaysLate: 14 }));
    expect(html).toContain("/settings");
    expect(html).not.toContain("0 days saved");
  });

  it("says one day, not one days", () => {
    const html = render(
      metrics({
        daysLate: [{ ...LATE, days: 1 }],
        medianDaysLate: 1,
        usualDaysLate: 2,
        daysSaved: 1,
      }),
    );
    expect(html).toContain("1 day");
    expect(html).not.toContain("1 days");
  });

  it("lists days late per invoice, linked to the client's timeline", () => {
    const html = render(metrics({ daysLate: [LATE], medianDaysLate: 14 }));
    expect(html).toContain("FPR-000001");
    expect(html).toContain("/clients/c1#timeline");
    expect(html).toContain("14 days");
  });
});

describe("NeedsAttention", () => {
  const render2 = (waiting: number, overdue: Metrics["overdue"]) =>
    renderToStaticMarkup(createElement(NeedsAttention, { waiting, overdue })).replace(
      /<!-- -->/gu,
      "",
    );

  it("says so when nothing does", () => {
    expect(render2(0, [])).toContain("Nothing needs you right now");
  });

  it("leads with drafts waiting, linked to the Outbox", () => {
    const html = render2(3, []);
    expect(html).toContain("3 drafts waiting");
    expect(html).toContain("/outbox");
  });

  it("says one draft, not one drafts", () => {
    expect(render2(1, [])).toContain("1 draft waiting");
  });

  it("lists overdue invoices with what's owed, and names the state in words", () => {
    const html = render2(0, [OVERDUE]);
    expect(html).toContain("FPR-000002");
    expect(html).toContain(formatMoney(150000, "USD"));
    expect(html).toContain("14 days overdue");
  });
});
