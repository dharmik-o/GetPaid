import { z } from "zod";
import { isUuid, type Db } from "./db";
import { toFieldIssues, type FieldIssue } from "./field-issues";
import { loadMilestoneContext } from "./invoice-context";
import { deleteUninvoicedPlan, insertPlan, type InstallmentPlan } from "./installment-plans";
import { checkInstallments, parseInstallmentItems } from "./installments";
import { invoiceDates } from "./schedule";

// Server-only: "Pay in installments" at setup. The freelancer sets each installment's amount
// and due date on a pay-on-invoice milestone; all its invoices are created when the work is
// delivered. A plan can change only until its first invoice exists.

export type SetupResult =
  | { ok: true; plan: InstallmentPlan | null }
  | { ok: false; errors: FieldIssue[] }
  | { ok: false; notFound: true }
  | { ok: false; conflict: string };

const NOT_FOUND = { ok: false, notFound: true } as const;

const HAS_INVOICE =
  "This milestone already has an invoice, so its installments can't change here. Cancel the invoice first.";

const bodySchema = z.strictObject({ items: z.unknown() });

/** Saves (or replaces) the milestone's setup plan. */
export const saveSetupPlan = async (
  db: Db,
  milestoneId: string,
  raw: unknown,
  now: Date,
): Promise<SetupResult> => {
  if (!isUuid(milestoneId)) return NOT_FOUND;
  const context = await loadMilestoneContext(db, milestoneId);
  if (!context) return NOT_FOUND;
  const body = bodySchema.safeParse(raw);
  if (!body.success) {
    return { ok: false, errors: toFieldIssues(body.error, { noun: "field" }) };
  }
  const parsed = parseInstallmentItems(body.data.items);
  if (!parsed.ok) return parsed;
  const { milestone, project, plan, open } = context;
  if (milestone.paymentMode !== "pay_on_invoice") {
    return {
      ok: false,
      errors: [
        {
          field: "paymentMode",
          message:
            "isn't Pay on invoice. Installments at setup are for pay-on-invoice milestones; a deposit's installments are set when it's invoiced.",
        },
      ],
    };
  }
  if (open.length > 0) return { ok: false, conflict: HAS_INVOICE };
  const { issuedOn } = invoiceDates(context.terms, now, project.clientTimeZone);
  const errors = checkInstallments(parsed.items, {
    totalCents: milestone.cents,
    currency: project.currency,
    datesRequired: true,
    today: issuedOn,
  });
  if (errors.length > 0) return { ok: false, errors };
  if (plan && !(await deleteUninvoicedPlan(db, plan.id))) {
    return { ok: false, conflict: HAS_INVOICE };
  }
  const saved = await insertPlan(db, {
    milestoneId,
    totalCents: milestone.cents,
    currency: project.currency,
    items: parsed.items,
    createdFrom: "setup",
  });
  return { ok: true, plan: saved };
};

/** Removes the setup plan, so the milestone is billed as one invoice again. */
export const removeSetupPlan = async (db: Db, milestoneId: string): Promise<SetupResult> => {
  if (!isUuid(milestoneId)) return NOT_FOUND;
  const context = await loadMilestoneContext(db, milestoneId);
  if (!context) return NOT_FOUND;
  if (!context.plan) return { ok: true, plan: null };
  if (context.open.length > 0 || !(await deleteUninvoicedPlan(db, context.plan.id))) {
    return { ok: false, conflict: HAS_INVOICE };
  }
  return { ok: true, plan: null };
};
