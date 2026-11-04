import { LIVE_HOLD_SQL } from "./milestone-holds";
import { z } from "zod";
import { countryName, defaultTimeZone, isCountryCode, isValidTimeZone } from "./countries";
import type { Db } from "./db";
import { toCents, toIso } from "./db-values";
import { nestIssues, toFieldIssues, type FieldIssue } from "./field-issues";
import { settingsOverrideSchema, type SettingsOverride } from "./settings";
import { validateSettings } from "./settings-validation";

// Server-only: client records. Every query runs as the signed-in user (RLS), so a client
// that belongs to someone else simply isn't found.

export type Money = { currency: string; cents: number };

export type Client = {
  id: string;
  name: string;
  email: string;
  country: string;
  countryName: string;
  timeZone: string;
  settings: SettingsOverride;
  /** Money still owed on sent, partly paid or disputed invoices, per currency. */
  openBalances: Money[];
  lastActivityAt: string;
};

const fieldsSchema = z.strictObject({
  name: z
    .string({ error: "is required" })
    .trim()
    .min(1, "is required")
    .max(200, "must be 200 characters or fewer"),
  email: z
    .string({ error: "is required" })
    .trim()
    .max(320, "is too long")
    .pipe(z.email("must be an email address like ana@example.com")),
  country: z
    .string({ error: "must be picked from the list" })
    .refine(isCountryCode, "must be picked from the list"),
  timeZone: z
    .string({ error: "must be picked from the list" })
    .refine(isValidTimeZone, "must be a time zone from the list, like America/New_York"),
  /** Checked separately by validateSettings, so its errors are reported field by field. */
  settings: z.unknown(),
});

const createSchema = fieldsSchema.partial({ timeZone: true, settings: true });
const updateSchema = fieldsSchema.partial();

type Fields = Omit<z.infer<typeof fieldsSchema>, "settings"> & { settings: SettingsOverride };
export type ClientCreate = Fields;
export type ClientUpdate = Partial<Fields>;

type Parsed<T> = { ok: true; value: T } | { ok: false; errors: FieldIssue[] };

/** The raw `settings` value, read even when other fields are invalid, so all errors show at once. */
const rawSettings = (raw: unknown): unknown =>
  raw && typeof raw === "object" && "settings" in raw ? raw.settings : undefined;

const settingsIssues = (raw: unknown): { settings?: SettingsOverride; errors: FieldIssue[] } => {
  const value = rawSettings(raw);
  if (value === undefined) return { errors: [] };
  const result = validateSettings(value);
  if (result.ok) return { settings: result.settings, errors: [] };
  return { errors: nestIssues(result.errors, "settings") };
};

const fieldIssues = (error: z.ZodError | undefined): FieldIssue[] =>
  error ? toFieldIssues(error, { noun: "field" }) : [];

/** Checks a new client. A missing time zone comes from the country. */
export const parseClientCreate = (raw: unknown): Parsed<ClientCreate> => {
  const parsed = createSchema.safeParse(raw);
  const settings = settingsIssues(raw);
  const errors = [...fieldIssues(parsed.error), ...settings.errors];
  if (!parsed.success || errors.length > 0) return { ok: false, errors };
  const { name, email, country, timeZone } = parsed.data;
  return {
    ok: true,
    value: {
      name,
      email,
      country,
      timeZone: timeZone ?? defaultTimeZone(country),
      settings: settings.settings ?? {},
    },
  };
};

/** Checks changes. A country change without a time zone moves to the new country's default. */
export const parseClientUpdate = (raw: unknown): Parsed<ClientUpdate> => {
  const parsed = updateSchema.safeParse(raw);
  const settings = settingsIssues(raw);
  const errors = [...fieldIssues(parsed.error), ...settings.errors];
  if (!parsed.success || errors.length > 0) return { ok: false, errors };
  const { name, email, country, timeZone } = parsed.data;
  return {
    ok: true,
    value: {
      name,
      email,
      country,
      timeZone: timeZone ?? (country ? defaultTimeZone(country) : undefined),
      settings: settings.settings,
    },
  };
};

type ClientRow = {
  id: string;
  name: string;
  email: string;
  country: string;
  time_zone: string;
  settings: unknown;
  open_balances: { currency: string; cents: string }[] | null;
  last_activity_at: unknown;
};

/** Invoices reach a client through a milestone's project or through a retainer. */
const SELECT_CLIENTS = `
  WITH client_invoices AS (
    SELECT p.client_id, i.id, i.amount_cents, i.amount_paid_cents, i.currency, i.status, i.updated_at
    FROM public.invoices i
    JOIN public.milestones m ON m.id = i.milestone_id
    JOIN public.projects p ON p.id = m.project_id
    UNION ALL
    SELECT r.client_id, i.id, i.amount_cents, i.amount_paid_cents, i.currency, i.status, i.updated_at
    FROM public.invoices i
    JOIN public.retainers r ON r.id = i.retainer_id
  )
  SELECT c.id::text, c.name, c.email, c.country, c.time_zone, c.settings,
    (
      SELECT json_agg(json_build_object('currency', b.currency, 'cents', b.cents::text) ORDER BY b.currency)
      FROM (
        SELECT ci.currency, sum(ci.amount_cents - ci.amount_paid_cents) AS cents
        FROM client_invoices ci
        WHERE ci.client_id = c.id AND ci.status IN ('sent', 'partially_paid', 'disputed')
        GROUP BY ci.currency
      ) b
    ) AS open_balances,
    greatest(
      c.updated_at,
      (SELECT max(ci.updated_at) FROM client_invoices ci WHERE ci.client_id = c.id),
      (
        SELECT max(msg.created_at)
        FROM public.messages msg
        JOIN client_invoices ci ON ci.id = msg.invoice_id
        WHERE ci.client_id = c.id
      )
    ) AS last_activity_at
  FROM public.clients c`;

const toClient = (row: ClientRow): Client => ({
  id: row.id,
  name: row.name,
  email: row.email,
  country: row.country,
  countryName: isCountryCode(row.country) ? countryName(row.country) : row.country,
  timeZone: row.time_zone,
  settings: settingsOverrideSchema.parse(row.settings),
  openBalances: (row.open_balances ?? []).map((b) => ({
    currency: b.currency,
    cents: toCents(b.cents),
  })),
  lastActivityAt: toIso(row.last_activity_at),
});

export const listClients = async (db: Db): Promise<Client[]> => {
  const { rows } = await db.query<ClientRow>(`${SELECT_CLIENTS} ORDER BY lower(c.name), c.id`);
  return rows.map(toClient);
};

export const getClient = async (db: Db, id: string): Promise<Client | undefined> => {
  const { rows } = await db.query<ClientRow>(`${SELECT_CLIENTS} WHERE c.id = $1`, [id]);
  return rows[0] ? toClient(rows[0]) : undefined;
};

/** The owner is always the signed-in user (auth.uid()), never a value from the request. */
export const createClient = async (db: Db, input: ClientCreate): Promise<Client> => {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.clients (user_id, name, email, country, time_zone, settings)
     VALUES ((SELECT auth.uid()), $1, $2, $3, $4, $5)
     RETURNING id::text`,
    [input.name, input.email, input.country, input.timeZone, JSON.stringify(input.settings)],
  );
  const id = rows[0]?.id;
  const client = id ? await getClient(db, id) : undefined;
  if (!client) throw new Error("The new client could not be read back after saving.");
  return client;
};

export const updateClient = async (
  db: Db,
  id: string,
  changes: ClientUpdate,
): Promise<Client | undefined> => {
  const { rowCount } = await db.query(
    `UPDATE public.clients SET
       name = coalesce($2, name),
       email = coalesce($3, email),
       country = coalesce($4, country),
       time_zone = coalesce($5, time_zone),
       settings = coalesce($6::jsonb, settings)
     WHERE id = $1`,
    [
      id,
      changes.name ?? null,
      changes.email ?? null,
      changes.country ?? null,
      changes.timeZone ?? null,
      changes.settings ? JSON.stringify(changes.settings) : null,
    ],
  );
  return rowCount > 0 ? getClient(db, id) : undefined;
};

/** Deletes the client with its projects, invoices and messages (foreign keys cascade). */
export type DeleteResult = "deleted" | "not_found" | "has_auto_pay" | "has_hold";

/** Deleting a client must not leave PayPal charging them with no record of it here. */
export const deleteClient = async (db: Db, id: string): Promise<DeleteResult> => {
  const { rows } = await db.query(
    `SELECT 1 FROM public.retainers
     WHERE client_id = $1 AND paypal_subscription_id IS NOT NULL
       AND status IN ('pending_approval', 'active', 'suspended')`,
    [id],
  );
  if (rows.length > 0) return "has_auto_pay";
  const { rows: holds } = await db.query(
    `SELECT 1 FROM public.milestone_holds h
     JOIN public.milestones m ON m.id = h.milestone_id
     JOIN public.projects p ON p.id = m.project_id
     WHERE p.client_id = $1 AND h.status IN (${LIVE_HOLD_SQL})`,
    [id],
  );
  if (holds.length > 0) return "has_hold";
  const { rowCount } = await db.query("DELETE FROM public.clients WHERE id = $1", [id]);
  return rowCount > 0 ? "deleted" : "not_found";
};
