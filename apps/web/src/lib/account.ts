import { z } from "zod";
import { isValidTimeZone } from "./countries";
import type { Db, UserDbRunner } from "./db";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";

// Server-only: the freelancer's own time zone, shown beside the client's on every send time.

const accountSchema = z.strictObject({
  timeZone: z
    .string({ error: "is required" })
    .refine(isValidTimeZone, { error: "must be a time zone from the list" }),
});

export const getOwnTimeZone = async (db: Db): Promise<string> => {
  const { rows } = await db.query<{ time_zone: string }>(
    "SELECT time_zone FROM public.users WHERE id = (SELECT auth.uid())",
  );
  return rows[0]?.time_zone ?? "UTC";
};

export const accountHandlers = ({ runAsUser }: { runAsUser: UserDbRunner }) => ({
  put: async (request: Request): Promise<Response> => {
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = accountSchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error));
    try {
      const { rowCount } = await runAsUser((db) =>
        db.query("UPDATE public.users SET time_zone = $1 WHERE id = (SELECT auth.uid())", [
          parsed.data.timeZone,
        ]),
      );
      if (rowCount === 0) return notFound("Account");
      return jsonResponse({ timeZone: parsed.data.timeZone });
    } catch (error) {
      return serverError("account.save_failed", error);
    }
  },
});
