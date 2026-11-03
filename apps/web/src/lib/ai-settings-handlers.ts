import { getAiSettings, saveAiSettings } from "./ai-settings";
import type { SecretBox } from "./crypto";
import type { UserDbRunner } from "./db";
import { fieldErrors, jsonResponse, readJson, serverError } from "./http";
import { logEvent } from "./log";

// Server-only: GET and PUT /api/settings/ai. The database runner and the secret box are
// injected so tests can use an in-memory database and a throwaway key.

type Deps = { runAsUser: UserDbRunner; box: () => SecretBox };

export const aiSettingsHandlers = ({ runAsUser, box }: Deps) => ({
  get: async (): Promise<Response> => {
    try {
      return jsonResponse({ settings: await runAsUser((db) => getAiSettings(db)) });
    } catch (error) {
      return serverError("ai_settings.read_failed", error);
    }
  },

  save: async (request: Request): Promise<Response> => {
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
});
