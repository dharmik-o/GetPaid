import { presetById, type AiPresetId } from "./ai-presets";
import type { AiConnection } from "./ai-settings";

// Server-only: the built-in AI model, set by whoever runs the server in its env file
// (AI_DEFAULT_PROVIDER, AI_DEFAULT_MODEL, AI_DEFAULT_API_KEY and, for a custom server,
// AI_DEFAULT_BASE_URL). It is used for any user who hasn't saved a model of their own, so a demo
// works without anyone pasting a key. The key never reaches the browser, the database or a log:
// only the provider's name and the model id are ever shown.

export const DEFAULT_AI_ENV_NAMES = [
  "AI_DEFAULT_PROVIDER",
  "AI_DEFAULT_MODEL",
  "AI_DEFAULT_API_KEY",
  "AI_DEFAULT_BASE_URL",
] as const;

const MODEL_ID = /^[\w.:/@+-]{1,200}$/;

type BuiltIn = {
  provider: AiPresetId;
  label: string;
  baseUrl: string;
  model: string;
  isLocal: boolean;
  apiKey: string | null;
};

/** The built-in model from the env, or why it can't be used. Never includes the key. */
export const readDefaultAi = (
  source: Record<string, string | undefined> = process.env,
): { ok: true; value: BuiltIn } | { ok: false; problem: string | null } => {
  const provider = source.AI_DEFAULT_PROVIDER?.trim() ?? "";
  const model = source.AI_DEFAULT_MODEL?.trim() ?? "";
  const apiKey = source.AI_DEFAULT_API_KEY?.trim() ?? "";
  if (provider === "" && model === "" && apiKey === "") return { ok: false, problem: null };
  const preset = presetById(provider);
  if (!preset) {
    return {
      ok: false,
      problem:
        "AI_DEFAULT_PROVIDER must be one of claude, openai, gemini, groq, openrouter, ollama, lmstudio or custom.",
    };
  }
  if (!MODEL_ID.test(model)) {
    return {
      ok: false,
      problem: "AI_DEFAULT_MODEL must be a model id, such as gemini-3.5-flash-lite.",
    };
  }
  const baseUrl = (source.AI_DEFAULT_BASE_URL?.trim() || preset.baseUrl).replace(/\/+$/, "");
  if (baseUrl === "") {
    return {
      ok: false,
      problem: "AI_DEFAULT_BASE_URL is required when AI_DEFAULT_PROVIDER is custom.",
    };
  }
  if (preset.needsKey && apiKey === "") {
    return { ok: false, problem: `AI_DEFAULT_API_KEY is required for ${preset.label}.` };
  }
  return {
    ok: true,
    value: {
      provider: provider as AiPresetId,
      label: preset.label,
      baseUrl,
      model,
      isLocal: preset.local ?? false,
      apiKey: apiKey === "" ? null : apiKey,
    },
  };
};

/** What the settings page may show: never the key or the address. */
export type DefaultAiInfo = { provider: AiPresetId; label: string; model: string };

export const defaultAiInfo = (): DefaultAiInfo | null => {
  const found = readDefaultAi();
  return found.ok
    ? { provider: found.value.provider, label: found.value.label, model: found.value.model }
    : null;
};

/** The built-in model as a connection for the router, or null when the server has none. */
export const defaultAiConnection = (): AiConnection | null => {
  const found = readDefaultAi();
  if (!found.ok) return null;
  const { provider, baseUrl, model, isLocal, apiKey } = found.value;
  return { order: 1, provider, baseUrl, model, isLocal, apiKey };
};
