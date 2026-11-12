"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import {
  AiConnectionFields,
  draftFromPreset,
  type ConnectionDraft,
} from "@/components/AiConnectionFields";
import type { AiPresetId } from "@/lib/ai-presets";

// Bring your own AI: the main model, an optional cloud fallback behind a local model, and
// optional per-task models. Order of use: local, then cloud (only if added here), then a
// fixed template.

export type SavedConnection = {
  provider: AiPresetId;
  baseUrl: string;
  model: string;
  isLocal: boolean;
  hasKey: boolean;
};

export type SavedAiSettings = {
  main: SavedConnection | null;
  cloudFallback: SavedConnection | null;
  taskModels: {
    sort: string | null;
    tier3: string | null;
    calendar: string | null;
    help: string | null;
  };
};

type FieldIssue = { field: string; message: string };

const fromSaved = (saved: SavedConnection): ConnectionDraft => ({ ...saved, apiKey: undefined });

const toBody = (draft: ConnectionDraft) => ({
  provider: draft.provider,
  baseUrl: draft.baseUrl.trim(),
  model: draft.model.trim(),
  ...(draft.provider === "custom" ? { isLocal: draft.isLocal } : {}),
  ...(draft.apiKey === undefined ? {} : { apiKey: draft.apiKey }),
});

type Props = {
  initial: SavedAiSettings;
  localAiUrl?: string;
  localModels?: readonly string[];
  /** With no saved model, the form starts on this provider and model (the server's built-in). */
  start?: { provider: AiPresetId; model: string };
};

export const AiSettingsForm = ({ initial, localAiUrl, localModels, start }: Props) => {
  const router = useRouter();
  const [main, setMain] = useState<ConnectionDraft>(
    initial.main
      ? fromSaved(initial.main)
      : start
        ? { ...draftFromPreset(start.provider, localAiUrl), model: start.model }
        : draftFromPreset("ollama", localAiUrl),
  );
  const [useFallback, setUseFallback] = useState(initial.cloudFallback !== null);
  const [fallback, setFallback] = useState<ConnectionDraft>(
    initial.cloudFallback ? fromSaved(initial.cloudFallback) : draftFromPreset("claude"),
  );
  const [sortModel, setSortModel] = useState(initial.taskModels.sort ?? "");
  const [tier3Model, setTier3Model] = useState(initial.taskModels.tier3 ?? "");
  const [calendarModel, setCalendarModel] = useState(initial.taskModels.calendar ?? "");
  const [helpModel, setHelpModel] = useState(initial.taskModels.help ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const [saving, setSaving] = useState(false);

  const fallbackAllowed = main.isLocal;

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setMessage(undefined);
    setErrors({});
    const body = {
      main: toBody(main),
      cloudFallback: fallbackAllowed && useFallback ? toBody(fallback) : null,
      taskModels: {
        sort: sortModel.trim() || null,
        tier3: tier3Model.trim() || null,
        calendar: calendarModel.trim() || null,
        help: helpModel.trim() || null,
      },
    };
    try {
      const response = await fetch("/api/settings/ai", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as { error?: string; errors?: FieldIssue[] };
      if (!response.ok) {
        setErrors(Object.fromEntries((result.errors ?? []).map((e) => [e.field, e.message])));
        setMessage({ text: result.error ?? "Saving failed. Try again.", error: true });
        return;
      }
      setMessage({
        text: "AI settings saved. Run the connection test to check them.",
        error: false,
      });
      router.refresh();
    } catch {
      setMessage({
        text: "That didn't reach the server. Check your connection and try again.",
        error: true,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form-wide" onSubmit={(event) => void submit(event)} noValidate>
      <AiConnectionFields
        legend="Main model"
        idPrefix="main"
        value={main}
        errors={errors}
        onChange={setMain}
        localAiUrl={localAiUrl}
        localModels={localModels}
      />

      {fallbackAllowed ? (
        <fieldset className="form">
          <legend>If your local model is down</legend>
          <label className="inline">
            <input
              type="checkbox"
              checked={useFallback}
              onChange={(e) => {
                setUseFallback(e.target.checked);
              }}
            />{" "}
            Use a cloud model as a fallback (client emails then leave your machine)
          </label>
          {useFallback ? (
            <AiConnectionFields
              legend="Cloud fallback"
              idPrefix="cloudFallback"
              value={fallback}
              errors={errors}
              onChange={setFallback}
              cloudOnly
            />
          ) : (
            <p className="field-hint">Without one, the app uses a fixed template, or waits.</p>
          )}
          {errors.cloudFallback ? (
            <span className="field-error">{errors.cloudFallback}</span>
          ) : null}
        </fieldset>
      ) : (
        <p className="field-hint">
          A cloud main model falls back to a fixed template. Pick a local model to add a cloud
          fallback.
        </p>
      )}

      <fieldset className="form">
        <legend>Per-task models (optional)</legend>
        <div className="field">
          <label htmlFor="sort-model">Sorting replies (a small or local model is enough)</label>
          <input
            id="sort-model"
            value={sortModel}
            placeholder={`Same as the main model (${main.model || "not set"})`}
            aria-invalid={Boolean(errors["taskModels.sort"])}
            onChange={(e) => {
              setSortModel(e.target.value);
            }}
          />
          {errors["taskModels.sort"] ? (
            <div className="field-error">{errors["taskModels.sort"]}</div>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="tier3-model">Tier 3 final notices (the strongest model)</label>
          <input
            id="tier3-model"
            value={tier3Model}
            placeholder={`Same as the main model (${main.model || "not set"})`}
            aria-invalid={Boolean(errors["taskModels.tier3"])}
            onChange={(e) => {
              setTier3Model(e.target.value);
            }}
          />
          {errors["taskModels.tier3"] ? (
            <div className="field-error">{errors["taskModels.tier3"]}</div>
          ) : null}
          <div className="field-hint">Same provider and key as the main model.</div>
        </div>
        <div className="field">
          <label htmlFor="calendar-model">Calendar assistant</label>
          <input
            id="calendar-model"
            value={calendarModel}
            placeholder={`Same as the main model (${main.model || "not set"})`}
            aria-invalid={Boolean(errors["taskModels.calendar"])}
            onChange={(e) => {
              setCalendarModel(e.target.value);
            }}
          />
          {errors["taskModels.calendar"] ? (
            <div className="field-error">{errors["taskModels.calendar"]}</div>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="help-model">Help assistant (Ask GetPaid)</label>
          <input
            id="help-model"
            value={helpModel}
            placeholder={`Same as the main model (${main.model || "not set"})`}
            aria-invalid={Boolean(errors["taskModels.help"])}
            onChange={(e) => {
              setHelpModel(e.target.value);
            }}
          />
          {errors["taskModels.help"] ? (
            <div className="field-error">{errors["taskModels.help"]}</div>
          ) : null}
        </div>
      </fieldset>

      <button type="submit" className="button" disabled={saving}>
        {saving ? "Saving…" : "Save AI settings"}
      </button>
      {message ? (
        <div className={message.error ? "banner banner-error" : "banner"} role="status">
          {message.text}
        </div>
      ) : null}
    </form>
  );
};
