import { z } from "zod";
import type { Db } from "./db";
import type { FieldIssue } from "./field-issues";
import { sanitizeTemplate, type SanitizeResult } from "./template-sanitize";

// Server-only: invoice templates, read and written as the signed-in user (RLS). Built-ins are
// shared and read-only; a custom template is sanitised before every save, and only a template
// that passes (nothing refused, every tag known) is stored.

/** Classic: used when neither the client nor the account has picked a default. */
export const CLASSIC_TEMPLATE_ID = "00000000-0000-4000-8000-00000000c001";

export type TemplateSummary = { id: string; name: string; kind: "builtin" | "custom" };
export type Template = TemplateSummary & { html: string; css: string; updatedAt: string };

type Row = {
  id: string;
  name: string;
  kind: "builtin" | "custom";
  html: string;
  css: string;
  updated_at: Date | string;
};

const SELECT = "SELECT id::text, name, kind, html, css, updated_at FROM public.invoice_templates";

const toTemplate = (row: Row): Template => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  html: row.html,
  css: row.css,
  updatedAt: new Date(row.updated_at).toISOString(),
});

/** Built-ins first (Classic, Modern, Minimal), then the user's own by name. */
export const listTemplates = async (db: Db): Promise<TemplateSummary[]> => {
  const { rows } = await db.query<Row>(
    `${SELECT} ORDER BY (kind = 'custom'), CASE WHEN kind = 'builtin' THEN id::text END, lower(name)`,
  );
  return rows.map(({ id, name, kind }) => ({ id, name, kind }));
};

export const getTemplate = async (db: Db, id: string): Promise<Template | undefined> => {
  const { rows } = await db.query<Row>(`${SELECT} WHERE id = $1`, [id]);
  return rows[0] ? toTemplate(rows[0]) : undefined;
};

const nameSchema = z
  .string({ error: "is required" })
  .trim()
  .min(1, "is required")
  .max(80, "must be 80 characters or fewer");

export const templateBodySchema = z.strictObject({
  name: nameSchema,
  html: z.string({ error: "is required" }).min(1, "is required"),
  css: z.string().default(""),
});

export type SaveTemplateResult =
  | { ok: true; template: Template; removed: string[] }
  | { ok: false; errors: FieldIssue[]; sanitized?: SanitizeResult };

/** The sanitiser's refusals and tag problems, as field errors the editor shows inline. */
export const sanitizeIssues = (result: SanitizeResult): FieldIssue[] => [
  ...result.refused.map((message) => ({ field: "html", message })),
  ...result.tagIssues.map((issue) => ({
    field: "html",
    message: `line ${String(issue.line)}: ${issue.message}`,
  })),
];

const checked = (
  body: z.infer<typeof templateBodySchema>,
):
  | { ok: true; sanitized: SanitizeResult }
  | { ok: false; errors: FieldIssue[]; sanitized: SanitizeResult } => {
  const sanitized = sanitizeTemplate(body);
  return sanitized.ok
    ? { ok: true, sanitized }
    : { ok: false, errors: sanitizeIssues(sanitized), sanitized };
};

export const createTemplate = async (
  db: Db,
  body: z.infer<typeof templateBodySchema>,
): Promise<SaveTemplateResult> => {
  const result = checked(body);
  if (!result.ok) return result;
  const { rows } = await db.query<Row>(
    `INSERT INTO public.invoice_templates (user_id, name, kind, html, css)
     VALUES ((SELECT auth.uid()), $1, 'custom', $2, $3)
     RETURNING id::text, name, kind, html, css, updated_at`,
    [body.name, result.sanitized.html, result.sanitized.css],
  );
  const row = rows[0];
  if (!row) throw new Error("The new template could not be read back after saving.");
  return { ok: true, template: toTemplate(row), removed: result.sanitized.removed };
};

/** A custom copy of any template the user can see (a built-in or their own). */
export const duplicateTemplate = async (
  db: Db,
  id: string,
): Promise<SaveTemplateResult | undefined> => {
  const source = await getTemplate(db, id);
  if (!source) return undefined;
  return createTemplate(db, {
    name: `${source.name} (copy)`.slice(0, 80),
    html: source.html,
    css: source.css,
  });
};

/** Only the user's own custom templates change; a built-in is "not found" here. */
export const updateTemplate = async (
  db: Db,
  id: string,
  body: z.infer<typeof templateBodySchema>,
): Promise<SaveTemplateResult | undefined> => {
  const existing = await getTemplate(db, id);
  if (!existing || existing.kind !== "custom") return undefined;
  const result = checked(body);
  if (!result.ok) return result;
  const { rows } = await db.query<Row>(
    `UPDATE public.invoice_templates SET name = $2, html = $3, css = $4
     WHERE id = $1 AND kind = 'custom'
     RETURNING id::text, name, kind, html, css, updated_at`,
    [id, body.name, result.sanitized.html, result.sanitized.css],
  );
  const row = rows[0];
  return row
    ? { ok: true, template: toTemplate(row), removed: result.sanitized.removed }
    : undefined;
};

export const deleteTemplate = async (db: Db, id: string): Promise<boolean> => {
  const { rowCount } = await db.query(
    "DELETE FROM public.invoice_templates WHERE id = $1 AND kind = 'custom'",
    [id],
  );
  return rowCount > 0;
};

/**
 * The template for an invoice: the one picked, else the client's default, else the account's,
 * else Classic. A template the user can't see (another user's, or deleted) is skipped.
 */
export const resolveTemplateId = async (
  db: Db,
  { picked, clientId }: { picked: string | null; clientId: string },
): Promise<string> => {
  const { rows } = await db.query<{ id: string }>(
    `SELECT t.id::text FROM (
       SELECT $1::uuid AS id, 1 AS rank
       UNION ALL SELECT default_template_id, 2 FROM public.clients WHERE id = $2
       UNION ALL SELECT default_template_id, 3 FROM public.users WHERE id = (SELECT auth.uid())
     ) c
     JOIN public.invoice_templates t ON t.id = c.id
     ORDER BY c.rank LIMIT 1`,
    [picked, clientId],
  );
  return rows[0]?.id ?? CLASSIC_TEMPLATE_ID;
};
