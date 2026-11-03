import { isPaypalCurrency, minorDigits } from "./currencies";
import type { PaymentTerms } from "./settings";

// The one money formatter and the date formatters for the dashboard. Pure: safe in client components.

/** PayPal's decimals for its currencies (HUF, JPY, TWD have none); ISO's for anything else. */
const fractionDigits = (currency: string): number =>
  isPaypalCurrency(currency)
    ? minorDigits(currency)
    : (new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2);

/** Integer minor units to a decimal string, without floating point. */
const toDecimalString = (minor: number, digits: number): `${number}` => {
  const negative = minor < 0;
  const raw = String(Math.abs(minor)).padStart(digits + 1, "0");
  const whole = raw.slice(0, raw.length - digits);
  const fraction = raw.slice(raw.length - digits);
  return `${negative ? "-" : ""}${whole}${digits > 0 ? `.${fraction}` : ""}` as `${number}`;
};

/** "USD 1,500.00": always with the currency code, from integer minor units (cents). */
export const formatMoney = (minor: number, currency: string): string => {
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`Money must be whole minor units (cents); got ${String(minor)}.`);
  }
  const digits = fractionDigits(currency);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: "code",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(toDecimalString(minor, digits));
};

const DAY_MS = 24 * 60 * 60 * 1000;
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "today", "yesterday", "10 days ago": counted in whole 24-hour days, so no time zone is needed. */
export const formatDaysAgo = (instant: Date, now: Date): string => {
  const days = Math.max(0, Math.floor((now.getTime() - instant.getTime()) / DAY_MS));
  return relative.format(-days, "day");
};

/** "18 Nov" for a calendar date (`YYYY-MM-DD`), with no time zone shift. */
export const formatDay = (isoDate: string): string =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${isoDate}T00:00:00Z`),
  );

/** "Thu 19 Nov, 09:00" for an instant, in the given IANA zone. */
export const formatDateTime = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(instant);

/** "18 Nov 2026" for a calendar date (`YYYY-MM-DD`), with no time zone shift. For documents. */
export const formatFullDay = (isoDate: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));

/** "Net 14", "Due on receipt" or "Due by 18 Nov 2026", as clients read them. */
export const formatPaymentTerms = (terms: PaymentTerms): string => {
  switch (terms.kind) {
    case "on_receipt":
      return "Due on receipt";
    case "net":
      return `Net ${String(terms.days)}`;
    case "date":
      return `Due by ${formatFullDay(terms.date)}`;
  }
};
