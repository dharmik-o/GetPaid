import type { Db } from "./db";
import { toCents } from "./db-values";
import type { MaintenanceFacts } from "./draft-facts";
import { formatFullDay, formatMoney } from "./format";
import { mergeSettings, type ScheduleSettings } from "./settings";

// Server-only: what a maintenance heads-up is written from, read as its owner (RLS). Every value
// comes from the database and is already formatted, so a model only ever copies it.

export type MaintenanceContext = {
  reminderId: string;
  taskId: string;
  approvalStatus: "waiting" | "approved" | "skipped";
  hasDraft: boolean;
  /** The due date the heads-up is about, and the job's due date now. */
  aboutDue: string | null;
  nextDue: string;
  taskActive: boolean;
  facts: MaintenanceFacts;
  client: { name: string; timeZone: string };
  freelancerName: string;
  settings: ScheduleSettings;
};

type Row = {
  id: string;
  task_id: string;
  approval_status: MaintenanceContext["approvalStatus"];
  has_draft: boolean;
  about_due: string | null;
  next_due: string;
  task_status: string;
  task: string;
  type: "maintenance" | "renewal";
  est_cost_cents: unknown;
  currency: string;
  title: string;
  project_settings: unknown;
  client_name: string;
  time_zone: string;
  client_settings: unknown;
  freelancer_name: string;
  account_settings: unknown;
};

export const loadMaintenanceContext = async (
  db: Db,
  reminderId: string,
): Promise<MaintenanceContext | undefined> => {
  const { rows } = await db.query<Row>(
    `SELECT r.id::text, mt.id::text AS task_id, r.approval_status, r.draft IS NOT NULL AS has_draft,
       r.maintenance_due_on::text AS about_due, mt.next_due::text, mt.status AS task_status, mt.task,
       mt.type, mt.est_cost_cents::text, mt.currency, p.title, p.settings AS project_settings,
       c.name AS client_name, c.time_zone, c.settings AS client_settings,
       u.name AS freelancer_name, u.default_settings AS account_settings
     FROM public.reminders r
     JOIN public.maintenance_tasks mt ON mt.id = r.maintenance_task_id
     JOIN public.projects p ON p.id = mt.project_id
     JOIN public.clients c ON c.id = p.client_id
     JOIN public.users u ON u.id = r.user_id
     WHERE r.id = $1`,
    [reminderId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    reminderId: row.id,
    taskId: row.task_id,
    approvalStatus: row.approval_status,
    hasDraft: row.has_draft,
    aboutDue: row.about_due,
    nextDue: row.next_due,
    taskActive: row.task_status === "active",
    facts: {
      freelancerName: row.freelancer_name,
      clientName: row.client_name,
      projectTitle: row.title,
      task: row.task,
      type: row.type,
      dueDate: formatFullDay(row.about_due ?? row.next_due),
      estimatedCost:
        row.est_cost_cents === null ? null : formatMoney(toCents(row.est_cost_cents), row.currency),
    },
    client: { name: row.client_name, timeZone: row.time_zone },
    freelancerName: row.freelancer_name,
    settings: mergeSettings({
      account: row.account_settings,
      client: row.client_settings,
      project: row.project_settings,
    }),
  };
};
