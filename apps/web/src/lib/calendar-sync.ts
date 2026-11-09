import { syncSource, type ImportDeps } from "./calendar-import";
import type { UserDbRunner } from "./db";
import type { ServiceDbRunner } from "./service-db";

// Server-only: refreshes imported calendars. n8n's 08_calendar_sync calls this every 30 minutes. The
// service role only claims which sources are due (the sender's claim pattern); each sync then runs as
// the source's own user, under row-level security.

const BATCH = 20;
/** A claim holds a source for this long, so two runs can't sync it at once; a crash frees it after. */
const CLAIM_MINUTES = 5;
const MINUTE_MS = 60_000;

export type CalendarSyncDeps = ImportDeps & {
  runAsService: ServiceDbRunner;
  runAsUser: (userId: string) => UserDbRunner;
  /** From CALENDAR_SYNC_MINUTES. */
  minutes: number;
};

export const runCalendarSync = async (
  deps: CalendarSyncDeps,
): Promise<{ synced: number; failed: number }> => {
  const now = deps.now();
  const claimed = await deps.runAsService(async (db) => {
    const { rows } = await db.query<{ id: string; user_id: string }>(
      `UPDATE public.calendar_sources SET sync_locked_until = $2
       WHERE id IN (
         SELECT id FROM public.calendar_sources
         WHERE kind = 'url' AND enabled
           AND (last_synced_at IS NULL OR last_synced_at < $1)
           AND (sync_locked_until IS NULL OR sync_locked_until < $3)
         ORDER BY last_synced_at NULLS FIRST LIMIT ${String(BATCH)}
         FOR UPDATE SKIP LOCKED)
       RETURNING id::text, user_id::text`,
      [
        new Date(now.getTime() - deps.minutes * MINUTE_MS).toISOString(),
        new Date(now.getTime() + CLAIM_MINUTES * MINUTE_MS).toISOString(),
        now.toISOString(),
      ],
    );
    return rows;
  });
  let synced = 0;
  let failed = 0;
  for (const { id, user_id: userId } of claimed) {
    try {
      const result = await deps.runAsUser(userId)((db) => syncSource(db, id, deps));
      if (result.ok) synced += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { synced, failed };
};
