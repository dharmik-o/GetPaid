import type { Db, UserDbRunner } from "./db";
import { draftReminder, type DrafterDeps } from "./drafter";
import type { FieldIssue } from "./field-issues";
import { issueMilestoneInvoice, type FlowDeps } from "./invoice-flow";
import type { InvoiceView } from "./invoices";
import { getMaintenanceTask, type MaintenanceTask } from "./maintenance";
import { getProject } from "./projects";
import { formatDay } from "./format";
import { mergeSettings } from "./settings";

// Server-only: "Tell the client" and "Create invoice". Tell the client only ever makes a draft that
// waits for approval like any other: this file can't send, and nothing a button does can either.
// Create invoice is the existing invoice flow; PayPal emails nobody.

export type TellResult =
  | { status: "drafted"; reminderId: string }
  | { status: "already_open"; reminderId: string }
  | { status: "not_found" };

const openHeadsUp = async (db: Db, taskId: string): Promise<string | undefined> => {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id::text FROM public.reminders
     WHERE maintenance_task_id = $1 AND sent_at IS NULL
       AND approval_status IN ('waiting', 'approved')`,
    [taskId],
  );
  return rows[0]?.id;
};

/** Makes the heads-up draft, or finds the one in progress. It waits for approval. */
export const tellClient = async (
  deps: DrafterDeps,
  { userId, taskId }: { userId: string; taskId: string },
): Promise<TellResult> => {
  const now = deps.now();
  const prepared = await deps.runAsUser(userId)(
    async (db): Promise<{ id: string; isNew: boolean } | undefined> => {
      const task = await getMaintenanceTask(db, taskId, now);
      if (!task) return undefined;
      const existing = await openHeadsUp(db, taskId);
      if (existing) return { id: existing, isNew: false };
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO public.reminders
           (user_id, maintenance_task_id, maintenance_due_on, tier, scheduled_at)
         VALUES ((SELECT auth.uid()), $1, $2, 'maintenance', $3)
         RETURNING id::text`,
        [taskId, task.nextDue, now.toISOString()],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("Saving the heads-up returned no id.");
      return { id, isNew: true };
    },
  );
  if (!prepared) return { status: "not_found" };
  if (!prepared.isNew) return { status: "already_open", reminderId: prepared.id };
  // The model call runs outside any transaction: it can take a minute on a local model. If this
  // fails, the row stays with no draft, and the scheduler's next run writes it.
  await draftReminder(deps, { userId, reminderId: prepared.id });
  return { status: "drafted", reminderId: prepared.id };
};

export type JobInvoiceResult =
  | { ok: true; invoices: InvoiceView[]; projectId: string; sentNow: boolean }
  | { ok: false; notFound: true }
  | { ok: false; conflict: string }
  | { ok: false; errors: FieldIssue[] };

const NO_COST =
  "This job has no estimated cost, so there's nothing to invoice. Add one in the dashboard: stop this reminder and create it again with the cost.";

type Job = { milestoneId: string; projectId: string };

/** A project of its own for this occurrence, so the original project's totals stay as agreed. */
const makeJob = async (db: Db, task: MaintenanceTask, deposit: boolean): Promise<Job> => {
  const source = await getProject(db, task.projectId);
  if (!source) throw new Error("The job's project could not be read.");
  const cents = task.estCostCents ?? 0;
  // A fixed date on the original contract has passed or doesn't apply to repeat work.
  const { paymentTerms } = mergeSettings({ account: source.inherited, project: source.settings });
  const settings =
    paymentTerms.kind === "date"
      ? { ...source.settings, paymentTerms: { kind: "on_receipt" } }
      : source.settings;
  const { rows: projects } = await db.query<{ id: string }>(
    `INSERT INTO public.projects (user_id, client_id, title, total_cents, currency, deadline,
       contract_terms, late_fee_clause, settings, status)
     VALUES ((SELECT auth.uid()), $1, $2, $3, $4, $5, $6, $7, $8, 'active')
     RETURNING id::text`,
    [
      source.clientId,
      `${task.task} (due ${formatDay(task.nextDue)})`,
      cents,
      task.currency,
      task.nextDue,
      source.contractTerms,
      source.lateFeeClause,
      JSON.stringify(settings),
    ],
  );
  const projectId = rows0(projects);
  const { rows: milestones } = await db.query<{ id: string }>(
    `INSERT INTO public.milestones (user_id, project_id, currency, position, name, amount_cents,
       deadline, payment_mode, status)
     VALUES ((SELECT auth.uid()), $1, $2, 1, $3, $4, $5, $6, $7)
     RETURNING id::text`,
    [
      projectId,
      task.currency,
      task.task,
      cents,
      task.nextDue,
      deposit ? "deposit" : "pay_on_invoice",
      // The freelancer chose to bill it now, which is what "accepted" allows.
      deposit ? "planned" : "accepted",
    ],
  );
  await db.query(
    "UPDATE public.maintenance_tasks SET job_project_id = $2, job_due_on = $3 WHERE id = $1",
    [task.id, projectId, task.nextDue],
  );
  return { milestoneId: rows0(milestones), projectId };
};

const rows0 = (rows: { id: string }[]): string => {
  const id = rows[0]?.id;
  if (!id) throw new Error("Saving the job returned no id.");
  return id;
};

const existingJob = async (db: Db, task: MaintenanceTask): Promise<Job | undefined> => {
  if (!task.jobProjectId) return undefined;
  const { rows } = await db.query<{ id: string }>(
    "SELECT id::text FROM public.milestones WHERE project_id = $1 ORDER BY position LIMIT 1",
    [task.jobProjectId],
  );
  const milestoneId = rows[0]?.id;
  return milestoneId ? { milestoneId, projectId: task.jobProjectId } : undefined;
};

export type JobInvoiceDeps = Omit<FlowDeps, "runAsUser"> & { runAsUser: UserDbRunner };

/** The existing invoice flow, with an optional deposit. A repeat finds the invoice already made. */
export const createJobInvoice = async (
  deps: JobInvoiceDeps,
  taskId: string,
  { depositCents, includeSignature }: { depositCents?: number; includeSignature?: boolean } = {},
): Promise<JobInvoiceResult> => {
  const prepared = await deps.runAsUser(async (db): Promise<Job | "no_cost" | undefined> => {
    const task = await getMaintenanceTask(db, taskId, deps.now);
    if (!task) return undefined;
    if (!task.estCostCents) return "no_cost";
    return (await existingJob(db, task)) ?? makeJob(db, task, depositCents !== undefined);
  });
  if (!prepared) return { ok: false, notFound: true };
  if (prepared === "no_cost") return { ok: false, conflict: NO_COST };
  const result = await issueMilestoneInvoice(
    deps,
    prepared.milestoneId,
    {
      ...(depositCents === undefined ? {} : { depositCents }),
      ...(includeSignature === undefined ? {} : { includeSignature }),
    },
  );
  if (!result.ok) return result;
  return {
    ok: true,
    invoices: result.invoices,
    projectId: prepared.projectId,
    sentNow: result.sentNow,
  };
};
