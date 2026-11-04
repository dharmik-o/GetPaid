import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UpcomingList } from "@/components/UpcomingList";
import { formatMoney } from "@/lib/format";
import type { Upcoming } from "@/lib/upcoming";

// What the Upcoming list shows: amounts through the one money formatter, one total per currency,
// and no sign of any conversion.

const render = (upcoming: Upcoming): string =>
  renderToStaticMarkup(createElement(UpcomingList, { upcoming }));

const UPCOMING: Upcoming = {
  until: "2027-03-23",
  totals: [
    { currency: "EUR", cents: 9_900 },
    { currency: "USD", cents: 20_000 },
  ],
  withoutEstimate: 1,
  weeks: [
    {
      weekOf: "2027-01-04",
      items: [
        {
          key: "a",
          kind: "retainer",
          name: "Hosting",
          clientName: "Acme",
          date: "2027-01-05",
          amountCents: 9_900,
          currency: "EUR",
        },
        {
          key: "b",
          kind: "renewal",
          name: "Domain",
          clientName: "Beta",
          date: "2027-01-06",
          amountCents: null,
          currency: null,
        },
      ],
    },
  ],
};

describe("UpcomingList", () => {
  it("shows each currency's total on its own", () => {
    const html = render(UPCOMING);
    expect(html).toContain(formatMoney(9_900, "EUR"));
    expect(html).toContain(formatMoney(20_000, "USD"));
  });

  it("never mentions a conversion or a combined total", () => {
    expect(render(UPCOMING)).not.toMatch(/convert|exchange|rate\b|≈|approx|total:/i);
  });

  it("says a job has no estimate, rather than showing zero", () => {
    const html = render(UPCOMING);
    expect(html).toContain("No estimate");
    expect(html).toContain("1 job has no estimate");
    expect(html).not.toContain(formatMoney(0, "USD"));
  });

  it("shows the type, client and date on each row, grouped by week", () => {
    const html = render(UPCOMING);
    for (const text of ["Week of 4 Jan", "Retainer", "Renewal", "Acme", "Beta", "5 Jan", "6 Jan"]) {
      expect(html).toContain(text);
    }
  });

  it("explains the next step when there's nothing", () => {
    const html = render({ until: "2027-03-23", totals: [], withoutEstimate: 0, weeks: [] });
    expect(html).toContain("Nothing in the next 90 days");
    expect(html).toContain('href="/retainers"');
    expect(html).toContain('href="/maintenance"');
  });
});
