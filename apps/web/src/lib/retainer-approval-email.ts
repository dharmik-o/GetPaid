import type { Db } from "./db";
import { draftReminder, type DrafterDeps } from "./drafter";

// Server-only: the email asking a client to approve auto-pay, with the PayPal link as its only link.
// This only makes a draft, which waits for approval like any other: nothing here can send.

export type ApprovalEmailResult = "drafted" | "exists" | "not_ready" | "not_found";

const save = async (
  db: Db,
  retainerId: string,
  now: Date,
  { evenIfSkipped }: { evenIfSkipped: boolean },
): Promise<{ result: ApprovalEmailResult; reminderId?: string }> => {
  const { rows } = await db.query<{ status: string; method: string; link: string | null }>(
    `SELECT status, method, paypal_approval_link AS link FROM public.retainers WHERE id = $1`,
    [retainerId],
  );
  const retainer = rows[0];
  if (!retainer) return { result: "not_found" };
  if (retainer.method !== "auto_pay" || retainer.status !== "pending_approval" || !retainer.link) {
    return { result: "not_ready" };
  }
  // One in progress, and none at all after one's been sent. A skipped draft stays skipped unless
  // the freelancer asks for another.
  const { rows: earlier } = await db.query<{ open: boolean }>(
    `SELECT sent_at IS NOT NULL OR approval_status IN ('waiting', 'approved') AS open
     FROM public.reminders WHERE retainer_id = $1`,
    [retainerId],
  );
  if (earlier.some((row) => row.open) || (earlier.length > 0 && !evenIfSkipped)) {
    return { result: "exists" };
  }
  const { rows: created } = await db.query<{ id: string }>(
    `INSERT INTO public.reminders (user_id, retainer_id, tier, scheduled_at)
     VALUES ((SELECT auth.uid()), $1, 'auto_pay_approval', $2)
     RETURNING id::text`,
    [retainerId, now.toISOString()],
  );
  const reminderId = created[0]?.id;
  if (!reminderId) throw new Error("Saving the approval email returned no id.");
  return { result: "drafted", reminderId };
};

/**
 * Makes the draft. The model call runs outside any transaction: if it fails, the row stays with no
 * draft, and the scheduler's next run writes it.
 */
export const draftApprovalEmail = async (
  deps: DrafterDeps,
  {
    userId,
    retainerId,
    evenIfSkipped = false,
  }: { userId: string; retainerId: string; evenIfSkipped?: boolean },
): Promise<ApprovalEmailResult> => {
  const now = deps.now();
  const saved = await deps.runAsUser(userId)((db) => save(db, retainerId, now, { evenIfSkipped }));
  if (saved.reminderId) await draftReminder(deps, { userId, reminderId: saved.reminderId });
  return saved.result;
};
