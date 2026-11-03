// Converting values read from Postgres. `pg` returns bigint and numeric as strings and
// timestamps as Date; PGlite (tests) may return numbers or bigints. Both are handled here.

/** A bigint money column (minor units) as a safe JS integer. Throws rather than lose precision. */
export const toCents = (value: unknown): number => {
  const cents = typeof value === "bigint" ? Number(value) : Number(String(value));
  if (!Number.isSafeInteger(cents)) {
    throw new Error(
      `A money amount from the database isn't a whole number of cents: ${String(value)}.`,
    );
  }
  return cents;
};

/** A timestamptz as an ISO string in UTC. */
export const toIso = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`A timestamp from the database isn't a valid date: ${String(value)}.`);
  }
  return date.toISOString();
};
