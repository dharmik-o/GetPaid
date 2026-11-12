import { clearAiSettings, getAiSettings, saveAiSettings } from "./ai-settings";
import type { SecretBox } from "./crypto";
import type { UserDbRunner } from "./db";
import { isDemoMode } from "./demo-gate";
import { fieldErrors, jsonResponse, readJson, serverError } from "./http";
import { logEvent } from "./log";

// Server-only: GET, PUT and DELETE /api/settings/ai. The database runner and the secret box are
// injected so tests can use an in-memory database and a throwaway key. On the public demo every
// visitor shares one account, so its AI settings can't be changed: a key one visitor saved would
// be used for everyone after them.

type Deps = { runAsUser: UserDbRunner; box: () => SecretBox; demoMode?: () => boolean };

export const DEMO_AI_LOCKED =
  "The demo uses its built-in AI model, so its AI settings can't be changed. To use your own provider and key, run your own copy of GetPaid.";

export const aiSettingsHandlers = ({ runAsUser, box, demoMode = isDemoMode }: Deps) => ({
  get: async (): Promise<Response> => {
    try {
      return jsonResponse({ settings: await runAsUser((db) => getAiSettings(db)) });
    } catch (error) {
      return serverError("ai_settings.read_failed", error);
    }
  },

  save: async (request: Request): Promise<Response> => {
    if (demoMode()) return jsonResponse({ error: DEMO_AI_LOCKED }, 403);
    const body = await readJson(request);
    if (!body.ok) return body.response;
    try {
      const result = await runAsUser((db) => saveAiSettings(db, body.body, box()));
      if (!result.ok) return fieldErrors(result.errors);
      logEvent("ai_settings.saved", {
        provider: result.settings.main?.provider ?? null,
        cloudFallback: result.settings.cloudFallback !== null,
      });
      return jsonResponse({ settings: result.settings });
    } catch (error) {
      return serverError("ai_settings.save_failed", error);
    }
  },

  /** Back to the built-in model: deletes the user's own models and keys. */
  clear: async (): Promise<Response> => {
    if (demoMode()) return jsonResponse({ error: DEMO_AI_LOCKED }, 403);
    try {
      await runAsUser((db) => clearAiSettings(db));
      logEvent("ai_settings.cleared", {});
      return jsonResponse({ ok: true });
    } catch (error) {
      return serverError("ai_settings.clear_failed", error);
    }
  },
});
