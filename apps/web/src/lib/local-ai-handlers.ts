import { z } from "zod";
import { isDemoMode } from "./demo-gate";
import { toFieldIssues } from "./field-issues";
import { fieldErrors, jsonResponse, readJson, serverError } from "./http";
import { MODEL_NAME, type createPuller } from "./local-ai";

// Server-only: /api/settings/ai/local-models/pull. POST starts a model download on the local
// runner, GET reports its progress. Signed-in users only, never in demo mode (decision E3).

type Deps = {
  puller: ReturnType<typeof createPuller>;
  /** Throws when nobody is signed in. */
  userId: () => string;
  demoMode?: () => boolean;
};

const bodySchema = z.object({
  model: z.string().regex(MODEL_NAME, "must be a model name like llama3.2 or qwen2.5:3b"),
});

export const localAiHandlers = ({ puller, userId, demoMode = isDemoMode }: Deps) => {
  const refuse = (): Response | undefined => {
    try {
      userId();
    } catch {
      return jsonResponse({ error: "Sign in first, then try again." }, 401);
    }
    return demoMode()
      ? jsonResponse({ error: "Model downloads are switched off on the public demo." }, 403)
      : undefined;
  };

  return {
    get: (): Response => {
      try {
        userId();
      } catch {
        return jsonResponse({ error: "Sign in first, then try again." }, 401);
      }
      return jsonResponse({ job: puller.current() ?? null });
    },

    pull: async (request: Request): Promise<Response> => {
      const refusal = refuse();
      if (refusal) return refusal;
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const parsed = bodySchema.safeParse(read.body);
      if (!parsed.success) return fieldErrors(toFieldIssues(parsed.error, { noun: "field" }));
      try {
        const result = await puller.start(parsed.data.model);
        if (result.ok) return jsonResponse({ job: result.job }, 202);
        if (result.reason === "busy") {
          return jsonResponse(
            { error: "A download is already running. Wait for it to finish." },
            409,
          );
        }
        return result.reason === "rejected"
          ? jsonResponse(
              { error: "Ollama refused that download. Check the model name and try again." },
              502,
            )
          : jsonResponse(
              { error: "Local AI is off. Run `npm run local-ai:on`, then try again." },
              503,
            );
      } catch (error) {
        return serverError("local_ai.pull_failed", error);
      }
    },
  };
};
