import { z } from "zod";
import type { UserDbRunner } from "./db";
import type { DrafterDeps } from "./drafter";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";
import { logEvent } from "./log";
import {
  createMaintenanceTask,
  listMaintenanceTasks,
  markDone,
  reschedule,
  snooze,
  stopTask,
  type ChangeResult,
} from "./maintenance";
import { createJobInvoice, tellClient } from "./maintenance-actions";
import { PaypalError, type PaypalClient } from "./paypal";

// Server-only: /api/maintenance, as the signed-in freelancer. Tell the client only makes a draft
// that waits in the Outbox.

type Deps = DrafterDeps & {
  /** The signed-in freelancer. */
  currentUser: () => string;
  runAsCurrent: UserDbRunner;
  paypal: () => PaypalClient;
};
type IdContext = { params: Promise<{ id: string }> };

const TASK = "Maintenance job";

const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("tell") }),
  z.strictObject({
    action: z.literal("invoice"),
    depositCents: z
      .int("must be a whole number of minor units (cents)")
      .min(1, "must be more than 0")
      .max(Number.MAX_SAFE_INTEGER, "is too large")
      .optional(),
  }),
  z.strictObject({ action: z.literal("snooze") }),
  z.strictObject({
    action: z.literal("done"),
    /** The date on screen, so a double click can't move the job twice. */
    expectedDue: z.iso.date({ error: "must be a date" }),
  }),
  z.strictObject({
    action: z.literal("reschedule"),
    nextDue: z.iso.date({ error: "must be a date like 2026-12-31" }),
  }),
  z.strictObject({ action: z.literal("stop") }),
]);

const fromChange = (result: ChangeResult): Response => {
  switch (result.status) {
    case "ok":
      return jsonResponse({ date: result.date });
    case "not_found":
      return notFound(TASK);
    case "stale":
      return jsonResponse(
        { error: "This job has already moved on. Refresh to see its new date." },
        409,
      );
    case "invalid":
      return jsonResponse({ error: result.message }, 400);
  }
};

export const maintenanceHandlers = (deps: Deps) => ({
  list: async (): Promise<Response> => {
    try {
      const tasks = await deps.runAsCurrent((db) => listMaintenanceTasks(db, deps.now()));
      return jsonResponse({ tasks });
    } catch (error) {
      return serverError("maintenance.list_failed", error);
    }
  },

  create: async (request: Request): Promise<Response> => {
    const read = await readJson(request);
    if (!read.ok) return read.response;
    try {
      const created = await deps.runAsCurrent((db) => createMaintenanceTask(db, read.body));
      return created.ok ? jsonResponse({ id: created.id }, 201) : fieldErrors(created.errors);
    } catch (error) {
      return serverError("maintenance.create_failed", error);
    }
  },

  act: async (request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = actionSchema.safeParse(read.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    const action = parsed.data;
    const now = deps.now();
    try {
      switch (action.action) {
        case "tell": {
          const result = await tellClient(deps, { userId: deps.currentUser(), taskId: id });
          return result.status === "not_found"
            ? notFound(TASK)
            : jsonResponse({ status: result.status });
        }
        case "invoice": {
          const result = await createJobInvoice(
            { runAsUser: deps.runAsCurrent, paypal: deps.paypal(), now },
            id,
            action.depositCents === undefined ? {} : { depositCents: action.depositCents },
          );
          if (result.ok) {
            return jsonResponse(
              { invoices: result.invoices, projectId: result.projectId },
              result.sentNow ? 201 : 200,
            );
          }
          if ("notFound" in result) return notFound(TASK);
          if ("conflict" in result) return jsonResponse({ error: result.conflict }, 409);
          return fieldErrors(result.errors);
        }
        case "snooze":
          return fromChange(await deps.runAsCurrent((db) => snooze(db, id, now)));
        case "done":
          return fromChange(
            await deps.runAsCurrent((db) => markDone(db, id, now, action.expectedDue)),
          );
        case "reschedule":
          return fromChange(
            await deps.runAsCurrent((db) => reschedule(db, id, action.nextDue, now)),
          );
        case "stop":
          return fromChange(await deps.runAsCurrent((db) => stopTask(db, id, now)));
      }
    } catch (error) {
      if (error instanceof PaypalError) {
        logEvent("maintenance.paypal_failed", { status: error.status, issue: error.issue });
        return jsonResponse({ error: error.message }, 502);
      }
      return serverError("maintenance.action_failed", error);
    }
  },
});
