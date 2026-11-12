"use client";

import type { ReactNode } from "react";
import { AI_PRESETS, presetById, type AiPresetId } from "@/lib/ai-presets";

// One model connection: provider preset, base URL, API key and model. The key is write-only:
// a saved key is never shown, only that one is saved.

export type ConnectionDraft = {
  provider: AiPresetId;
  baseUrl: string;
  model: string;
  isLocal: boolean;
  /** undefined = keep the saved key; "" = remove it; text = a new key. */
  apiKey: string | undefined;
  hasKey: boolean;
};

type Props = {
  legend: string;
  idPrefix: string;
  value: ConnectionDraft;
  errors: Record<string, string>;
  onChange: (next: ConnectionDraft) => void;
  /** Limit the presets, e.g. cloud only for the fallback. */
  cloudOnly?: boolean;
  /** The local runner's address (LOCAL_AI_URL), which the Ollama preset points at. */
  localAiUrl?: string;
  /** Models already downloaded to the local runner, offered in the model field. */
  localModels?: readonly string[];
};

export const draftFromPreset = (id: AiPresetId, localAiUrl?: string): ConnectionDraft => {
  const preset = presetById(id);
  return {
    provider: id,
    baseUrl: id === "ollama" && localAiUrl ? `${localAiUrl}/v1` : (preset?.baseUrl ?? ""),
    model: preset?.model ?? "",
    isLocal: preset?.local ?? false,
    apiKey: undefined,
    hasKey: false,
  };
};

type FieldProps = {
  id: string;
  label: string;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
};

const Field = ({ id, label, error, hint, children }: FieldProps) => (
  <div className="field">
    <label htmlFor={id}>{label}</label>
    {children}
    {hint ? <div className="field-hint">{hint}</div> : null}
    {error ? (
      <div className="field-error" id={`${id}-error`}>
        {error}
      </div>
    ) : null}
  </div>
);

export const AiConnectionFields = ({
  legend,
  idPrefix,
  value,
  errors,
  onChange,
  cloudOnly,
  localAiUrl,
  localModels = [],
}: Props) => {
  const preset = presetById(value.provider);
  const presets = cloudOnly ? AI_PRESETS.filter((p) => p.local !== true) : AI_PRESETS;
  const id = (name: string) => `${idPrefix}-${name}`;
  const error = (name: string) => errors[`${idPrefix}.${name}`];
  const suggestions = [
    ...new Set([...(preset?.models ?? []), ...(value.provider === "ollama" ? localModels : [])]),
  ];

  const pickPreset = (next: AiPresetId) => {
    const draft = draftFromPreset(next, localAiUrl);
    // Keep a typed model when moving between presets that don't suggest one.
    onChange({ ...draft, model: draft.model || value.model });
  };

  const keyPlaceholder =
    value.hasKey && value.apiKey === undefined
      ? "Saved and hidden. Leave blank to keep it."
      : preset?.local
        ? "Not needed for a local model"
        : "";

  return (
    <fieldset className="form">
      <legend>{legend}</legend>
      <Field id={id("provider")} label="Provider" error={error("provider")}>
        <select
          id={id("provider")}
          value={value.provider}
          onChange={(e) => {
            pickPreset(e.target.value as AiPresetId);
          }}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>

      <Field id={id("baseUrl")} label="Base URL" error={error("baseUrl")}>
        <input
          id={id("baseUrl")}
          value={value.baseUrl}
          placeholder="https://api.example.com/v1"
          aria-invalid={Boolean(error("baseUrl"))}
          onChange={(e) => {
            onChange({ ...value, baseUrl: e.target.value });
          }}
        />
      </Field>

      {value.provider === "custom" && !cloudOnly ? (
        <label className="inline">
          <input
            type="checkbox"
            checked={value.isLocal}
            onChange={(e) => {
              onChange({ ...value, isLocal: e.target.checked });
            }}
          />{" "}
          Runs on my machine or network (local)
        </label>
      ) : null}

      <Field
        id={id("apiKey")}
        label={preset?.needsKey ? "API key" : "API key (optional)"}
        error={error("apiKey")}
        hint="Encrypted when saved and never shown again. Pointing the base URL at another server means entering the key again."
      >
        <input
          id={id("apiKey")}
          type="password"
          autoComplete="off"
          value={value.apiKey ?? ""}
          placeholder={keyPlaceholder}
          aria-invalid={Boolean(error("apiKey"))}
          onChange={(e) => {
            onChange({ ...value, apiKey: e.target.value === "" ? undefined : e.target.value });
          }}
        />
      </Field>
      {value.hasKey ? (
        <button
          type="button"
          className="link-button"
          onClick={() => {
            onChange({ ...value, apiKey: "", hasKey: false });
          }}
        >
          Remove the saved key
        </button>
      ) : null}

      <Field id={id("model")} label="Model" error={error("model")} hint={preset?.modelHint}>
        {suggestions.length > 0 ? (
          <select
            className="model-pick"
            aria-label="Pick a suggested model"
            value={suggestions.includes(value.model) ? value.model : ""}
            onChange={(e) => {
              if (e.target.value !== "") onChange({ ...value, model: e.target.value });
            }}
          >
            <option value="">Pick a suggested model, or type your own below</option>
            {suggestions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
        <input
          id={id("model")}
          value={value.model}
          placeholder="Type a model id"
          list={value.provider === "ollama" ? id("models") : undefined}
          aria-invalid={Boolean(error("model"))}
          onChange={(e) => {
            onChange({ ...value, model: e.target.value });
          }}
        />
        <datalist id={id("models")}>
          {localModels.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Field>
    </fieldset>
  );
};
