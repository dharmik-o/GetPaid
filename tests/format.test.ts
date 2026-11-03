import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatDay,
  formatDaysAgo,
  formatFullDay,
  formatMoney,
  formatPaymentTerms,
} from "@/lib/format";

/** Intl puts a no-break space between the code and the amount. */
const plain = (text: string): string => text.replace(/\s/gu, " ");

describe("formatMoney", () => {
  it("shows the currency code and two decimals for cents", () => {
    expect(plain(formatMoney(150000, "USD"))).toBe("USD 1,500.00");
    expect(plain(formatMoney(5, "EUR"))).toBe("EUR 0.05");
    expect(plain(formatMoney(0, "USD"))).toBe("USD 0.00");
  });

  it("uses the currency's own minor unit", () => {
    expect(plain(formatMoney(1500, "JPY"))).toBe("JPY 1,500");
  });

  it("keeps large amounts exact", () => {
    expect(plain(formatMoney(900719925474099, "USD"))).toBe("USD 9,007,199,254,740.99");
  });

  it("shows negative amounts", () => {
    expect(plain(formatMoney(-2550, "USD"))).toBe("-USD 25.50");
  });

  it("refuses amounts that aren't whole minor units", () => {
    expect(() => formatMoney(10.5, "USD")).toThrow(/whole/);
  });
});

describe("formatDaysAgo", () => {
  const now = new Date("2026-11-18T12:00:00Z");

  it("says today, yesterday, or how many days ago", () => {
    expect(formatDaysAgo(new Date("2026-11-18T01:00:00Z"), now)).toBe("today");
    expect(formatDaysAgo(new Date("2026-11-17T10:00:00Z"), now)).toBe("yesterday");
    expect(formatDaysAgo(new Date("2026-11-08T12:00:00Z"), now)).toBe("10 days ago");
  });

  it("treats a time slightly in the future as today", () => {
    expect(formatDaysAgo(new Date("2026-11-18T12:00:05Z"), now)).toBe("today");
  });
});

describe("formatMoney with PayPal's zero-digit currencies", () => {
  it("shows HUF and TWD as whole amounts, as PayPal stores them", () => {
    expect(formatMoney(1500, "HUF").replace(/\s/gu, " ")).toBe("HUF 1,500");
    expect(formatMoney(1500, "TWD").replace(/\s/gu, " ")).toBe("TWD 1,500");
  });
});

describe("formatDay and formatDateTime", () => {
  it("shows a calendar date as '18 Nov', whatever the machine's zone", () => {
    expect(formatDay("2026-11-18")).toBe("18 Nov");
    expect(formatDay("2027-01-02")).toBe("2 Jan");
  });

  it("shows a calendar date with its year for documents, whatever the machine's zone", () => {
    expect(formatFullDay("2026-11-03")).toBe("3 Nov 2026");
    expect(formatFullDay("2027-01-02")).toBe("2 Jan 2027");
  });

  it("shows an instant in the given zone", () => {
    const instant = new Date("2026-11-18T20:00:00Z");
    expect(formatDateTime(instant, "Pacific/Auckland").replace(/\s/gu, " ")).toBe(
      "Thu 19 Nov, 09:00",
    );
    expect(formatDateTime(instant, "America/Lima").replace(/\s/gu, " ")).toBe("Wed 18 Nov, 15:00");
  });
});

describe("formatPaymentTerms", () => {
  it("says each kind of terms as a client reads it", () => {
    expect(formatPaymentTerms({ kind: "on_receipt" })).toBe("Due on receipt");
    expect(formatPaymentTerms({ kind: "net", days: 14 })).toBe("Net 14");
    expect(formatPaymentTerms({ kind: "date", date: "2026-11-18" })).toBe("Due by 18 Nov 2026");
  });
});
