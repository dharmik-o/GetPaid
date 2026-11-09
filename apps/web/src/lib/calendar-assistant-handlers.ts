import { z } from "zod";
import { applyProposal, askCalendar, UNAVAILABLE, type AssistantDeps } from "./calendar-assistant";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, readJson, serverError } from "./http";
import { logEvent } from "./log";

// Server-only: POST /api/calendar/assistant (ask) and POST /api/calendar/assistant/apply (apply one
// proposal). Both act as the signed-in user. The question, the history and the answer are never
// logged: only that a question was asked, how many proposals came back, and which kind was applied.

const askSchema = z.strictObject({
  question: z
    .string({ error: "is required" })
    .trim()
    .min(1, "is required")
    .max(500, "must be 500 characters or fewer"),
  history: z
    .array(
      z.strictObject({
        q: z.string().max(1000, "must be 1,000 characters or fewer"),
        a: z.string().max(1000, "must be 1,000 characters or fewer"),
      }),
    )
    .max(3, "can hold at most 3 earlier exchanges")
    .default([]),
});

const applySchema = z.strictObject({ proposal: z.unknown() });

export const calendarAssistantHandlers = (deps: AssistantDeps) => ({
  ask: async (request: Request): Promise<Response> => {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const parsed = askSchema.safeParse(body.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    try {
      const result = await askCalendar(deps, parsed.data);
      logEvent("calendar_assistant.asked", {
        ok: result.ok,
        proposals: result.ok ? result.proposals.length : 0,
      });
      return result.ok ? jsonResponse(result) : jsonResponse({ error: UNAVAILABLE }, 503);
    } catch (error) {
      return serverError("calendar_assistant.failed", error);
    }
  },

  apply: async (request: Request): Promise<Response> => {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const parsed = applySchema.safeParse(body.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    try {
      const result = await deps.runAsUser((db) =>
        applyProposal(db, parsed.data.proposal, deps.now()),
      );
      if (!result.ok) {
        return result.status === 404
          ? jsonResponse({ error: result.errors[0]?.message ?? "Not found." }, 404)
          : fieldErrors(result.errors);
      }
      const op =
        typeof parsed.data.proposal === "object" &&
        parsed.data.proposal !== null &&
        "op" in parsed.data.proposal
          ? String(parsed.data.proposal.op).slice(0, 20)
          : "unknown";
      logEvent("calendar_assistant.applied", { op });
      return jsonResponse({ entry: result.entry });
    } catch (error) {
      return serverError("calendar_assistant.apply_failed", error);
    }
  },
});
