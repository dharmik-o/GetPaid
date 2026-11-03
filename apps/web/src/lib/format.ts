// The one money formatter and the one relative-date formatter for the dashboard.

const fractionDigits = (currency: string): number =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;

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
  }).format(toDecimalString(minor, digits));
};

const DAY_MS = 24 * 60 * 60 * 1000;
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "today", "yesterday", "10 days ago": counted in whole 24-hour days, so no time zone is needed. */
export const formatDaysAgo = (instant: Date, now: Date): string => {
  const days = Math.max(0, Math.floor((now.getTime() - instant.getTime()) / DAY_MS));
  return relative.format(-days, "day");
};
