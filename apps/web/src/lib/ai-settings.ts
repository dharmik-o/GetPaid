import { z } from "zod";
import { AI_PRESET_IDS, presetById, type AiPresetId } from "./ai-presets";
import { baseUrlProblem, sameServer } from "./ai-url";
import type { SecretBox } from "./crypto";
import type { Db } from "./db";
import { toFieldIssues, type FieldIssue } from "./field-issues";

// Server-only: the user's AI settings in ai_providers. One main model (order 1) and, behind a
// local main model only, an optional cloud fallback (order 2), each saved for every task, with
// optional per-task model names. API keys are encrypted at rest, bound to the user and the
// connection, never logged and never sent back to the browser (`hasKey` only).

export const AI_TASKS = ["sort", "draft", "tier3"] as const;
export type AiTask = (typeof AI_TASKS)[number];

const MODEL_ID = /^[\w.:/@+-]{1,200}$/;

const modelSchema = z
  .string({ error: "is required" })
  .trim()
  .regex(
    MODEL_ID,
    "must be a model id such as claude-sonnet-5-5 or llama3.2 (letters, digits and . : / @ + - only)",
  );

const connectionSchema = z.strictObject({
  provider: z.enum(AI_PRESET_IDS, { error: "must be one of the listed providers" }),
  baseUrl: z.string({ error: "is required" }).trim().min(1, "is required").max(500, "is too long"),
  model: modelSchema,
  /** Custom URL only: whether it runs on the user's machine or network. */
  isLocal: z.boolean().optional(),
  /** Omitted: keep the stored key (same server only). "": remove it. */
  apiKey: z.string().trim().max(1000, "is too long").optional(),
});

const settingsSchema = z.strictObject({
  main: connectionSchema,
  cloudFallback: connectionSchema.nullable(),
  taskModels: z
    .strictObject({
      sort: modelSchema.nullable().optional(),
      tier3: modelSchema.nullable().optional(),
    })
    .optional(),
});

type ConnectionInput = z.infer<typeof connectionSchema>;

/** What the browser sees: never the key, only whether one is stored. */
export type ConnectionView = {
  provider: AiPresetId;
  baseUrl: string;
  model: string;
  isLocal: boolean;
  hasKey: boolean;
};

export type AiSettingsView = {
  main: ConnectionView | null;
  cloudFallback: ConnectionView | null;
  taskModels: { sort: string | null; tier3: string | null };
};

type Row = {
  user_id: string;
  task: AiTask;
  fallback_order: number;
  provider: string;
  base_url: string;
  model: string;
  is_local: boolean;
  api_key_enc: string | null;
};

const SELECT_ROWS = `
  SELECT user_id::text, task, fallback_order, provider, base_url, model, is_local, api_key_enc
  FROM public.ai_providers`;

const readRows = async (db: Db): Promise<Row[]> =>
  (await db.query<Row>(`${SELECT_ROWS} ORDER BY fallback_order, task`)).rows;

const keyContext = (userId: string, order: number): string =>
  `ai_providers.api_key_enc:${userId}:${String(order)}`;

/** The connection as saved for one order: the draft task's row carries the shared model. */
const connectionRow = (rows: Row[], order: number): Row | undefined =>
  rows.find((row) => row.fallback_order === order && row.task === "draft") ??
  rows.find((row) => row.fallback_order === order);

const toView = (row: Row): ConnectionView => ({
  provider: presetById(row.provider) ? (row.provider as AiPresetId) : "custom",
  baseUrl: row.base_url,
  model: row.model,
  isLocal: row.is_local,
  hasKey: row.api_key_enc !== null,
});

const viewOf = (rows: Row[]): AiSettingsView => {
  const main = connectionRow(rows, 1);
  const taskModel = (task: AiTask): string | null => {
    const row = rows.find((r) => r.fallback_order === 1 && r.task === task);
    return row && main && row.model !== main.model ? row.model : null;
  };
  const fallback = connectionRow(rows, 2);
  return {
    main: main ? toView(main) : null,
    cloudFallback: fallback ? toView(fallback) : null,
    taskModels: { sort: taskModel("sort"), tier3: taskModel("tier3") },
  };
};

export const getAiSettings = async (db: Db): Promise<AiSettingsView> => viewOf(await readRows(db));

type Resolved = {
  provider: AiPresetId;
  baseUrl: string;
  model: string;
  isLocal: boolean;
  /** Ciphertext to store, or null. */
  keyEnc: string | null;
};

const resolveConnection = (
  input: ConnectionInput,
  stored: Row | undefined,
  context: { userId: string; order: number; field: string; box: SecretBox },
): { resolved?: Resolved; errors: FieldIssue[] } => {
  const preset = presetById(input.provider);
  const isLocal = preset?.local ?? input.isLocal ?? false;
  const errors: FieldIssue[] = [];
  const urlProblem = baseUrlProblem(input.baseUrl, isLocal);
  if (urlProblem) errors.push({ field: `${context.field}.baseUrl`, message: urlProblem });

  const kept =
    input.apiKey === undefined && stored?.api_key_enc && sameServer(stored.base_url, input.baseUrl)
      ? stored.api_key_enc
      : null;
  const keyEnc = input.apiKey
    ? context.box.encrypt(input.apiKey, keyContext(context.userId, context.order))
    : kept;
  if (preset?.needsKey && keyEnc === null) {
    errors.push({
      field: `${context.field}.apiKey`,
      message: `is required for ${preset.label}. Paste the key from your ${preset.label} account (it's encrypted and never shown again).`,
    });
  }
  if (errors.length > 0) return { errors };
  return {
    resolved: {
      provider: input.provider,
      baseUrl: input.baseUrl,
      model: input.model,
      isLocal,
      keyEnc,
    },
    errors,
  };
};

export type SaveResult =
  { ok: true; settings: AiSettingsView } | { ok: false; errors: FieldIssue[] };

const insertRow = async (
  db: Db,
  task: AiTask,
  order: number,
  connection: Resolved,
  model: string,
): Promise<void> => {
  await db.query(
    `INSERT INTO public.ai_providers
       (user_id, task, fallback_order, provider, base_url, model, is_local, api_key_enc)
     VALUES ((SELECT auth.uid()), $1, $2, $3, $4, $5, $6, $7)`,
    [
      task,
      order,
      connection.provider,
      connection.baseUrl,
      model,
      connection.isLocal,
      connection.keyEnc,
    ],
  );
};

/** Checks and saves the settings, replacing what was there. Keys are encrypted here. */
export const saveAiSettings = async (db: Db, raw: unknown, box: SecretBox): Promise<SaveResult> => {
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
  }
  const input = parsed.data;
  const { rows: who } = await db.query<{ id: string }>("SELECT auth.uid()::text AS id");
  const userId = who[0]?.id;
  if (!userId) throw new Error("No signed-in user for the AI settings. Sign in again.");
  const stored = await readRows(db);

  const main = resolveConnection(input.main, connectionRow(stored, 1), {
    userId,
    order: 1,
    field: "main",
    box,
  });
  const fallback = input.cloudFallback
    ? resolveConnection(input.cloudFallback, connectionRow(stored, 2), {
        userId,
        order: 2,
        field: "cloudFallback",
        box,
      })
    : undefined;
  const errors = [...main.errors, ...(fallback?.errors ?? [])];
  if (fallback?.resolved?.isLocal) {
    errors.push({
      field: "cloudFallback",
      message: "must be a cloud model; local models are always tried first",
    });
  } else if (fallback && main.resolved && !main.resolved.isLocal) {
    errors.push({
      field: "cloudFallback",
      message:
        "is only for when your main model is local. With a cloud main model, the fallback is the fixed template.",
    });
  }
  if (errors.length > 0 || !main.resolved) return { ok: false, errors };

  await db.query("DELETE FROM public.ai_providers");
  for (const task of AI_TASKS) {
    const own = task === "draft" ? undefined : input.taskModels?.[task];
    await insertRow(db, task, 1, main.resolved, own ?? main.resolved.model);
    if (fallback?.resolved)
      await insertRow(db, task, 2, fallback.resolved, fallback.resolved.model);
  }
  return { ok: true, settings: await getAiSettings(db) };
};

/** A model the router may call, with its key decrypted. Server-only; never log or return it. */
export type AiConnection = {
  order: number;
  provider: string;
  baseUrl: string;
  model: string;
  isLocal: boolean;
  apiKey: string | null;
};

/** The user's models for one task, in the order saved (main first). */
export const loadAiConnections = async (
  db: Db,
  task: AiTask,
  box: SecretBox,
): Promise<AiConnection[]> => {
  const { rows } = await db.query<Row>(`${SELECT_ROWS} WHERE task = $1 ORDER BY fallback_order`, [
    task,
  ]);
  return rows.map((row) => ({
    order: row.fallback_order,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    isLocal: row.is_local,
    apiKey: row.api_key_enc
      ? box.decrypt(row.api_key_enc, keyContext(row.user_id, row.fallback_order))
      : null,
  }));
};
