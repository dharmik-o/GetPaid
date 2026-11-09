import { z } from "zod";
import { isCountryCode, isValidTimeZone } from "./countries";
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
    legalName: z.string().trim().max(160, { error: "must be 160 characters or fewer" }).nullable(),
    udyamNumber: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/, { error: "must look like UDYAM-MH-12-1234567" })
      .nullable(),
    governingLawCountry: z
      .string()
      .refine(isCountryCode, { error: "must be picked from the list" })
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

export type LegalFacts = {
  legalName: string | null;
  udyamNumber: string | null;
  governingLawCountry: string | null;
};

/** What contracts and late-payment laws need to know about the freelancer. */
export const getLegalFacts = async (db: Db): Promise<LegalFacts> => {
  const { rows } = await db.query<{
    legal_name: string | null;
    udyam_number: string | null;
    governing_law_country: string | null;
  }>(
    "SELECT legal_name, udyam_number, governing_law_country FROM public.users WHERE id = (SELECT auth.uid())",
  );
  const row = rows[0];
  return {
    legalName: row?.legal_name ?? null,
    udyamNumber: row?.udyam_number ?? null,
    governingLawCountry: row?.governing_law_country ?? null,
  };
};

export const accountHandlers = ({ runAsUser }: { runAsUser: UserDbRunner }) => ({
  put: async (request: Request): Promise<Response> => {
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = accountSchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error));
    try {
      const { timeZone, usualDaysLate, legalName, udyamNumber, governingLawCountry } = parsed.data;
      const { rowCount } = await runAsUser((db) =>
        db.query(
          `UPDATE public.users
           SET time_zone = coalesce($1, time_zone),
             usual_days_late = CASE WHEN $2 THEN $3::smallint ELSE usual_days_late END,
             legal_name = CASE WHEN $4 THEN $5 ELSE legal_name END,
             udyam_number = CASE WHEN $6 THEN $7 ELSE udyam_number END,
             governing_law_country = CASE WHEN $8 THEN $9 ELSE governing_law_country END
           WHERE id = (SELECT auth.uid())`,
          [
            timeZone ?? null,
            usualDaysLate !== undefined,
            usualDaysLate ?? null,
            legalName !== undefined,
            legalName || null,
            udyamNumber !== undefined,
            udyamNumber || null,
            governingLawCountry !== undefined,
            governingLawCountry ?? null,
          ],
        ),
      );
      if (rowCount === 0) return notFound("Account");
      return jsonResponse(parsed.data);
    } catch (error) {
      return serverError("account.save_failed", error);
    }
  },
});
