import { z } from "zod";
import { isValidTimeZone } from "./countries";
import type { Db, UserDbRunner } from "./db";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";

// Server-only: the freelancer's own time zone, shown beside the client's on every send time, and
// how late their clients usually paid, which days saved is measured against.

const accountSchema = z
  .strictObject({
    timeZone: z.string().refine(isValidTimeZone, { error: "must be a time zone from the list" }),
    usualDaysLate: z
      .int({ error: "must be a whole number of days" })
      .min(0, { error: "can't be negative" })
      .max(365, { error: "must be 365 days or fewer" })
      .nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { error: "Nothing to save." });

export const getOwnTimeZone = async (db: Db): Promise<string> => {
  const { rows } = await db.query<{ time_zone: string }>(
    "SELECT time_zone FROM public.users WHERE id = (SELECT auth.uid())",
  );
  return rows[0]?.time_zone ?? "UTC";
};

export const getUsualDaysLate = async (db: Db): Promise<number | null> => {
  const { rows } = await db.query<{ usual_days_late: number | null }>(
    "SELECT usual_days_late FROM public.users WHERE id = (SELECT auth.uid())",
  );
  return rows[0]?.usual_days_late ?? null;
};

export const accountHandlers = ({ runAsUser }: { runAsUser: UserDbRunner }) => ({
  put: async (request: Request): Promise<Response> => {
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = accountSchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error));
    try {
      const { timeZone, usualDaysLate } = parsed.data;
      const { rowCount } = await runAsUser((db) =>
        db.query(
          `UPDATE public.users
           SET time_zone = coalesce($1, time_zone),
             usual_days_late = CASE WHEN $2 THEN $3::smallint ELSE usual_days_late END
           WHERE id = (SELECT auth.uid())`,
          [timeZone ?? null, usualDaysLate !== undefined, usualDaysLate ?? null],
        ),
      );
      if (rowCount === 0) return notFound("Account");
      return jsonResponse(parsed.data);
    } catch (error) {
      return serverError("account.save_failed", error);
    }
  },
});
