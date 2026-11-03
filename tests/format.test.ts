import { describe, expect, it } from "vitest";
import { formatDaysAgo, formatMoney } from "@/lib/format";

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
