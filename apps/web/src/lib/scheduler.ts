import type { Db } from "./db";
import { draftReminder, type DrafterDeps } from "./drafter";
import { errorKind, logEvent } from "./log";
import { planMaintenanceNotices } from "./maintenance-telegram";
import { runRetainerInvoices, type RetainerInvoiceDeps } from "./retainer-invoices";
import { nextSend, todayIn, type PastReminder, type Tier } from "./schedule";
import type { ServiceDbRunner } from "./service-db";
import { mergeSettings, type ScheduleSettings } from "./settings";

// Server-only: n8n's 01_scheduler calls this every hour. For each unpaid invoice with no reminder
// in progress, it asks lib/schedule.ts what comes next, and plans it once it's within a day, so
// the freelancer has time to approve. Then it drafts what's planned. Nothing here sends, and the
// only thing it can approve is Tier 1, when the freelancer chose auto-send. Safe to re-run.

export type SchedulerDeps = DrafterDeps & RetainerInvoiceDeps & { runAsService: ServiceDbRunner };

const PLAN_AHEAD_MS = 24 * 60 * 60 * 1000;
const PLAN_LIMIT = 200;
/** A local model can take a minute a draft. What's left is drafted on the next run. */
const DRAFT_LIMIT = 10;

type PlanRow = {
  tier: Tier | null;
  paused_until: string | null;
  due_date: string;
  time_zone: string;
  account_settings: unknown;
  client_settings: unknown;
  project_settings: unknown;
  milestone_settings: unknown;
};

const settingsOf = (row: PlanRow): ScheduleSettings =>
  mergeSettings({
    account: row.account_settings,
    client: row.client_settings,
    project: row.project_settings,
    milestone: row.milestone_settings,
  });

const loadPlanRow = async (db: Db, invoiceId: string): Promise<PlanRow | undefined> => {
  const { rows } = await db.query<PlanRow>(
    `SELECT NULL AS tier, i.reminders_paused_until::text AS paused_until, i.due_date::text, c.time_zone,
       u.default_settings AS account_settings,
       c.settings AS client_settings, p.settings AS project_settings,
       m.settings AS milestone_settings
     FROM public.invoices i
     LEFT JOIN public.milestones m ON m.id = i.milestone_id
     LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
     LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id)
     JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
     JOIN public.users u ON u.id = i.user_id
     WHERE i.id = $1 AND i.status IN ('sent', 'partially_paid') AND i.due_date IS NOT NULL
       AND i.reminders_held_at IS NULL AND i.retainer_settled_at IS NULL`,
    [invoiceId],
  );
  return rows[0];
};

const loadHistory = async (db: Db, invoiceId: string): Promise<PastReminder[]> => {
  const { rows } = await db.query<{ tier: Tier; at: Date | string }>(
    `SELECT tier, coalesce(sent_at, scheduled_at) AS at FROM public.reminders
     WHERE invoice_id = $1 AND (sent_at IS NOT NULL OR approval_status = 'skipped')`,
    [invoiceId],
  );
  return rows.map((row) => ({ tier: row.tier, at: new Date(row.at) }));
};

/** The next reminder for one invoice, if it's close enough to plan. */
const planInvoice = async (db: Db, invoiceId: string, now: Date): Promise<boolean> => {
  const row = await loadPlanRow(db, invoiceId);
  if (!row) return false;
  if (row.paused_until && todayIn(now, row.time_zone) < row.paused_until) return false;
  const next = nextSend({
    settings: settingsOf(row),
    dueDate: row.due_date,
    timeZone: row.time_zone,
    history: await loadHistory(db, invoiceId),
    now,
  });
  if (next.status !== "scheduled" || next.sendAt.getTime() - now.getTime() > PLAN_AHEAD_MS) {
    return false;
  }
  const { rowCount } = await db.query(
    `INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at)
     VALUES ((SELECT auth.uid()), $1, $2, $3)
     ON CONFLICT (invoice_id) WHERE sent_at IS NULL AND approval_status IN ('waiting', 'approved')
     DO NOTHING`,
    [invoiceId, next.tier, next.sendAt.toISOString()],
  );
  return rowCount > 0;
};

const planAll = async (deps: SchedulerDeps, now: Date): Promise<number> => {
  const invoices = await deps.runAsService(async (db) => {
    const { rows } = await db.query<{ id: string; user_id: string }>(
      `SELECT i.id::text, i.user_id::text FROM public.invoices i
       WHERE i.status IN ('sent', 'partially_paid')
         AND i.reminders_held_at IS NULL AND i.retainer_settled_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.reminders r WHERE r.invoice_id = i.id AND r.sent_at IS NULL
             AND r.approval_status IN ('waiting', 'approved'))
       ORDER BY i.due_date LIMIT ${String(PLAN_LIMIT)}`,
    );
    return rows;
  });
  let planned = 0;
  for (const { id, user_id: userId } of invoices) {
    if (await deps.runAsUser(userId)((db) => planInvoice(db, id, now))) planned += 1;
  }
  return planned;
};

/** Tier 1 only, and only if the freelancer chose it. Tier 3 always needs a person. */
const autoApproveIfChosen = (deps: SchedulerDeps, userId: string, reminderId: string) =>
  deps.runAsUser(userId)(async (db) => {
    const { rows } = await db.query<PlanRow>(
      `SELECT r.tier, NULL AS paused_until, i.due_date::text, c.time_zone,
         u.default_settings AS account_settings,
         c.settings AS client_settings, p.settings AS project_settings,
         m.settings AS milestone_settings
       FROM public.reminders r
       JOIN public.invoices i ON i.id = r.invoice_id
       LEFT JOIN public.milestones m ON m.id = i.milestone_id
       LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
       LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id)
       JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
       JOIN public.users u ON u.id = r.user_id
       WHERE r.id = $1`,
      [reminderId],
    );
    const row = rows[0];
    if (row?.tier !== "tier1" || settingsOf(row).approvalMode !== "auto_send_tier1") return;
    const { rowCount } = await db.query(
      `UPDATE public.reminders SET approval_status = 'approved'
       WHERE id = $1 AND tier = 'tier1' AND approval_status = 'waiting' AND draft IS NOT NULL`,
      [reminderId],
    );
    if (rowCount === 0) return;
    await db.query(
      `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
       VALUES ((SELECT auth.uid()), 'reminder', $1, 'reminder.approved', $2)`,
      [reminderId, JSON.stringify({ via: "auto_send_tier1" })],
    );
  });

const draftPlanned = async (deps: SchedulerDeps): Promise<number> => {
  const planned = await deps.runAsService(async (db) => {
    const { rows } = await db.query<{ id: string; user_id: string }>(
      `SELECT id::text, user_id::text FROM public.reminders
       WHERE draft IS NULL AND approval_status = 'waiting'
       ORDER BY scheduled_at LIMIT ${String(DRAFT_LIMIT)}`,
    );
    return rows;
  });
  let drafted = 0;
  for (const { id, user_id: userId } of planned) {
    try {
      const outcome = await draftReminder(deps, { userId, reminderId: id });
      if (outcome.status === "drafted") {
        drafted += 1;
        await autoApproveIfChosen(deps, userId, id);
      }
    } catch (error) {
      // One bad draft doesn't stop the others; it's tried again on the next run.
      logEvent("scheduler.draft_failed", { reminderId: id, error: errorKind(error) });
    }
  }
  return drafted;
};

export const runScheduler = async (
  deps: SchedulerDeps,
): Promise<{ planned: number; drafted: number; invoiced: number; noticed: number }> => {
  const { invoiced } = await runRetainerInvoices(deps);
  const noticed = await planMaintenanceNotices(deps.runAsService, deps.now());
  const planned = await planAll(deps, deps.now());
  const drafted = await draftPlanned(deps);
  logEvent("scheduler.run", { planned, drafted, invoiced, noticed });
  return { planned, drafted, invoiced, noticed };
};
