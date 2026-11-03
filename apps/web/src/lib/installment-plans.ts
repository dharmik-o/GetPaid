import type { Db } from "./db";
import { toCents } from "./db-values";
import { installmentItemsSchema, type InstallmentItem } from "./installments";

// Server-only: installment plan rows. Queries run as the signed-in user (RLS), so another
// user's plan is simply not found.

export type PlanSource = "setup" | "deposit" | "client_request";

export type InstallmentPlan = {
  id: string;
  milestoneId: string;
  count: number;
  totalCents: number;
  currency: string;
  items: InstallmentItem[];
  createdFrom: PlanSource;
};

type PlanRow = {
  id: string;
  milestone_id: string;
  count: number;
  total_cents: unknown;
  currency: string;
  items: unknown;
  created_from: PlanSource;
};

const SELECT_PLANS = `
  SELECT p.id::text, p.milestone_id::text, p.count, p.total_cents::text, p.currency, p.items,
    p.created_from
  FROM public.installment_plans p`;

const toPlan = (row: PlanRow): InstallmentPlan => ({
  id: row.id,
  milestoneId: row.milestone_id,
  count: row.count,
  totalCents: toCents(row.total_cents),
  currency: row.currency,
  // Written only by this app, but checked again: money never comes from an unchecked value.
  items: installmentItemsSchema.parse(row.items),
  createdFrom: row.created_from,
});

/** The milestone's active plan; there is at most one. */
export const getActivePlan = async (
  db: Db,
  milestoneId: string,
): Promise<InstallmentPlan | undefined> => {
  const { rows } = await db.query<PlanRow>(
    `${SELECT_PLANS} WHERE p.milestone_id = $1 AND p.status = 'active'`,
    [milestoneId],
  );
  return rows[0] ? toPlan(rows[0]) : undefined;
};

export const listActivePlansForProject = async (
  db: Db,
  projectId: string,
): Promise<InstallmentPlan[]> => {
  const { rows } = await db.query<PlanRow>(
    `${SELECT_PLANS} JOIN public.milestones m ON m.id = p.milestone_id
     WHERE m.project_id = $1 AND p.status = 'active'`,
    [projectId],
  );
  return rows.map(toPlan);
};

export type NewPlan = {
  milestoneId: string;
  totalCents: number;
  currency: string;
  items: InstallmentItem[];
  createdFrom: PlanSource;
};

/** Saves an active plan; if two requests race, the one-active-plan index keeps the first. */
export const insertPlan = async (db: Db, plan: NewPlan): Promise<InstallmentPlan> => {
  await db.query(
    `INSERT INTO public.installment_plans
       (user_id, milestone_id, count, total_cents, currency, items, created_from)
     VALUES ((SELECT auth.uid()), $1, $2, $3, $4, $5, $6)
     ON CONFLICT (milestone_id) WHERE status = 'active' DO NOTHING`,
    [
      plan.milestoneId,
      plan.items.length,
      plan.totalCents,
      plan.currency,
      JSON.stringify(plan.items),
      plan.createdFrom,
    ],
  );
  const saved = await getActivePlan(db, plan.milestoneId);
  if (!saved) throw new Error("The installment plan could not be read back after saving.");
  return saved;
};

/** Removes a plan that has never had an invoice (a setup plan the freelancer changed). */
export const deleteUninvoicedPlan = async (db: Db, planId: string): Promise<boolean> => {
  const { rowCount } = await db.query(
    `DELETE FROM public.installment_plans p
     WHERE p.id = $1 AND NOT EXISTS (
       SELECT 1 FROM public.invoices i WHERE i.installment_plan_id = p.id)`,
    [planId],
  );
  return rowCount > 0;
};

export const setPlanStatus = async (
  db: Db,
  planId: string,
  status: "completed" | "cancelled",
): Promise<void> => {
  await db.query(
    "UPDATE public.installment_plans SET status = $2 WHERE id = $1 AND status = 'active'",
    [planId, status],
  );
};
