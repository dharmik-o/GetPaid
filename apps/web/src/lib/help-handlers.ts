import { z } from "zod";
import { toFieldIssues } from "./field-issues";
import { askHelp, type HelpDeps } from "./help-assistant";
import { MAX_QUESTION_CHARS } from "./help-limits";
import { fieldErrors, jsonResponse, readJson, serverError } from "./http";
import { logEvent } from "./log";

// Server-only: POST /api/help, as the signed-in user. The question and the answer are never logged:
// only that a question was asked and whether it worked.

export const helpQuestionSchema = z.strictObject({
  question: z
    .string({ error: "is required" })
    .trim()
    .min(1, "is required")
    .max(MAX_QUESTION_CHARS, `must be ${String(MAX_QUESTION_CHARS)} characters or fewer`),
});

export const helpHandlers = (deps: HelpDeps) => ({
  ask: async (request: Request): Promise<Response> => {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const parsed = helpQuestionSchema.safeParse(body.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    try {
      const result = await askHelp(deps, parsed.data.question);
      logEvent("help.asked", { ok: result.ok });
      if (result.ok) return jsonResponse(result);
      return jsonResponse({ error: result.error }, result.reason === "no_model" ? 409 : 502);
    } catch (error) {
      return serverError("help.failed", error);
    }
  },
});
