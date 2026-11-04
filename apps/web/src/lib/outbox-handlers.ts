import { z } from "zod";
import { draftSchema } from "./ai-schemas";
import { isUuid, type UserDbRunner } from "./db";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, notFound, readJson, serverError } from "./http";
import type { Law } from "./legal";
import { logEvent } from "./log";
import { outboxCounts } from "./outbox";
import {
  approveDraft,
  editDraft,
  rescheduleDraft,
  skipDraft,
  type ActionResult,
} from "./outbox-actions";

// Server-only: POST /api/outbox/[id] (approve, edit, skip, reschedule a draft) and GET
// /api/outbox/summary (the sidebar badge). Everything runs as the signed-in user. Approving only
// records the decision; the sender (M7) is what sends, and only approved drafts.

type Deps = { runAsUser: UserDbRunner; now: () => Date; laws: readonly Law[] };
type IdContext = { params: Promise<{ id: string }> };

const DRAFT = "Draft";

const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("approve") }),
  z.strictObject({ action: z.literal("skip") }),
  z.strictObject({ action: z.literal("edit"), ...draftSchema.shape }),
  z.strictObject({
    action: z.literal("reschedule"),
    at: z
      .string({ error: "is required" })
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, { error: "must be a date and time" }),
  }),
]);

type Action = z.infer<typeof actionSchema>;

const toResponse = (result: ActionResult): Response => {
  switch (result.status) {
    case "ok":
      return jsonResponse({ ok: true });
    case "not_found":
      return notFound(DRAFT);
    case "conflict":
      return jsonResponse({ error: result.message }, 409);
    case "invalid":
      return jsonResponse({ error: result.message }, 400);
  }
};

export const outboxHandlers = ({ runAsUser, now, laws }: Deps) => {
  const run = (id: string, action: Action): Promise<ActionResult> =>
    runAsUser((db) => {
      switch (action.action) {
        case "approve":
          return approveDraft(db, id);
        case "skip":
          return skipDraft(db, id);
        case "edit":
          return editDraft(db, id, action, { now: now(), laws });
        case "reschedule":
          return rescheduleDraft(db, id, action.at, now());
      }
    });

  return {
    post: async (request: Request, { params }: IdContext): Promise<Response> => {
      const { id } = await params;
      if (!isUuid(id)) return notFound(DRAFT);
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const parsed = actionSchema.safeParse(read.body);
      if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error));
      try {
        const result = await run(id, parsed.data);
        logEvent("outbox.action", {
          reminderId: id,
          action: parsed.data.action,
          status: result.status,
        });
        return toResponse(result);
      } catch (error) {
        return serverError("outbox.action_failed", error);
      }
    },

    summary: async (): Promise<Response> => {
      try {
        const counts = await runAsUser((db) => outboxCounts(db));
        return jsonResponse({ waiting: counts.waiting });
      } catch (error) {
        return serverError("outbox.summary_failed", error);
      }
    },
  };
};
