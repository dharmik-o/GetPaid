import type { Db } from "./db";
import { LIVE_HOLD_SQL } from "./milestone-holds";

// Server-only: "Mark project complete", "Archive project" and "Restore". Completing is allowed
// once every invoice is paid, cancelled or refunded and no milestone hold is live. Both stop
// whatever reminders are still waiting. Read and written as the signed-in user (RLS), so another
// user's project is simply not found.

export type CompleteResult =
  { ok: true } | { ok: false; notFound: true } | { ok: false; conflict: string };

const count = async (db: Db, sql: string, id: string): Promise<number> => {
  const { rows } = await db.query<{ n: number }>(sql, [id]);
  return rows[0]?.n ?? 0;
};

/** Reminders not yet sent, for the project's invoices and holds, are skipped: nothing goes out. */
const stopReminders = (db: Db, id: string) =>
  db.query(
    `UPDATE public.reminders SET approval_status = 'skipped', approved_via = NULL
     WHERE sent_at IS NULL AND approval_status IN ('waiting', 'approved')
       AND (invoice_id IN (SELECT i.id FROM public.invoices i
                           JOIN public.milestones m ON m.id = i.milestone_id WHERE m.project_id = $1)
         OR hold_id IN (SELECT h.id FROM public.milestone_holds h
                        JOIN public.milestones m ON m.id = h.milestone_id WHERE m.project_id = $1)
         OR maintenance_task_id IN (SELECT t.id FROM public.maintenance_tasks t
                                    WHERE t.project_id = $1))`,
    [id],
  );

const record = (db: Db, id: string, type: string) =>
  db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ((SELECT auth.uid()), 'project', $1, $2, '{}')`,
    [id, type],
  );

export const completeProject = async (db: Db, id: string): Promise<CompleteResult> => {
  const { rows } = await db.query<{ status: string }>(
    "SELECT status FROM public.projects WHERE id = $1 FOR UPDATE",
    [id],
  );
  const project = rows[0];
  if (!project) return { ok: false, notFound: true };
  if (project.status === "completed") return { ok: true };
  if (project.status === "cancelled") {
    return { ok: false, conflict: "A cancelled project can't be marked complete." };
  }

  const open = await count(
    db,
    `SELECT count(*)::int AS n FROM public.invoices i
     JOIN public.milestones m ON m.id = i.milestone_id
     WHERE m.project_id = $1 AND i.status NOT IN ('paid', 'cancelled', 'refunded')`,
    id,
  );
  if (open > 0) {
    return {
      ok: false,
      conflict: `${open === 1 ? "1 invoice is" : `${String(open)} invoices are`} still open. Record the payment or cancel ${open === 1 ? "it" : "them"} first.`,
    };
  }
  const holds = await count(
    db,
    `SELECT count(*)::int AS n FROM public.milestone_holds h
     JOIN public.milestones m ON m.id = h.milestone_id
     WHERE m.project_id = $1 AND h.status IN (${LIVE_HOLD_SQL})`,
    id,
  );
  if (holds > 0) {
    return {
      ok: false,
      conflict: `${holds === 1 ? "1 hold is" : `${String(holds)} holds are`} still open. Capture or void ${holds === 1 ? "it" : "them"} first.`,
    };
  }

  await db.query("UPDATE public.projects SET status = 'completed' WHERE id = $1", [id]);
  await stopReminders(db, id);
  await record(db, id, "project.completed");
  return { ok: true };
};

/** Hides the project and stops its waiting reminders; every record stays. Repeating is safe. */
export const archiveProject = async (db: Db, id: string): Promise<CompleteResult> => {
  const { rowCount } = await db.query(
    "UPDATE public.projects SET archived_at = coalesce(archived_at, now()) WHERE id = $1",
    [id],
  );
  if (rowCount === 0) return { ok: false, notFound: true };
  await stopReminders(db, id);
  await record(db, id, "project.archived");
  return { ok: true };
};

/** Shows it again. Reminders stopped by archiving are not brought back; the scheduler plans afresh. */
export const restoreProject = async (db: Db, id: string): Promise<CompleteResult> => {
  const { rowCount } = await db.query(
    "UPDATE public.projects SET archived_at = NULL WHERE id = $1",
    [id],
  );
  if (rowCount === 0) return { ok: false, notFound: true };
  await record(db, id, "project.restored");
  return { ok: true };
};
