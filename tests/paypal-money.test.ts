import { describe, expect, it } from "vitest";
import { fromPaypalValue, paypalMoney, toPaypalValue } from "@/lib/paypal";

describe("toPaypalValue", () => {
  it.each([
    [90000, "USD", "900.00"],
    [150050, "USD", "1500.50"],
    [1, "EUR", "0.01"],
    [10, "GBP", "0.10"],
    [1500, "JPY", "1500"],
    [1500, "HUF", "1500"],
    [123456789012345, "USD", "1234567890123.45"],
  ])("%i minor units of %s is %s", (minor, currency, value) => {
    expect(toPaypalValue(minor, currency)).toBe(value);
  });

  it.each([0, -100, 1.5, Number.MAX_SAFE_INTEGER + 2])("rejects %d", (minor) => {
    expect(() => toPaypalValue(minor, "USD")).toThrow(/whole number of minor units/);
  });

  it("rejects a currency PayPal doesn't support", () => {
    expect(() => toPaypalValue(100, "XYZ")).toThrow(/isn't supported by PayPal/);
  });
});

describe("fromPaypalValue", () => {
  it.each([
    ["900.00", "USD", 90000],
    ["900", "USD", 90000],
    ["900.5", "USD", 90050],
    ["0.01", "USD", 1],
    ["1500", "JPY", 1500],
    ["1500.00", "JPY", 1500],
    ["0.00", "USD", 0],
  ])("%s %s is %i minor units", (value, currency, minor) => {
    expect(fromPaypalValue(value, currency)).toBe(minor);
  });

  it.each(["1.234", "1500.5"])(
    "rejects %s when it has more decimals than the currency",
    (value) => {
      const currency = value === "1500.5" ? "JPY" : "USD";
      expect(() => fromPaypalValue(value, currency)).toThrow(/PayPal returned an amount/);
    },
  );

  it.each(["", "abc", "-5.00", "1e3", " 5.00"])("rejects %j", (value) => {
    expect(() => fromPaypalValue(value, "USD")).toThrow(/PayPal returned an amount/);
  });

  it("round-trips with toPaypalValue", () => {
    for (const minor of [1, 99, 100, 101, 90000, 123456789]) {
      expect(fromPaypalValue(toPaypalValue(minor, "USD"), "USD")).toBe(minor);
    }
  });
});

describe("paypalMoney", () => {
  it("builds PayPal's money object", () => {
    expect(paypalMoney(90000, "USD")).toEqual({ currency_code: "USD", value: "900.00" });
  });
});
