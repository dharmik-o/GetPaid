import { z } from "zod";
import { routeTask } from "./ai-router";
import { AI_SCHEMA_NAMES, AI_SCHEMAS } from "./ai-schemas";
import { AI_TASKS, loadAiConnections } from "./ai-settings";
import type { SecretBox } from "./crypto";
import type { UserDbRunner } from "./db";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, readJson, serverError } from "./http";
import { refuseUnlessInternal } from "./internal-auth";
import { logEvent } from "./log";

// Server-only: POST /api/internal/ai/route, which n8n's 07_ai_router calls for every AI task.
// n8n proves itself with INTERNAL_API_TOKEN. The user's models are then read as that user
// (RLS applies; no service role), keys are decrypted here, and only the checked output and a
// safe summary of attempts go back. Message text and keys are never logged.

type Deps = {
  runAsUser: (userId: string) => UserDbRunner;
  box: () => SecretBox;
  token: () => string | undefined;
};

const messageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(50_000),
});

const bodySchema = z.strictObject({
  userId: z.uuid({ error: "must be a user id" }),
  task: z.enum(AI_TASKS),
  schema: z.enum(AI_SCHEMA_NAMES),
  messages: z.array(messageSchema).min(1).max(20),
  /** The fixed template for this task; must match the schema. Omit to wait instead. */
  template: z.unknown().optional(),
});

export const aiRouteHandler = (deps: Deps) => ({
  post: async (request: Request): Promise<Response> => {
    const refused = refuseUnlessInternal(request, deps.token(), "ai_route.rejected");
    if (refused) return refused;
    const json = await readJson(request);
    if (!json.ok) return json.response;
    const parsed = bodySchema.safeParse(json.body);
    if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
    const { userId, task, schema: schemaName, messages, template } = parsed.data;
    const schema = AI_SCHEMAS[schemaName];
    const checkedTemplate = template === undefined ? undefined : schema.safeParse(template);
    if (checkedTemplate && !checkedTemplate.success) {
      return fieldErrors([
        { field: "template", message: `doesn't match the ${schemaName} schema` },
      ]);
    }
    try {
      const connections = await deps.runAsUser(userId)((db) =>
        loadAiConnections(db, task, deps.box()),
      );
      const result = await routeTask(connections, {
        messages,
        schema: schema as z.ZodType,
        ...(checkedTemplate ? { template: checkedTemplate.data } : {}),
      });
      logEvent("ai_route.done", {
        task,
        ok: result.ok,
        via: result.ok ? result.via : result.reason,
        attempts: result.attempts.length,
      });
      return jsonResponse(result);
    } catch (error) {
      return serverError("ai_route.failed", error);
    }
  },
});
