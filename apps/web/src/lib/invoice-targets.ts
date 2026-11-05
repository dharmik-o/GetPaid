import { z } from "zod";
import { invoiceTextSchema } from "./ai-schemas";
import type { FieldIssue } from "./field-issues";
import { formatDay, formatMoney } from "./format";
import { BEFORE_INVOICE, type MilestoneContext } from "./invoice-context";
import type { NewPlan } from "./installment-plans";
import {
  checkInstallments,
  depositItems,
  MAX_INSTALLMENTS,
  type InstallmentItem,
} from "./installments";
import { statusLabel } from "./milestone-status";

// Server-only: what one "create invoice" request may invoice for a milestone. One plain
// invoice, a deposit's installment, or every installment of a setup plan. Never PayPal partial
// payments: a client who pays in parts gets separate installment invoices.

export const issueBodySchema = z.strictObject({
  /** Deposit milestones: installment 1, due at kickoff. The whole amount makes one plain invoice. */
  depositCents: z
    .int("must be a whole number of minor units (cents)")
    .min(1, "must be more than 0")
    .max(Number.MAX_SAFE_INTEGER, "is too large")
    .optional(),
  /** Deposit plans: which installment to invoice (2 = the rest, once the work is delivered). */
  installment: z
    .int("must be a whole number")
    .min(1, "must be 1 or more")
    .max(MAX_INSTALLMENTS, `can't be more than ${String(MAX_INSTALLMENTS)}`)
    .optional(),
  /** The invoice document's template; omit for the client's or the account's default. */
  templateId: z.uuid({ error: "must be picked from the list" }).optional(),
  /** The document's text tags, as the freelancer approved them; omit for the fixed text. */
  text: invoiceTextSchema.optional(),
  /** "Include my signature"; omit for this milestone's earlier choice, or the account's default. */
  includeSignature: z.boolean({ error: "must be on or off" }).optional(),
});

export type IssueBody = z.infer<typeof issueBodySchema>;

/** One invoice to create: null number = a plain invoice. dueDate null = per the terms. */
export type Target = { number: number | null; amountCents: number; dueDate: string | null };

export type Targets =
  | { ok: true; targets: Target[]; newPlan?: Omit<NewPlan, "milestoneId"> }
  | { ok: false; errors: FieldIssue[] };

type Dates = { issuedOn: string; dueDate: string };

const fail = (field: string, message: string): Targets => ({
  ok: false,
  errors: [{ field, message }],
});

const isOpen = (context: MilestoneContext, number: number | null): boolean =>
  context.open.some((record) => (record.installment?.number ?? null) === number);

/** The numbers a request asks for; when all are already invoiced, nothing new is created. */
export const requestedNumbers = (context: MilestoneContext, body: IssueBody): (number | null)[] => {
  const { plan } = context;
  if (!plan) return [null];
  if (plan.createdFrom === "deposit") return [body.installment ?? 1];
  return plan.items.map((_, index) => index + 1);
};

export const alreadyInvoiced = (context: MilestoneContext, body: IssueBody): boolean =>
  requestedNumbers(context, body).every((number) => isOpen(context, number));

/** Pay-on-invoice work is billed once delivered; deposits from kickoff on. */
const statusErrors = (context: MilestoneContext): FieldIssue[] => {
  const { milestone } = context;
  const label = statusLabel(milestone.status);
  if (!BEFORE_INVOICE.includes(milestone.status)) {
    return [{ field: "status", message: `is ${label}, so it can't get a new invoice.` }];
  }
  if (
    milestone.paymentMode === "pay_on_invoice" &&
    !["delivered", "accepted"].includes(milestone.status)
  ) {
    return [
      {
        field: "status",
        message: `is ${label}. Mark it Delivered first: pay-on-invoice milestones are billed once the work is delivered.`,
      },
    ];
  }
  return [];
};

const termsError = (dates: Dates): FieldIssue[] =>
  dates.dueDate < dates.issuedOn
    ? [
        {
          field: "paymentTerms",
          message: `say the invoice is due on ${formatDay(dates.dueDate)}, which has passed. Change the payment terms on the milestone or project, then try again.`,
        },
      ]
    : [];

const noExtras = (body: IssueBody, field: keyof IssueBody, message: string): FieldIssue[] =>
  body[field] === undefined ? [] : [{ field, message }];

/** A milestone with no plan: one plain invoice, or a deposit (plain if it's the whole amount). */
const withoutPlan = (context: MilestoneContext, body: IssueBody, dates: Dates): Targets => {
  const { milestone, project } = context;
  const errors = [
    ...statusErrors(context),
    ...noExtras(body, "installment", "can only be chosen on a milestone with installments"),
  ];
  if (milestone.paymentMode !== "deposit") {
    errors.push(...noExtras(body, "depositCents", "can only be set on a deposit milestone"));
  } else if (body.depositCents === undefined) {
    errors.push({ field: "depositCents", message: "is required for a deposit" });
  } else if (body.depositCents > milestone.cents) {
    errors.push({
      field: "depositCents",
      message: `can't be more than the milestone amount, ${formatMoney(milestone.cents, project.currency)}`,
    });
  }
  errors.push(...termsError(dates));
  if (errors.length > 0) return { ok: false, errors };

  const deposit = body.depositCents;
  if (deposit === undefined || deposit === milestone.cents) {
    return { ok: true, targets: [{ number: null, amountCents: milestone.cents, dueDate: null }] };
  }
  const items = depositItems(deposit, milestone.cents);
  return {
    ok: true,
    targets: [{ number: 1, amountCents: deposit, dueDate: null }],
    newPlan: {
      totalCents: milestone.cents,
      currency: project.currency,
      items,
      createdFrom: "deposit",
    },
  };
};

const totalsErrors = (context: MilestoneContext, items: InstallmentItem[]): FieldIssue[] =>
  checkInstallments(items, {
    totalCents: context.milestone.cents,
    currency: context.project.currency,
    datesRequired: false,
    // Dates are checked only for the installments being invoiced now (below).
    today: "",
  }).map((issue) => ({
    field: issue.field,
    message:
      issue.field === "items"
        ? `The installments ${issue.message} (the milestone amount). Change the installment plan.`
        : issue.message,
  }));

/** A deposit plan: one installment at a time, in order (the rest once the work is delivered). */
const depositPlanTargets = (context: MilestoneContext, body: IssueBody, dates: Dates): Targets => {
  const plan = context.plan;
  if (!plan) return fail("plan", "is missing");
  const number = body.installment ?? 1;
  const item = plan.items[number - 1];
  if (!item) return fail("installment", `must be 1 to ${String(plan.count)} for this plan`);
  if (number > 1 && !isOpen(context, number - 1)) {
    return fail("installment", `needs installment ${String(number - 1)} invoiced first`);
  }
  if (number > 1 && body.depositCents !== undefined) {
    return fail("depositCents", "is already set: it's installment 1");
  }
  const errors = [...totalsErrors(context, plan.items), ...termsError(dates)];
  if (number === 1) errors.push(...statusErrors(context));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, targets: [{ number, ...item }] };
};

/** A setup plan: every installment is invoiced together, each with its own due date. */
const setupPlanTargets = (context: MilestoneContext, body: IssueBody, dates: Dates): Targets => {
  const plan = context.plan;
  if (!plan) return fail("plan", "is missing");
  if (context.milestone.paymentMode !== "pay_on_invoice") {
    return fail(
      "paymentMode",
      "isn't Pay on invoice any more, but the milestone has an installment plan. Remove the plan or change the mode back.",
    );
  }
  const errors = [
    ...noExtras(body, "depositCents", "is only for deposit milestones"),
    ...noExtras(body, "installment", "isn't needed: all installments are invoiced together"),
    ...(context.open.length === 0 ? statusErrors(context) : []),
    ...totalsErrors(context, plan.items),
  ];
  const targets = plan.items
    .map((item, index): Target => ({ number: index + 1, ...item }))
    .filter((target) => !isOpen(context, target.number));
  for (const target of targets) {
    if (target.dueDate !== null && target.dueDate < dates.issuedOn) {
      errors.push({
        field: `items.${String((target.number ?? 1) - 1)}.dueDate`,
        message: `(installment ${String(target.number)}) was ${formatDay(target.dueDate)}, which has passed. Change the installment plan.`,
      });
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, targets };
};

/** What to create for this request. Holds never get an invoice; disputed milestones neither. */
export const issueTargets = (context: MilestoneContext, body: IssueBody, dates: Dates): Targets => {
  const { milestone, plan } = context;
  if (milestone.paymentMode === "hold") {
    return fail(
      "paymentMode",
      "is Milestone hold: the client authorizes the payment at the start instead of getting an invoice.",
    );
  }
  if (milestone.status === "disputed") {
    return fail("status", "is Disputed, so it can't get a new invoice.");
  }
  if (!plan) return withoutPlan(context, body, dates);
  return plan.createdFrom === "deposit"
    ? depositPlanTargets(context, body, dates)
    : setupPlanTargets(context, body, dates);
};
