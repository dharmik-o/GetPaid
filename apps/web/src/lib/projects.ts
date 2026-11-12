import { z } from "zod";
import { isPaypalCurrency } from "./currencies";
import { isUuid, type Db } from "./db";
import { toCents } from "./db-values";
import { nestIssues, toFieldIssues, type FieldIssue } from "./field-issues";
import {
  mergeSettings,
  settingsOverrideSchema,
  type ScheduleSettings,
  type SettingsOverride,
} from "./settings";
import { validateSettings } from "./settings-validation";

// Server-only: projects. Queries run as the signed-in user (RLS), so another user's project
// or client is simply not found.

export type Project = {
  id: string;
  clientId: string;
  clientName: string;
  clientTimeZone: string;
  title: string;
  totalCents: number;
  currency: string;
  deadline: string;
  contractTerms: string | null;
  lateFeeClause: string | null;
  /** This project's own schedule overrides. */
  settings: SettingsOverride;
  /** The account and client settings merged: what the project uses where it sets nothing. */
  inherited: ScheduleSettings;
  status: string;
  /** Archived projects are hidden from lists and Home, and plan no reminders. */
  archived: boolean;
};

export type ProjectSummary = Pick<
  Project,
  "id" | "title" | "totalCents" | "currency" | "deadline" | "status"
>;

/** A row on the Projects page. */
export type ProjectListItem = ProjectSummary & Pick<Project, "clientId" | "clientName" | "archived">;

export type ProjectResult =
  | { ok: true; project: Project; warnings: FieldIssue[] }
  | { ok: false; errors: FieldIssue[] }
  | { ok: false; notFound: true };

const optionalText = z
  .string({ error: "must be text" })
  .trim()
  .max(5000, "must be 5,000 characters or fewer")
  .nullable();

const fieldsSchema = z.strictObject({
  clientId: z.string({ error: "must be one of your clients" }),
  title: z
    .string({ error: "is required" })
    .trim()
    .min(1, "is required")
    .max(200, "must be 200 characters or fewer"),
  totalCents: z
    .int("must be a whole number of minor units (cents)")
    .min(1, "must be more than 0")
    .max(Number.MAX_SAFE_INTEGER, "is too large"),
  currency: z
    .string({ error: "must be a currency PayPal supports" })
    .refine(isPaypalCurrency, "must be a currency PayPal supports"),
  deadline: z.iso.date({ error: "must be a date like 2026-12-31" }),
  contractTerms: optionalText,
  lateFeeClause: optionalText,
  /** Checked by validateSettings, so its errors are reported field by field. */
  settings: z.unknown(),
});

const createSchema = fieldsSchema.partial({
  contractTerms: true,
  lateFeeClause: true,
  settings: true,
});

/** A project can't move to another client. */
const updateSchema = fieldsSchema.omit({ clientId: true }).partial();

const CLIENT_ERROR: FieldIssue = { field: "clientId", message: "must be one of your clients" };

type ClientContext = { inherited: ScheduleSettings };

/** The account and client settings the project inherits, or undefined if the client isn't the user's. */
const loadClientContext = async (db: Db, clientId: string): Promise<ClientContext | undefined> => {
  if (!isUuid(clientId)) return undefined;
  const { rows } = await db.query<{ account: unknown; client: unknown }>(
    `SELECT u.default_settings AS account, c.settings AS client
     FROM public.clients c JOIN public.users u ON u.id = c.user_id
     WHERE c.id = $1`,
    [clientId],
  );
  const row = rows[0];
  return row
    ? { inherited: mergeSettings({ account: row.account, client: row.client }) }
    : undefined;
};

const blankToNull = (text: string | null | undefined): string | null => (text ? text : null);

type SettingsCheck = { settings: SettingsOverride; errors: FieldIssue[]; warnings: FieldIssue[] };

const checkSettings = (
  raw: unknown,
  context: { inherited?: ScheduleSettings; deadline?: string; lateFeeClause: string | null },
): SettingsCheck => {
  const result = validateSettings(raw ?? {}, {
    ...(context.inherited ? { parent: context.inherited } : {}),
    ...(context.deadline ? { deadline: context.deadline } : {}),
    contractHasLateFee: context.lateFeeClause !== null,
  });
  const warnings = nestIssues(result.warnings, "settings");
  return result.ok
    ? { settings: result.settings, errors: [], warnings }
    : { settings: {}, errors: nestIssues(result.errors, "settings"), warnings };
};

type ProjectRow = {
  id: string;
  client_id: string;
  client_name: string;
  client_time_zone: string;
  client_settings: unknown;
  account_settings: unknown;
  title: string;
  total_cents: string;
  currency: string;
  deadline: string | null;
  contract_terms: string | null;
  late_fee_clause: string | null;
  settings: unknown;
  status: string;
  archived_at: string | null;
};

const SELECT_PROJECTS = `
  SELECT p.id::text, p.client_id::text, c.name AS client_name, c.time_zone AS client_time_zone,
    c.settings AS client_settings, u.default_settings AS account_settings, p.title,
    p.total_cents::text, p.currency, p.deadline::text, p.contract_terms, p.late_fee_clause,
    p.settings, p.status, p.archived_at::text
  FROM public.projects p
  JOIN public.clients c ON c.id = p.client_id
  JOIN public.users u ON u.id = p.user_id`;

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  clientId: row.client_id,
  clientName: row.client_name,
  clientTimeZone: row.client_time_zone,
  title: row.title,
  totalCents: toCents(row.total_cents),
  currency: row.currency,
  deadline: row.deadline ?? "",
  contractTerms: row.contract_terms,
  lateFeeClause: row.late_fee_clause,
  settings: settingsOverrideSchema.parse(row.settings),
  inherited: mergeSettings({ account: row.account_settings, client: row.client_settings }),
  status: row.status,
  archived: row.archived_at !== null,
});

export const getProject = async (db: Db, id: string): Promise<Project | undefined> => {
  if (!isUuid(id)) return undefined;
  const { rows } = await db.query<ProjectRow>(`${SELECT_PROJECTS} WHERE p.id = $1`, [id]);
  return rows[0] ? toProject(rows[0]) : undefined;
};

export const listProjectsForClient = async (
  db: Db,
  clientId: string,
): Promise<ProjectSummary[]> => {
  const { rows } = await db.query<ProjectRow>(
    `${SELECT_PROJECTS} WHERE p.client_id = $1 AND p.archived_at IS NULL
     ORDER BY p.deadline NULLS LAST, p.created_at`,
    [clientId],
  );
  return rows.map(toProject).map(({ id, title, totalCents, currency, deadline, status }) => ({
    id,
    title,
    totalCents,
    currency,
    deadline,
    status,
  }));
};

/** Archived projects are left out unless asked for. */
export const listProjects = async (
  db: Db,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<ProjectListItem[]> => {
  const { rows } = await db.query<ProjectRow>(
    `${SELECT_PROJECTS} ${includeArchived ? "" : "WHERE p.archived_at IS NULL"}
     ORDER BY p.deadline NULLS LAST, p.created_at`,
  );
  return rows.map(toProject).map((project) => ({
    id: project.id,
    title: project.title,
    totalCents: project.totalCents,
    currency: project.currency,
    deadline: project.deadline,
    status: project.status,
    clientId: project.clientId,
    clientName: project.clientName,
    archived: project.archived,
  }));
};

const readBack = async (db: Db, id: string, warnings: FieldIssue[]): Promise<ProjectResult> => {
  const project = await getProject(db, id);
  if (!project) throw new Error("The project could not be read back after saving.");
  return { ok: true, project, warnings };
};

/** Checks and saves a new project. The owner is auth.uid(), never a value from the request. */
export const createProject = async (db: Db, raw: unknown): Promise<ProjectResult> => {
  const parsed = createSchema.safeParse(raw);
  const fieldErrors = parsed.success ? [] : toFieldIssues(parsed.error, { noun: "field" });
  const rawClientId =
    raw && typeof raw === "object" && "clientId" in raw ? raw.clientId : undefined;
  const client =
    typeof rawClientId === "string" ? await loadClientContext(db, rawClientId) : undefined;
  const lateFeeClause = blankToNull(parsed.data?.lateFeeClause);
  const settings = checkSettings(
    raw && typeof raw === "object" && "settings" in raw ? raw.settings : undefined,
    { inherited: client?.inherited, deadline: parsed.data?.deadline, lateFeeClause },
  );
  const clientErrors =
    client || fieldErrors.some((e) => e.field === "clientId") ? [] : [CLIENT_ERROR];
  const errors = [...fieldErrors, ...clientErrors, ...settings.errors];
  if (!parsed.success || errors.length > 0) return { ok: false, errors };

  const input = parsed.data;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.projects
       (user_id, client_id, title, total_cents, currency, deadline, contract_terms, late_fee_clause, settings, status)
     VALUES ((SELECT auth.uid()), $1, $2, $3, $4, $5, $6, $7, $8, 'active')
     RETURNING id::text`,
    [
      input.clientId,
      input.title,
      input.totalCents,
      input.currency,
      input.deadline,
      blankToNull(input.contractTerms),
      lateFeeClause,
      JSON.stringify(settings.settings),
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Saving the project returned no id.");
  return readBack(db, id, settings.warnings);
};

/** Checks changes against the saved project (deadline, late-fee clause), then saves them. */
export const updateProject = async (db: Db, id: string, raw: unknown): Promise<ProjectResult> => {
  const existing = await getProject(db, id);
  if (!existing) return { ok: false, notFound: true };
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };

  const changes = parsed.data;
  const next = {
    title: changes.title ?? existing.title,
    totalCents: changes.totalCents ?? existing.totalCents,
    currency: changes.currency ?? existing.currency,
    deadline: changes.deadline ?? existing.deadline,
    contractTerms:
      changes.contractTerms === undefined
        ? existing.contractTerms
        : blankToNull(changes.contractTerms),
    lateFeeClause:
      changes.lateFeeClause === undefined
        ? existing.lateFeeClause
        : blankToNull(changes.lateFeeClause),
  };
  const settings = checkSettings(
    changes.settings === undefined ? existing.settings : changes.settings,
    {
      inherited: existing.inherited,
      deadline: next.deadline,
      lateFeeClause: next.lateFeeClause,
    },
  );
  if (settings.errors.length > 0) return { ok: false, errors: settings.errors };

  await db.query(
    `UPDATE public.projects SET title = $2, total_cents = $3, currency = $4, deadline = $5,
       contract_terms = $6, late_fee_clause = $7, settings = $8
     WHERE id = $1`,
    [
      id,
      next.title,
      next.totalCents,
      next.currency,
      next.deadline,
      next.contractTerms,
      next.lateFeeClause,
      JSON.stringify(settings.settings),
    ],
  );
  return readBack(db, id, settings.warnings);
};

export type ClientChoice = {
  id: string;
  name: string;
  timeZone: string;
  inherited: ScheduleSettings;
};

/** The user's clients for the project form, each with the settings a new project would inherit. */
export const listClientChoices = async (db: Db): Promise<ClientChoice[]> => {
  const { rows } = await db.query<{
    id: string;
    name: string;
    time_zone: string;
    account: unknown;
    client: unknown;
  }>(
    `SELECT c.id::text, c.name, c.time_zone, u.default_settings AS account, c.settings AS client
     FROM public.clients c JOIN public.users u ON u.id = c.user_id
     ORDER BY lower(c.name), c.id`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    timeZone: row.time_zone,
    inherited: mergeSettings({ account: row.account, client: row.client }),
  }));
};
