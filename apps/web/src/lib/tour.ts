import { z } from "zod";
import type { Db, UserDbRunner } from "./db";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";
import { TIP_KEYS, type TipKey } from "./tour-steps";

// Server-only: how far each freelancer is with the guided tour. It lives on their own users row, so
// row-level security keeps it private; every query here acts as the signed-in user.

export type TourState = {
  /** The main tour was finished or skipped. */
  mainDone: boolean;
  tipsSeen: TipKey[];
  /** Where the tour's milestone step goes: the first project that has milestones. */
  projectId: string | null;
};

const ME = "WHERE id = (SELECT auth.uid())";

const eventSchema = z.discriminatedUnion("event", [
  z.strictObject({ event: z.literal("complete") }),
  z.strictObject({ event: z.literal("skip") }),
  z.strictObject({ event: z.literal("replay") }),
  z.strictObject({ event: z.literal("reset-tips") }),
  z.strictObject({ event: z.literal("tip-seen"), tip: z.enum(TIP_KEYS) }),
]);

type TourEvent = z.infer<typeof eventSchema>;

const UPDATES = {
  complete: `UPDATE public.users SET tour_completed_at = coalesce(tour_completed_at, now()) ${ME}`,
  skip: `UPDATE public.users SET tour_skipped_at = coalesce(tour_skipped_at, now()) ${ME}`,
  replay: `UPDATE public.users SET tour_completed_at = NULL, tour_skipped_at = NULL ${ME}`,
  "reset-tips": `UPDATE public.users SET tour_tips_seen = '{}' ${ME}`,
  "tip-seen": `UPDATE public.users SET tour_tips_seen = CASE WHEN $1::text = ANY(tour_tips_seen)
    THEN tour_tips_seen ELSE array_append(tour_tips_seen, $1::text) END ${ME}`,
} as const;

const apply = (db: Db, event: TourEvent) =>
  db.query(UPDATES[event.event], event.event === "tip-seen" ? [event.tip] : []);

/** A new demo session starts the tour again, so every judge sees it. */
export const resetTour = async (db: Db): Promise<void> => {
  await apply(db, { event: "replay" });
  await apply(db, { event: "reset-tips" });
};

export const loadTour = async (db: Db): Promise<TourState> => {
  const { rows } = await db.query<{ done: boolean; tips: string[] }>(
    `SELECT (tour_completed_at IS NOT NULL OR tour_skipped_at IS NOT NULL) AS done,
            tour_tips_seen AS tips FROM public.users ${ME}`,
  );
  const project = await db.query<{ id: string }>(
    "SELECT project_id AS id FROM public.milestones ORDER BY created_at LIMIT 1",
  );
  const known = new Set<string>(TIP_KEYS);
  return {
    // No users row (not set up): there is nobody to show a tour to.
    mainDone: rows[0]?.done ?? true,
    tipsSeen: (rows[0]?.tips ?? []).filter((tip): tip is TipKey => known.has(tip)),
    projectId: project.rows[0]?.id ?? null,
  };
};

export const tourHandlers = ({ runAsUser }: { runAsUser: UserDbRunner }) => ({
  get: async (): Promise<Response> => {
    try {
      return jsonResponse(await runAsUser(loadTour));
    } catch (error) {
      return serverError("tour.load_failed", error);
    }
  },
  post: async (request: Request): Promise<Response> => {
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = eventSchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error));
    try {
      const state = await runAsUser(async (db) => {
        const { rowCount } = await apply(db, parsed.data);
        return rowCount === 0 ? null : loadTour(db);
      });
      return state ? jsonResponse(state) : notFound("Account");
    } catch (error) {
      return serverError("tour.save_failed", error);
    }
  },
});
