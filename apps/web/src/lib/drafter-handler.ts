import { z } from "zod";
import { draftReminder, type DrafterDeps, type DraftOutcome } from "./drafter";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, readJson, serverError } from "./http";
import { refuseUnlessInternal } from "./internal-auth";

// Server-only: POST /api/internal/drafts, which n8n's 02_drafter calls with a reminder id.
// n8n proves itself with INTERNAL_API_TOKEN; the work then runs as that user (RLS). The answer
// carries the draft's subject and body for the next n8n step, never to a log.

const bodySchema = z.strictObject({
  userId: z.uuid({ error: "must be a user id" }),
  reminderId: z.uuid({ error: "must be a reminder id" }),
});

const STATUS: Readonly<Record<DraftOutcome["status"], number>> = {
  drafted: 201,
  exists: 200,
  not_found: 404,
  handled: 409,
  not_payable: 409,
  unsupported: 409,
};

const MESSAGE: Readonly<Record<DraftOutcome["status"], string>> = {
  drafted: "Drafted. It waits for approval in the Outbox.",
  exists: "This reminder already has a draft; nothing changed.",
  not_found: "Reminder not found for this user. Check the reminder id and the user id.",
  handled: "This reminder was already approved or skipped; it isn't drafted again.",
  not_payable: "This reminder's invoice can't be paid now, so no draft was written.",
  unsupported: "This kind of reminder isn't drafted yet.",
};

export const draftsHandler = (deps: DrafterDeps & { token: () => string | undefined }) => ({
  post: async (request: Request): Promise<Response> => {
    const refused = refuseUnlessInternal(request, deps.token(), "drafter.rejected");
    if (refused) return refused;
    const json = await readJson(request);
    if (!json.ok) return json.response;
    const parsed = bodySchema.safeParse(json.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    try {
      const outcome = await draftReminder(deps, parsed.data);
      return jsonResponse({ ...outcome, message: MESSAGE[outcome.status] }, STATUS[outcome.status]);
    } catch (error) {
      return serverError("drafter.failed", error);
    }
  },
});
