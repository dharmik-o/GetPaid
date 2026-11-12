import { z } from "zod";
import { isUuid, type Db } from "./db";
import { toFieldIssues, type FieldIssue } from "./field-issues";
import { formatMoney } from "./format";
import { cancelInPaypal } from "./invoice-cancel";
import type { FlowDeps } from "./invoice-flow";
import { getInvoiceRecord, markCancelled } from "./invoices";
import { voidHold, type HoldDeps } from "./hold-flow";
import { LIVE_HOLD_SQL } from "./milestone-holds";
import { getProject } from "./projects";

// Server-only: delete a project with everything under it (milestones, invoices, reminders,
// agreements, holds, maintenance jobs and the calendar items tied to it), in one transaction.
// Unpaid PayPal invoices and open holds are cancelled or voided FIRST, only if the freelancer
// ticked the box; PayPal is never called inside a transaction, and if any PayPal call fails
// nothing is deleted. Invoice PDFs already in the archive folder stay on disk.

export type OpenItems = {
  invoices: { id: string; number: string; status: string; label: string }[];
  holds: { milestoneId: string; name: string }[];
};

export type DeleteProjectResult =
  | { ok: true }
  | { ok: false; notFound: true }
  | { ok: false; errors: FieldIssue[] }
  | { ok: false; conflict: string };

export type DeleteProjectDeps = FlowDeps & { holds: HoldDeps; userId: string };

/** Invoices that aren't paid, cancelled or refunded, and holds still in progress. */
export const loadOpenItems = async (db: Db, projectId: string): Promise<OpenItems> => {
  const { rows: invoices } = await db.query<{
    id: string;
    invoice_number: string;
    status: string;
    amount_cents: string;
    currency: string;
    name: string;
  }>(
    `SELECT i.id::text, i.invoice_number, i.status, i.amount_cents::text, i.currency, m.name
     FROM public.invoices i JOIN public.milestones m ON m.id = i.milestone_id
     WHERE m.project_id = $1 AND i.status NOT IN ('paid', 'cancelled', 'refunded')
     ORDER BY i.created_at`,
    [projectId],
  );
  const { rows: holds } = await db.query<{ milestone_id: string; name: string }>(
    `SELECT h.milestone_id::text, m.name FROM public.milestone_holds h
     JOIN public.milestones m ON m.id = h.milestone_id
     WHERE m.project_id = $1 AND h.status IN (${LIVE_HOLD_SQL}) ORDER BY m.position`,
    [projectId],
  );
  return {
    invoices: invoices.map((row) => ({
      id: row.id,
      number: row.invoice_number,
      status: row.status,
      label: `${row.invoice_number} · ${row.name} · ${formatMoney(Number(row.amount_cents), row.currency)}`,
    })),
    holds: holds.map((row) => ({ milestoneId: row.milestone_id, name: row.name })),
  };
};

const bodySchema = z.strictObject({
  confirmName: z.string({ error: "must be the project's name, typed exactly" }),
  cancelOpen: z.boolean({ error: "must be true or false" }).optional(),
});

const listOf = (open: OpenItems): string =>
  [
    ...(open.invoices.length > 0
      ? [`unpaid invoices: ${open.invoices.map((i) => i.label).join("; ")}`]
      : []),
    ...(open.holds.length > 0 ? [`open holds: ${open.holds.map((h) => h.name).join("; ")}`] : []),
  ].join(". ");

export const deleteProject = async (
  deps: DeleteProjectDeps,
  projectId: string,
  raw: unknown,
): Promise<DeleteProjectResult> => {
  if (!isUuid(projectId)) return { ok: false, notFound: true };
  const loaded = await deps.runAsUser(async (db) => {
    const project = await getProject(db, projectId);
    return project ? { project, open: await loadOpenItems(db, projectId) } : undefined;
  });
  if (!loaded) return { ok: false, notFound: true };
  const { project, open } = loaded;

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
  if (parsed.data.confirmName !== project.title) {
    return {
      ok: false,
      errors: [{ field: "confirmName", message: "must match the project's name exactly" }],
    };
  }

  const anyOpen = open.invoices.length > 0 || open.holds.length > 0;
  if (anyOpen && !parsed.data.cancelOpen) {
    return {
      ok: false,
      conflict: `This project still has ${listOf(open)}. Tick "Cancel them in PayPal too" to cancel or void them first, then delete.`,
    };
  }

  for (const item of open.invoices) {
    const record = await deps.runAsUser((db) => getInvoiceRecord(db, item.id));
    if (!record) continue;
    const refused = await cancelInPaypal(
      deps,
      record,
      `Invoice ${record.invoiceNumber} already has money on it, so it can't be cancelled and nothing was deleted. Refund it in PayPal first, or archive the project instead.`,
    );
    if (refused) return { ok: false, conflict: refused };
    // Saved at once, so a later failure leaves this invoice shown as cancelled, as PayPal has it.
    await deps.runAsUser((db) =>
      markCancelled(db, record, record.milestoneStatusBefore ?? "accepted", "other"),
    );
  }
  for (const hold of open.holds) {
    const result = await voidHold(deps.holds, {
      userId: deps.userId,
      milestoneId: hold.milestoneId,
    });
    if (result.status === "conflict") {
      return { ok: false, conflict: `${result.message} Nothing was deleted.` };
    }
  }

  await deps.runAsUser(async (db) => {
    await db.query(
      `DELETE FROM public.calendar_entries
       WHERE project_id = $1 OR milestone_id IN (SELECT id FROM public.milestones WHERE project_id = $1)`,
      [projectId],
    );
    await db.query("DELETE FROM public.projects WHERE id = $1", [projectId]);
  });
  return { ok: true };
};
