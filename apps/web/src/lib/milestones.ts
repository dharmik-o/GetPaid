import { z } from "zod";
import { isUuid, type Db } from "./db";
import { toCents } from "./db-values";
import { nestIssues, toFieldIssues, type FieldIssue } from "./field-issues";
import { checkPlan, milestoneCents, type PlanItem } from "./milestone-plan";
import {
  canMarkManually,
  hasInvoice,
  isMilestoneStatus,
  manualNextStatuses,
  statusLabel,
  type MilestoneStatus,
} from "./milestone-status";
import { LIVE_HOLD_SQL } from "./milestone-holds";
import { getProject, type Project } from "./projects";
import { settingsOverrideSchema, type SettingsOverride } from "./settings";
import { validateSettings } from "./settings-validation";

// Server-only: a project's milestone plan. The whole plan is saved at once, so the totals
// check always sees every milestone. Queries run as the signed-in user (RLS).

export type Milestone = {
  id: string;
  position: number;
  name: string;
  deliverable: string | null;
  amountCents: number | null;
  percentBp: number | null;
  /** The amount in minor units, worked out from the percentage where needed. */
  cents: number;
  deadline: string;
  acceptanceWindowDays: number | null;
  paymentMode: "pay_on_invoice" | "deposit" | "hold";
  settings: SettingsOverride;
  status: MilestoneStatus;
};

export type PlanResult =
  | { ok: true; milestones: Milestone[]; warnings: FieldIssue[] }
  | { ok: false; errors: FieldIssue[] }
  | { ok: false; notFound: true };

const ONE_SHARE = "set either an amount or a percentage, not both";

const itemSchema = z
  .strictObject({
    id: z.string().refine(isUuid, "isn't a milestone of this project").optional(),
    name: z
      .string({ error: "is required" })
      .trim()
      .min(1, "is required")
      .max(200, "must be 200 characters or fewer"),
    deliverable: z
      .string()
      .trim()
      .max(5000, "must be 5,000 characters or fewer")
      .nullable()
      .optional(),
    amountCents: z
      .int("must be a whole number of minor units (cents)")
      .min(1, "must be more than 0")
      .max(Number.MAX_SAFE_INTEGER, "is too large")
      .optional(),
    percentBp: z.int().min(1, "must be more than 0%").max(10000, "must be 100% or less").optional(),
    deadline: z.iso.date({ error: "must be a date like 2026-12-31" }),
    acceptanceWindowDays: z
      .int("must be a whole number of days")
      .min(0, "can't be negative")
      .max(365, "must be 365 days or fewer")
      .nullable()
      .optional(),
    paymentMode: z
      .enum(["pay_on_invoice", "deposit", "hold"], {
        error: "must be pay on invoice, deposit or hold",
      })
      .default("pay_on_invoice"),
    settings: z.unknown().optional(),
  })
  .superRefine((item, ctx) => {
    if ((item.amountCents === undefined) === (item.percentBp === undefined)) {
      ctx.addIssue({ code: "custom", path: ["amountCents"], message: ONE_SHARE });
    }
  });

const planSchema = z.strictObject({
  milestones: z.array(itemSchema).max(50, "can have at most 50 milestones"),
});

type Item = z.infer<typeof itemSchema>;

type MilestoneRow = {
  id: string;
  position: number;
  name: string;
  deliverable: string | null;
  amount_cents: string | null;
  percent_bp: number | null;
  deadline: string;
  acceptance_window_days: number | null;
  payment_mode: Milestone["paymentMode"];
  settings: unknown;
  status: string;
  open_invoice: boolean;
  live_hold: boolean;
};

type StoredMilestone = Omit<Milestone, "cents"> & { locked: boolean; liveHold: boolean };

const SELECT_MILESTONES = `
  SELECT m.id::text, m.position, m.name, m.deliverable, m.amount_cents::text, m.percent_bp,
    m.deadline::text, m.acceptance_window_days, m.payment_mode, m.settings, m.status,
    EXISTS (
      SELECT 1 FROM public.invoices i WHERE i.milestone_id = m.id AND i.status <> 'cancelled'
    ) AS open_invoice,
    EXISTS (
      SELECT 1 FROM public.milestone_holds h
      WHERE h.milestone_id = m.id AND h.status IN (${LIVE_HOLD_SQL})
    ) AS live_hold
  FROM public.milestones m`;

const toStored = (row: MilestoneRow): StoredMilestone => {
  const status = isMilestoneStatus(row.status) ? row.status : "planned";
  return {
    id: row.id,
    position: row.position,
    name: row.name,
    deliverable: row.deliverable,
    amountCents: row.amount_cents === null ? null : toCents(row.amount_cents),
    percentBp: row.percent_bp,
    deadline: row.deadline,
    acceptanceWindowDays: row.acceptance_window_days,
    paymentMode: row.payment_mode,
    settings: settingsOverrideSchema.parse(row.settings),
    status,
    // An invoice exists: its amount is fixed and the milestone can't be deleted (that would delete the invoice).
    locked: hasInvoice(status) || row.open_invoice || row.live_hold,
    liveHold: row.live_hold,
  };
};

const planItemOf = (m: {
  name: string;
  deadline: string;
  amountCents?: number | null;
  percentBp?: number | null;
}): PlanItem =>
  m.amountCents !== null && m.amountCents !== undefined
    ? { name: m.name, deadline: m.deadline, amountCents: m.amountCents }
    : { name: m.name, deadline: m.deadline, percentBp: m.percentBp ?? 0 };

const withCents = (stored: StoredMilestone[], totalCents: number): Milestone[] => {
  const cents = milestoneCents(stored.map(planItemOf), totalCents);
  return stored.map((m, index) => ({
    id: m.id,
    position: m.position,
    name: m.name,
    deliverable: m.deliverable,
    amountCents: m.amountCents,
    percentBp: m.percentBp,
    cents: cents[index] ?? 0,
    deadline: m.deadline,
    acceptanceWindowDays: m.acceptanceWindowDays,
    paymentMode: m.paymentMode,
    settings: m.settings,
    status: m.status,
  }));
};

const loadStored = async (db: Db, projectId: string): Promise<StoredMilestone[]> => {
  const { rows } = await db.query<MilestoneRow>(
    `${SELECT_MILESTONES} WHERE m.project_id = $1 ORDER BY m.position`,
    [projectId],
  );
  return rows.map(toStored);
};

export const listMilestones = async (db: Db, project: Project): Promise<Milestone[]> =>
  withCents(await loadStored(db, project.id), project.totalCents);

/** Settings overrides per milestone, checked against the project's schedule and contract. */
const settingsIssues = (
  items: Item[],
  project: Project,
): { errors: FieldIssue[]; warnings: FieldIssue[]; settings: SettingsOverride[] } => {
  const parent = { ...project.inherited, ...project.settings };
  const results = items.map((item) =>
    validateSettings(item.settings ?? {}, {
      parent,
      deadline: item.deadline,
      contractHasLateFee: project.lateFeeClause !== null,
    }),
  );
  return {
    errors: results.flatMap((r, i) =>
      r.ok ? [] : nestIssues(r.errors, `milestones.${String(i)}.settings`),
    ),
    warnings: results.flatMap((r, i) => nestIssues(r.warnings, `milestones.${String(i)}.settings`)),
    settings: results.map((r) => (r.ok ? r.settings : {})),
  };
};

/** Invoiced milestones keep their share and can't be removed; ids must belong to this project. */
const lockIssues = (items: Item[], stored: StoredMilestone[]): FieldIssue[] => {
  const byId = new Map(stored.map((m) => [m.id, m]));
  const kept = new Set(items.map((item) => item.id));
  const itemIssues = items.flatMap((item, index): FieldIssue[] => {
    if (item.id === undefined) return [];
    const existing = byId.get(item.id);
    const at = `milestones.${String(index)}`;
    if (!existing) return [{ field: `${at}.id`, message: "isn't a milestone of this project" }];
    if (existing.liveHold && item.paymentMode !== existing.paymentMode) {
      return [
        {
          field: `${at}.paymentMode`,
          message: "can't change while a hold is in progress. Void the hold first.",
        },
      ];
    }
    const sameShare =
      (existing.amountCents ?? undefined) === item.amountCents &&
      (existing.percentBp ?? undefined) === item.percentBp;
    if (!existing.locked || sameShare) return [];
    const field = item.percentBp === undefined ? "amountCents" : "percentBp";
    return [
      {
        field: `${at}.${field}`,
        message: "can't change once the milestone has an invoice. Cancel the invoice first.",
      },
    ];
  });
  const removed = stored
    .filter((m) => m.locked && !kept.has(m.id))
    .map((m) => ({
      field: "milestones",
      message: m.liveHold
        ? `${m.name} has a hold in progress, so it can't be removed. Void the hold first.`
        : `${m.name} has an invoice, so it can't be removed. Cancel the invoice first.`,
    }));
  return [...itemIssues, ...removed];
};

const writePlan = async (
  db: Db,
  project: Project,
  items: Item[],
  settings: SettingsOverride[],
  stored: StoredMilestone[],
): Promise<void> => {
  // Positions are unique per project; checking that at commit lets the plan be reordered.
  await db.query("SET CONSTRAINTS ALL DEFERRED");
  const keep = items.flatMap((item) => (item.id ? [item.id] : []));
  const removed = stored.filter((m) => !keep.includes(m.id)).map((m) => m.id);
  if (removed.length > 0) {
    await db.query("DELETE FROM public.milestones WHERE project_id = $1 AND id = ANY($2::uuid[])", [
      project.id,
      removed,
    ]);
  }
  for (const [index, item] of items.entries()) {
    const values = [
      index + 1,
      item.name,
      item.deliverable ?? null,
      item.amountCents ?? null,
      item.percentBp ?? null,
      item.deadline,
      item.acceptanceWindowDays ?? null,
      item.paymentMode,
      JSON.stringify(settings[index] ?? {}),
    ];
    if (item.id) {
      await db.query(
        `UPDATE public.milestones SET position = $2, name = $3, deliverable = $4, amount_cents = $5,
           percent_bp = $6, deadline = $7, acceptance_window_days = $8, payment_mode = $9, settings = $10
         WHERE id = $1`,
        [item.id, ...values],
      );
    } else {
      await db.query(
        `INSERT INTO public.milestones (user_id, project_id, currency, position, name, deliverable,
           amount_cents, percent_bp, deadline, acceptance_window_days, payment_mode, settings)
         VALUES ((SELECT auth.uid()), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [project.id, project.currency, ...values],
      );
    }
  }
};

/** Checks and saves the whole plan: fields, totals, invoice locks; deadline order only warns. */
export const saveMilestonePlan = async (
  db: Db,
  projectId: string,
  raw: unknown,
): Promise<PlanResult> => {
  const project = await getProject(db, projectId);
  if (!project) return { ok: false, notFound: true };
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };

  const items = parsed.data.milestones;
  const stored = await loadStored(db, project.id);
  const plan = checkPlan(items.map(planItemOf), project.totalCents, project.currency);
  const settings = settingsIssues(items, project);
  const errors = [...lockIssues(items, stored), ...plan.errors, ...settings.errors];
  if (errors.length > 0) return { ok: false, errors };

  await writePlan(db, project, items, settings.settings, stored);
  return {
    ok: true,
    milestones: await listMilestones(db, project),
    warnings: [...plan.warnings, ...settings.warnings],
  };
};

export type StatusResult =
  | { ok: true; milestone: Milestone }
  | { ok: false; errors: FieldIssue[] }
  | { ok: false; notFound: true };

const statusSchema = z.strictObject({
  status: z
    .string({ error: "must be a milestone status" })
    .refine(isMilestoneStatus, "must be a milestone status"),
});

const transitionMessage = (from: MilestoneStatus, to: MilestoneStatus): string => {
  if (hasInvoice(to))
    return `is set by the invoice and PayPal, never by hand. ${statusLabel(to)} can't be chosen here.`;
  const next = manualNextStatuses(from)[0];
  return next
    ? `can't go from ${statusLabel(from)} to ${statusLabel(to)}. Mark it ${statusLabel(next)} first.`
    : `can't go from ${statusLabel(from)} to ${statusLabel(to)}: it's now handled by the invoice.`;
};

/** A freelancer's manual status change, one step of the lifecycle at a time. */
export const markMilestoneStatus = async (
  db: Db,
  id: string,
  raw: unknown,
): Promise<StatusResult> => {
  const { rows } = await db.query<MilestoneRow & { project_id: string }>(
    `${SELECT_MILESTONES.replace("SELECT m.id::text,", "SELECT m.project_id::text, m.id::text,")} WHERE m.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return { ok: false, notFound: true };
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
  const current = toStored(row);
  const to = parsed.data.status;
  if (!canMarkManually(current.status, to)) {
    return {
      ok: false,
      errors: [{ field: "status", message: transitionMessage(current.status, to) }],
    };
  }
  await db.query("UPDATE public.milestones SET status = $2 WHERE id = $1", [id, to]);
  const project = await getProject(db, row.project_id);
  const milestone = project
    ? (await listMilestones(db, project)).find((m) => m.id === id)
    : undefined;
  if (!milestone) throw new Error("The milestone could not be read back after saving.");
  return { ok: true, milestone };
};

export type DeleteMilestoneResult = "deleted" | "not_found" | "has_invoice" | "has_hold";

/**
 * Deletes one milestone, only while it has no invoice and no hold of any kind (a cancelled
 * invoice or a voided hold is still a record, and would go with it). Positions keep their gaps:
 * the plan is renumbered the next time it is saved.
 */
export const deleteMilestone = async (db: Db, id: string): Promise<DeleteMilestoneResult> => {
  const { rows } = await db.query<{ invoices: boolean; holds: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.invoices i WHERE i.milestone_id = m.id) AS invoices,
       EXISTS (SELECT 1 FROM public.milestone_holds h WHERE h.milestone_id = m.id) AS holds
     FROM public.milestones m WHERE m.id = $1 FOR UPDATE`,
    [id],
  );
  const found = rows[0];
  if (!found) return "not_found";
  if (found.invoices) return "has_invoice";
  if (found.holds) return "has_hold";
  await db.query("DELETE FROM public.milestones WHERE id = $1", [id]);
  return "deleted";
};
