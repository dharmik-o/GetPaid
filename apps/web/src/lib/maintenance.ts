import { z } from "zod";
import { isPaypalCurrency } from "./currencies";
import { isUuid, type Db } from "./db";
import { toCents } from "./db-values";
import { toFieldIssues, type FieldIssue } from "./field-issues";
import { addCalendarDays, maintenanceNextDue, todayIn } from "./schedule";

// Server-only: maintenance jobs and renewals, as the signed-in freelancer sees them (RLS). These
// reminders go to the freelancer only: nothing here contacts a client.

export type MaintenanceTask = {
  id: string;
  projectId: string;
  projectTitle: string;
  clientName: string;
  type: "maintenance" | "renewal";
  task: string;
  repeatMonths: number;
  nextDue: string;
  estCostCents: number | null;
  currency: string;
  leadDays: number[];
  repeatFrom: "done" | "scheduled";
  checklist: string[];
  snoozedUntil: string | null;
  lastDoneOn: string | null;
  /** The project made by Create invoice for this due date, if any. */
  jobProjectId: string | null;
  /** Past a lead day: what the freelancer has been told about. */
  dueSoon: boolean;
};

const DEFAULT_LEAD_DAYS = [14, 1];
const LEAD_DAYS_MAX = 5;
export const SNOOZE_DAYS = 7;

const createSchema = z.strictObject({
  projectId: z.string({ error: "must be one of your projects" }),
  type: z.enum(["maintenance", "renewal"], { error: "must be maintenance or renewal" }),
  task: z
    .string({ error: "is required" })
    .trim()
    .min(1, "is required")
    .max(200, "must be 200 characters or fewer"),
  repeatMonths: z
    .int("must be a whole number of months")
    .min(1, "must be at least 1 month")
    .max(120, "must be 120 months or fewer"),
  nextDue: z.iso.date({ error: "must be a date like 2026-12-31" }),
  estCostCents: z
    .int("must be a whole number of minor units (cents)")
    .min(0, "can't be negative")
    .max(Number.MAX_SAFE_INTEGER, "is too large")
    .nullable()
    .optional(),
  currency: z
    .string({ error: "must be a currency PayPal supports" })
    .refine(isPaypalCurrency, "must be a currency PayPal supports"),
  leadDays: z
    .array(z.int("must be whole days").min(0, "can't be negative").max(365, "must be 365 or fewer"))
    .min(1, "needs at least one day")
    .max(LEAD_DAYS_MAX, `can have at most ${String(LEAD_DAYS_MAX)} reminders`)
    .optional(),
  repeatFrom: z.enum(["done", "scheduled"], { error: "must be done or scheduled" }).optional(),
  checklist: z
    .array(z.string().trim().min(1, "can't be empty").max(200, "must be 200 characters or fewer"))
    .max(30, "can have at most 30 items")
    .optional(),
});

export type CreateResult = { ok: true; id: string } | { ok: false; errors: FieldIssue[] };

export const createMaintenanceTask = async (db: Db, raw: unknown): Promise<CreateResult> => {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
  }
  const input = parsed.data;
  const projectError = {
    ok: false as const,
    errors: [{ field: "projectId", message: "must be one of your projects" }],
  };
  if (!isUuid(input.projectId)) return projectError;
  const { rows: projects } = await db.query("SELECT 1 FROM public.projects WHERE id = $1", [
    input.projectId,
  ]);
  if (projects.length === 0) return projectError;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.maintenance_tasks (user_id, project_id, type, task, repeat_months, next_due,
       est_cost_cents, currency, lead_days, repeat_from, checklist)
     VALUES ((SELECT auth.uid()), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id::text`,
    [
      input.projectId,
      input.type,
      input.task,
      input.repeatMonths,
      input.nextDue,
      input.estCostCents ?? null,
      input.currency,
      input.leadDays ?? DEFAULT_LEAD_DAYS,
      input.repeatFrom ?? "scheduled",
      JSON.stringify(input.checklist ?? []),
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Saving the maintenance task returned no id.");
  return { ok: true, id };
};

type TaskRow = {
  id: string;
  project_id: string;
  title: string;
  client_name: string;
  type: MaintenanceTask["type"];
  task: string;
  repeat_months: number;
  next_due: string;
  est_cost_cents: string | null;
  currency: string;
  lead_days: number[];
  repeat_from: MaintenanceTask["repeatFrom"];
  checklist: unknown;
  snoozed_until: string | null;
  last_done_on: string | null;
  job_project_id: string | null;
  job_due_on: string | null;
  own_zone: string;
};

export const SELECT_TASKS = `
  SELECT mt.id::text, mt.project_id::text, p.title, c.name AS client_name, mt.type, mt.task,
    mt.repeat_months, mt.next_due::text, mt.est_cost_cents::text, mt.currency, mt.lead_days,
    mt.repeat_from, mt.checklist, mt.snoozed_until::text, mt.last_done_on::text,
    mt.job_project_id::text, mt.job_due_on::text, u.time_zone AS own_zone
  FROM public.maintenance_tasks mt
  JOIN public.projects p ON p.id = mt.project_id
  JOIN public.clients c ON c.id = p.client_id
  JOIN public.users u ON u.id = mt.user_id
  WHERE mt.status = 'active'`;

const checklistSchema = z.array(z.string());

const toTask = (row: TaskRow, now: Date): MaintenanceTask => {
  const today = todayIn(now, row.own_zone);
  const checklist = checklistSchema.safeParse(row.checklist);
  return {
    id: row.id,
    projectId: row.project_id,
    projectTitle: row.title,
    clientName: row.client_name,
    type: row.type,
    task: row.task,
    repeatMonths: row.repeat_months,
    nextDue: row.next_due,
    estCostCents: row.est_cost_cents === null ? null : toCents(row.est_cost_cents),
    currency: row.currency,
    leadDays: row.lead_days,
    repeatFrom: row.repeat_from,
    checklist: checklist.success ? checklist.data : [],
    snoozedUntil:
      row.snoozed_until !== null && row.snoozed_until > today ? row.snoozed_until : null,
    lastDoneOn: row.last_done_on,
    jobProjectId: row.job_due_on === row.next_due ? row.job_project_id : null,
    dueSoon: row.lead_days.some((days) => addCalendarDays(row.next_due, -days) <= today),
  };
};

export const listMaintenanceTasks = async (db: Db, now: Date): Promise<MaintenanceTask[]> => {
  const { rows } = await db.query<TaskRow>(`${SELECT_TASKS} ORDER BY mt.next_due, mt.created_at`);
  return rows.map((row) => toTask(row, now));
};

export const getMaintenanceTask = async (
  db: Db,
  id: string,
  now: Date,
): Promise<MaintenanceTask | undefined> => {
  if (!isUuid(id)) return undefined;
  const { rows } = await db.query<TaskRow>(`${SELECT_TASKS} AND mt.id = $1`, [id]);
  return rows[0] ? toTask(rows[0], now) : undefined;
};

/**
 * What every change of date or state shares: the card on Telegram stops working (and is closed),
 * and a heads-up not yet sent is stopped, since it quotes the old date.
 */
const closeCardAndHeadsUp = async (db: Db, id: string): Promise<void> => {
  await db.query(
    `UPDATE public.maintenance_tasks
     SET telegram_stale_message_id = coalesce(telegram_message_id, telegram_stale_message_id),
       telegram_message_id = NULL, telegram_card_sent_at = NULL, notice_pending = false
     WHERE id = $1`,
    [id],
  );
  await db.query(
    `UPDATE public.reminders SET approval_status = 'skipped', approved_via = NULL
     WHERE maintenance_task_id = $1 AND sent_at IS NULL AND send_attempted_at IS NULL
       AND approval_status IN ('waiting', 'approved')`,
    [id],
  );
};

const record = (db: Db, id: string, type: string, payload: object) =>
  db.query(
    `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
     VALUES ((SELECT auth.uid()), 'maintenance', $1, $2, $3)`,
    [id, type, JSON.stringify(payload)],
  );

export type ChangeResult =
  | { status: "ok"; date: string }
  | { status: "not_found" }
  | { status: "stale" }
  | { status: "invalid"; message: string };

/**
 * Sets the next due date, from the done date or the original date (the task's setting).
 * `expectedDue` makes a double tap harmless: the second finds the date has moved on.
 */
export const markDone = async (
  db: Db,
  id: string,
  now: Date,
  expectedDue?: string,
): Promise<ChangeResult> => {
  const task = await getMaintenanceTask(db, id, now);
  if (!task) return { status: "not_found" };
  if (expectedDue !== undefined && expectedDue !== task.nextDue) return { status: "stale" };
  const { rows } = await db.query<{ time_zone: string }>(
    "SELECT time_zone FROM public.users WHERE id = (SELECT auth.uid())",
  );
  const doneOn = todayIn(now, rows[0]?.time_zone ?? "UTC");
  const next = maintenanceNextDue({
    scheduledDue: task.nextDue,
    repeatMonths: task.repeatMonths,
    repeatFrom: task.repeatFrom,
    doneOn,
  });
  await closeCardAndHeadsUp(db, id);
  await db.query(
    `UPDATE public.maintenance_tasks
     SET next_due = $2, last_done_on = $3, last_notice_on = NULL, snoozed_until = NULL,
       job_project_id = NULL, job_due_on = NULL
     WHERE id = $1`,
    [id, next, doneOn],
  );
  await record(db, id, "maintenance.done", { doneOn, nextDue: next });
  return { status: "ok", date: next };
};

export const snooze = async (
  db: Db,
  id: string,
  now: Date,
  days = SNOOZE_DAYS,
): Promise<ChangeResult> => {
  const task = await getMaintenanceTask(db, id, now);
  if (!task) return { status: "not_found" };
  const { rows } = await db.query<{ time_zone: string }>(
    "SELECT time_zone FROM public.users WHERE id = (SELECT auth.uid())",
  );
  const until = addCalendarDays(todayIn(now, rows[0]?.time_zone ?? "UTC"), days);
  await db.query(
    `UPDATE public.maintenance_tasks
     SET snoozed_until = $2,
       telegram_stale_message_id = coalesce(telegram_message_id, telegram_stale_message_id),
       telegram_message_id = NULL, telegram_card_sent_at = NULL, notice_pending = false
     WHERE id = $1`,
    [id, until],
  );
  await record(db, id, "maintenance.snoozed", { until });
  return { status: "ok", date: until };
};

export const reschedule = async (
  db: Db,
  id: string,
  nextDue: string,
  now: Date,
): Promise<ChangeResult> => {
  const task = await getMaintenanceTask(db, id, now);
  if (!task) return { status: "not_found" };
  const { rows } = await db.query<{ time_zone: string }>(
    "SELECT time_zone FROM public.users WHERE id = (SELECT auth.uid())",
  );
  if (nextDue < todayIn(now, rows[0]?.time_zone ?? "UTC")) {
    return { status: "invalid", message: "Pick today or a later date, then save again." };
  }
  await closeCardAndHeadsUp(db, id);
  await db.query(
    `UPDATE public.maintenance_tasks
     SET next_due = $2, last_notice_on = NULL, snoozed_until = NULL
     WHERE id = $1`,
    [id, nextDue],
  );
  await record(db, id, "maintenance.rescheduled", { nextDue });
  return { status: "ok", date: nextDue };
};

/** No more reminders for this job. Kept for the history. */
export const stopTask = async (db: Db, id: string, now: Date): Promise<ChangeResult> => {
  const task = await getMaintenanceTask(db, id, now);
  if (!task) return { status: "not_found" };
  await closeCardAndHeadsUp(db, id);
  await db.query("UPDATE public.maintenance_tasks SET status = 'cancelled' WHERE id = $1", [id]);
  await record(db, id, "maintenance.stopped", {});
  return { status: "ok", date: task.nextDue };
};
