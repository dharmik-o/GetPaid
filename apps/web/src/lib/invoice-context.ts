import type { Db } from "./db";
import { getActivePlan, type InstallmentPlan } from "./installment-plans";
import { listOpenInvoices, type InvoiceRecord } from "./invoices";
import { listMilestones, type Milestone } from "./milestones";
import { getProject, type Project } from "./projects";
import { mergeSettings, type PaymentTerms } from "./settings";

// Server-only: everything the invoice and installment flows need about one milestone, read as
// the signed-in user (RLS), so another user's milestone is simply not found.

export type MilestoneContext = {
  project: Project;
  milestone: Milestone;
  clientEmail: string;
  /** Merged account, project and milestone payment terms. */
  terms: PaymentTerms;
  /** The active installment plan, if the milestone has one. */
  plan: InstallmentPlan | undefined;
  /** The milestone's invoices that aren't cancelled, in installment order. */
  open: InvoiceRecord[];
};

export const loadMilestoneContext = async (
  db: Db,
  milestoneId: string,
): Promise<MilestoneContext | undefined> => {
  const { rows } = await db.query<{ project_id: string; client_email: string }>(
    `SELECT m.project_id::text, c.email AS client_email
     FROM public.milestones m
     JOIN public.projects p ON p.id = m.project_id
     JOIN public.clients c ON c.id = p.client_id
     WHERE m.id = $1`,
    [milestoneId],
  );
  const row = rows[0];
  const project = row ? await getProject(db, row.project_id) : undefined;
  if (!row || !project) return undefined;
  const milestone = (await listMilestones(db, project)).find((m) => m.id === milestoneId);
  if (!milestone) return undefined;
  const { paymentTerms } = mergeSettings({
    account: project.inherited,
    project: project.settings,
    milestone: milestone.settings,
  });
  return {
    project,
    milestone,
    clientEmail: row.client_email,
    terms: paymentTerms,
    plan: await getActivePlan(db, milestoneId),
    open: await listOpenInvoices(db, milestoneId),
  };
};

/** The milestone statuses before any invoice; a person moves work through these. */
export const BEFORE_INVOICE: readonly string[] = [
  "planned",
  "in_progress",
  "delivered",
  "accepted",
];
