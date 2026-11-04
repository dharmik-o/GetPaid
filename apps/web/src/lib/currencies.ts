// The invoice currencies PayPal supports, and how many decimals each has in PayPal.
// Source: developer.paypal.com/docs/reports/reference/paypal-supported-currencies (updated 10 Jul 2026).
// Money is stored as integer minor units with PayPal's decimals: HUF, JPY and TWD have none,
// so 1,500 forint is stored as 1500. Pure module: safe in client components.

export type Currency = { code: string; name: string; inCountryOnly: boolean };

const ZERO_DIGIT = new Set(["HUF", "JPY", "TWD"]);

/** In PayPal's order. BRL, CNY and MYR settle in that currency only for in-country accounts. */
export const PAYPAL_CURRENCIES: readonly Currency[] = [
  ["AUD", "Australian Dollar"],
  ["BRL", "Brazilian Real", true],
  ["CAD", "Canadian Dollar"],
  ["CNY", "Chinese Renminbi", true],
  ["CZK", "Czech Koruna"],
  ["DKK", "Danish Krone"],
  ["EUR", "Euro"],
  ["HKD", "Hong Kong Dollar"],
  ["HUF", "Hungarian Forint"],
  ["ILS", "Israeli New Shekel"],
  ["JPY", "Japanese Yen"],
  ["MYR", "Malaysian Ringgit", true],
  ["MXN", "Mexican Peso"],
  ["TWD", "New Taiwan Dollar"],
  ["NZD", "New Zealand Dollar"],
  ["NOK", "Norwegian Krone"],
  ["PHP", "Philippine Peso"],
  ["PLN", "Polish Złoty"],
  ["GBP", "Pound Sterling"],
  ["SGD", "Singapore Dollar"],
  ["SEK", "Swedish Krona"],
  ["CHF", "Swiss Franc"],
  ["THB", "Thai Baht"],
  ["USD", "United States Dollar"],
].map(([code, name, inCountryOnly]) => ({
  code: String(code),
  name: String(name),
  inCountryOnly: inCountryOnly === true,
}));

/**
 * What each written symbol can mean. Ambiguous ones list every PayPal currency that uses them, and
 * a prefix narrows one down. The rest are checked against Intl in tests. INR isn't a PayPal
 * currency, but a contract's late-fee clause can still name it.
 */
export const CURRENCY_SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  $: ["AUD", "CAD", "HKD", "MXN", "NZD", "SGD", "TWD", "USD"],
  US$: ["USD"],
  A$: ["AUD"],
  AU$: ["AUD"],
  C$: ["CAD"],
  CA$: ["CAD"],
  HK$: ["HKD"],
  MX$: ["MXN"],
  NZ$: ["NZD"],
  S$: ["SGD"],
  SG$: ["SGD"],
  NT$: ["TWD"],
  R$: ["BRL"],
  "€": ["EUR"],
  "£": ["GBP"],
  "¥": ["CNY", "JPY"],
  "CN¥": ["CNY"],
  "JP¥": ["JPY"],
  "₪": ["ILS"],
  "₱": ["PHP"],
  "฿": ["THB"],
  "₹": ["INR"],
  kr: ["DKK", "NOK", "SEK"],
  Kč: ["CZK"],
  Ft: ["HUF"],
  zł: ["PLN"],
  RM: ["MYR"],
};

const CODES = new Set(PAYPAL_CURRENCIES.map((currency) => currency.code));

export const isPaypalCurrency = (code: string): boolean => CODES.has(code);

/** Decimal places of the minor unit, as PayPal uses them. */
export const minorDigits = (code: string): number => {
  if (!isPaypalCurrency(code)) {
    throw new Error(`The currency ${code} isn't supported by PayPal. Pick one from the list.`);
  }
  return ZERO_DIGIT.has(code) ? 0 : 2;
};

export type ParsedAmount = { ok: true; minor: number } | { ok: false; message: string };

const AMOUNT = /^(\d+)(?:\.(\d+))?$/;

/** A typed amount ("3,000.50") to integer minor units, using string maths only. */
export const parseAmount = (text: string, currency: string): ParsedAmount => {
  const digits = minorDigits(currency);
  const match = AMOUNT.exec(text.trim().replace(/,/g, ""));
  if (!match) return { ok: false, message: "must be an amount like 1500 or 1500.00" };
  const [, whole = "", fraction = ""] = match;
  if (fraction.length > digits) {
    return {
      ok: false,
      message:
        digits === 0
          ? `must be a whole amount: PayPal doesn't use decimals for ${currency}`
          : `can have at most ${String(digits)} decimal places`,
    };
  }
  const minor = Number(`${whole}${fraction.padEnd(digits, "0")}`);
  if (!Number.isSafeInteger(minor)) return { ok: false, message: "is too large" };
  if (minor <= 0) return { ok: false, message: "must be more than 0" };
  return { ok: true, minor };
};

/** Minor units as a plain amount for an input field ("3000.50"), without floats. */
export const formatAmountInput = (minor: number, currency: string): string => {
  const digits = minorDigits(currency);
  if (digits === 0) return String(minor);
  const raw = String(Math.abs(minor)).padStart(digits + 1, "0");
  const sign = minor < 0 ? "-" : "";
  return `${sign}${raw.slice(0, -digits)}.${raw.slice(-digits)}`;
};
