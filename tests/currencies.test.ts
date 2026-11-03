import { describe, expect, it } from "vitest";
import {
  formatAmountInput,
  isPaypalCurrency,
  minorDigits,
  parseAmount,
  PAYPAL_CURRENCIES,
} from "@/lib/currencies";

describe("PAYPAL_CURRENCIES", () => {
  it("lists the 24 currencies PayPal supports", () => {
    expect(PAYPAL_CURRENCIES.map((c) => c.code)).toEqual([
      "AUD",
      "BRL",
      "CAD",
      "CNY",
      "CZK",
      "DKK",
      "EUR",
      "HKD",
      "HUF",
      "ILS",
      "JPY",
      "MYR",
      "MXN",
      "TWD",
      "NZD",
      "NOK",
      "PHP",
      "PLN",
      "GBP",
      "SGD",
      "SEK",
      "CHF",
      "THB",
      "USD",
    ]);
  });

  it("marks the in-country-only currencies", () => {
    const inCountry = PAYPAL_CURRENCIES.filter((c) => c.inCountryOnly).map((c) => c.code);
    expect(inCountry).toEqual(["BRL", "CNY", "MYR"]);
  });

  it("knows which codes PayPal accepts", () => {
    expect(isPaypalCurrency("USD")).toBe(true);
    expect(isPaypalCurrency("INR")).toBe(false);
    expect(isPaypalCurrency("usd")).toBe(false);
  });
});

describe("minorDigits", () => {
  it("is 0 for PayPal's zero-digit currencies, even where ISO uses 2", () => {
    expect(minorDigits("HUF")).toBe(0);
    expect(minorDigits("JPY")).toBe(0);
    expect(minorDigits("TWD")).toBe(0);
  });

  it("is 2 for the others", () => {
    expect(minorDigits("USD")).toBe(2);
    expect(minorDigits("PHP")).toBe(2);
  });

  it("throws for a currency PayPal doesn't support", () => {
    expect(() => minorDigits("INR")).toThrow(/INR.*isn't supported by PayPal/);
  });
});

describe("parseAmount", () => {
  it("turns typed amounts into integer minor units without floats", () => {
    expect(parseAmount("3000", "USD")).toEqual({ ok: true, minor: 300000 });
    expect(parseAmount("3,000.5", "USD")).toEqual({ ok: true, minor: 300050 });
    expect(parseAmount(" 0.07 ", "EUR")).toEqual({ ok: true, minor: 7 });
    expect(parseAmount("1500", "JPY")).toEqual({ ok: true, minor: 1500 });
    expect(parseAmount("90071992547409.91", "USD")).toEqual({ ok: true, minor: 9007199254740991 });
  });

  it("rejects too many decimals, including any for zero-digit currencies", () => {
    expect(parseAmount("10.001", "USD")).toEqual({
      ok: false,
      message: "can have at most 2 decimal places",
    });
    expect(parseAmount("1500.50", "HUF")).toEqual({
      ok: false,
      message: "must be a whole amount: PayPal doesn't use decimals for HUF",
    });
  });

  it("rejects text, negatives, zero and amounts too large to keep exact", () => {
    for (const text of ["", "abc", "-5", "1e3", "0", "0.00", "90071992547409.92"]) {
      expect(parseAmount(text, "USD").ok, text).toBe(false);
    }
  });
});

describe("formatAmountInput", () => {
  it("shows minor units as a plain amount for an input field", () => {
    expect(formatAmountInput(300050, "USD")).toBe("3000.50");
    expect(formatAmountInput(7, "USD")).toBe("0.07");
    expect(formatAmountInput(1500, "HUF")).toBe("1500");
  });
});
