import type { UserDbRunner } from "./db";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";
import { removeSetupPlan, saveSetupPlan, type SetupResult } from "./installment-setup";
import { logEvent } from "./log";

// Server-only: PUT and DELETE /api/milestones/[id]/installments (the setup plan).
// The database runner and clock are injected so tests can use an in-memory database.

type Deps = { runAsUser: UserDbRunner; now: () => Date };
type IdContext = { params: Promise<{ id: string }> };

const respond = (result: SetupResult): Response => {
  if (result.ok) return jsonResponse({ plan: result.plan });
  if ("notFound" in result) return notFound("Milestone");
  if ("conflict" in result) return jsonResponse({ error: result.conflict }, 409);
  return fieldErrors(result.errors);
};

export const installmentHandlers = ({ runAsUser, now }: Deps) => ({
  save: async (request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    const body = await readJson(request);
    if (!body.ok) return body.response;
    try {
      const result = await runAsUser((db) => saveSetupPlan(db, id, body.body, now()));
      if (result.ok) {
        logEvent("installments.plan_saved", { milestoneId: id, count: result.plan?.count ?? null });
      }
      return respond(result);
    } catch (error) {
      return serverError("installments.plan_failed", error);
    }
  },

  remove: async (_request: Request, { params }: IdContext): Promise<Response> => {
    const { id } = await params;
    try {
      const result = await runAsUser((db) => removeSetupPlan(db, id));
      if (result.ok) logEvent("installments.plan_removed", { milestoneId: id });
      return respond(result);
    } catch (error) {
      return serverError("installments.remove_failed", error);
    }
  },
});
