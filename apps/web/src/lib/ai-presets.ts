// Bring your own AI: the provider presets from the spec. Every one is reached with the same
// OpenAI-compatible chat call, so only the base URL, key and model change.
// Pure: safe in client components; holds no secrets.

export type AiPreset = {
  id: string;
  label: string;
  /** Filled in when the preset is picked; Custom URL starts blank. */
  baseUrl: string;
  /** null = the user says (Custom URL). */
  local: boolean | null;
  needsKey: boolean;
  /** A model to start with, or "" to make the user type one. */
  model: string;
  modelHint: string;
};

export const AI_PRESETS = [
  {
    id: "claude",
    label: "Claude (Anthropic)",
    baseUrl: "https://api.anthropic.com/v1",
    local: false,
    needsKey: true,
    model: "claude-sonnet-5-5",
    modelHint: "A Claude model id, for example claude-sonnet-5-5 or claude-haiku-5-5.",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    local: false,
    needsKey: true,
    model: "",
    modelHint: "The model id from your OpenAI account.",
  },
  {
    id: "gemini",
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    local: false,
    needsKey: true,
    model: "",
    modelHint: "The Gemini model id from Google AI Studio.",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    local: false,
    needsKey: true,
    model: "",
    modelHint: "The model id from your Groq console.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    local: false,
    needsKey: true,
    model: "",
    modelHint: "An OpenRouter model id, written provider/model.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    local: true,
    needsKey: false,
    model: "",
    modelHint: "A model you've pulled, as `ollama list` shows it, for example llama3.2.",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    local: true,
    needsKey: false,
    model: "",
    modelHint: "The model id LM Studio shows for the loaded model.",
  },
  {
    id: "custom",
    label: "Custom URL",
    baseUrl: "",
    local: null,
    needsKey: false,
    model: "",
    modelHint:
      "Any OpenAI-compatible endpoint, such as the local LiteLLM gateway (http://127.0.0.1:4000/v1) or vLLM.",
  },
] as const satisfies readonly AiPreset[];

export type AiPresetId = (typeof AI_PRESETS)[number]["id"];

export const AI_PRESET_IDS = AI_PRESETS.map((preset) => preset.id) as [AiPresetId, ...AiPresetId[]];

export const presetById = (id: string): AiPreset | undefined =>
  AI_PRESETS.find((preset) => preset.id === id);
