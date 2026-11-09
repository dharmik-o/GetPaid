import type { SecretBox } from "./crypto";
import { isUuid, type UserDbRunner } from "./db";
import { draftFinalDemand, type DemandContext } from "./final-demand";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";

// Server-only: POST /api/invoices/[id]/final-demand. Makes the letter and leaves it in the Outbox as a
// draft that waits for approval; it can't send. Runs as the signed-in user (RLS), so another user's
// invoice is simply not found.

type Deps = { runAsUser: UserDbRunner; box: () => SecretBox; context: () => DemandContext };

export const finalDemandHandlers = (deps: Deps) => ({
  post: async (
    request: Request,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("Invoice");
    const read = await readJson(request);
    if (!read.ok) return read.response;
    try {
      const result = await draftFinalDemand(deps, id, read.body);
      if (result.ok)
        return jsonResponse({ reminderId: result.reminderId, draft: result.draft }, 201);
      if ("errors" in result) return fieldErrors(result.errors);
      if ("conflict" in result) return jsonResponse({ error: result.conflict }, 409);
      return notFound("Invoice");
    } catch (error) {
      return serverError("final_demand.failed", error);
    }
  },
});
