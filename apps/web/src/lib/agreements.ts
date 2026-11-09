import { createHash } from "node:crypto";
import { getLegalFacts, getOwnTimeZone } from "./account";
import {
  AGREEMENT_OPTIONS_SCHEMA,
  agreementFactsSchema,
  renderAgreement,
  type AgreementFacts,
  type AgreementOptions,
} from "./agreement-template";
import type { Db } from "./db";
import { toCents, toIso } from "./db-values";
import { getClient } from "./clients";
import { toFieldIssues, type FieldIssue } from "./field-issues";
import { getClientDetails } from "./invoice-details";
import { pickCitation, type Law } from "./legal";
import { formatMoney } from "./format";
import { listMilestones } from "./milestones";
import { getProject } from "./projects";
import { todayIn } from "./schedule";

// Server-only: project agreements as the signed-in freelancer sees them (RLS). A draft can be
// edited; once an agreement is sent its document never changes (the database refuses it), and a
// change is a new version. Sending and signing are in lib/agreement-signing.ts.

export const AGREEMENT_STATUSES = [
  "draft",
  "sent",
  "signed",
  "declined",
  "expired",
  "void",
] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

export type Agreement = {
  id: string;
  projectId: string;
  clientId: string;
  number: string;
  version: number;
  status: AgreementStatus;
  options: AgreementOptions;
  facts: AgreementFacts;
  bodyHtml: string;
  bodySha256: string;
  signedPdfPath: string | null;
  sentAt: string | null;
  signedAt: string | null;
  createdAt: string;
};

export type AgreementSummary = Pick<
  Agreement,
  "id" | "number" | "version" | "status" | "createdAt" | "sentAt" | "signedAt"
>;

export type Context = { now: Date; laws: readonly Law[] };

export type Failure =
  | { ok: false; errors: FieldIssue[] }
  | { ok: false; notFound: true }
  | { ok: false; conflict: string };
export type Saved = { ok: true; agreement: Agreement } | Failure;
export type Preview = { ok: true; html: string; options: AgreementOptions } | Failure;

type Row = {
  id: string;
  project_id: string;
  client_id: string;
  number: string;
  version: number;
  status: AgreementStatus;
  options: unknown;
  facts: unknown;
  body_html: string;
  body_sha256: string;
  signed_pdf_path: string | null;
  sent_at: unknown;
  signed_at: unknown;
  created_at: unknown;
};

const COLUMNS = `id::text, project_id::text, client_id::text, number, version, status, options, facts,
  body_html, body_sha256, signed_pdf_path, sent_at, signed_at, created_at`;

const dateOrNull = (value: unknown): string | null => (value === null ? null : toIso(value));

const toAgreement = (row: Row): Agreement => ({
  id: row.id,
  projectId: row.project_id,
  clientId: row.client_id,
  number: row.number,
  version: row.version,
  status: row.status,
  options: AGREEMENT_OPTIONS_SCHEMA.parse(row.options),
  facts: agreementFactsSchema.parse(row.facts),
  bodyHtml: row.body_html,
  bodySha256: row.body_sha256,
  signedPdfPath: row.signed_pdf_path,
  sentAt: dateOrNull(row.sent_at),
  signedAt: dateOrNull(row.signed_at),
  createdAt: toIso(row.created_at),
});

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

const REPEAT_UNITS: Record<string, string> = { week: "week", month: "month" };

const every = (count: number, unit: string): string =>
  count === 1 ? `every ${unit}` : `every ${String(count)} ${unit}s`;

/** Retainers and maintenance on the project, one plain sentence each. */
const ongoingServices = async (db: Db, projectId: string): Promise<string[]> => {
  const { rows: retainers } = await db.query<{
    name: string;
    amount_cents: unknown;
    currency: string;
    interval_unit: string;
    interval_count: number;
  }>(
    `SELECT name, amount_cents::text, currency, interval_unit, interval_count
     FROM public.retainers
     WHERE project_id = $1 AND status IN ('pending_approval', 'active', 'suspended')
     ORDER BY created_at, id`,
    [projectId],
  );
  const { rows: tasks } = await db.query<{
    task: string;
    repeat_months: number;
    est_cost_cents: unknown;
    currency: string;
  }>(
    `SELECT task, repeat_months, est_cost_cents::text, currency
     FROM public.maintenance_tasks WHERE project_id = $1 AND status = 'active'
     ORDER BY created_at, id`,
    [projectId],
  );
  return [
    ...retainers.map(
      (r) =>
        `Retainer "${r.name}": ${formatMoney(toCents(r.amount_cents), r.currency)} ${every(r.interval_count, REPEAT_UNITS[r.interval_unit] ?? r.interval_unit)}.`,
    ),
    ...tasks.map(
      (t) =>
        `${t.task}, ${every(t.repeat_months, "month")}${
          t.est_cost_cents === null
            ? ""
            : `, estimated at ${formatMoney(toCents(t.est_cost_cents), t.currency)}`
        }.`,
    ),
  ];
};

/** The facts a document is filled from, read fresh. Undefined when the project isn't the user's. */
export const buildFacts = async (
  db: Db,
  projectId: string,
  { now, laws }: Context,
): Promise<AgreementFacts | undefined> => {
  const project = await getProject(db, projectId);
  if (!project) return undefined;
  const client = await getClient(db, project.clientId);
  const { rows } = await db.query<{
    name: string;
    email: string;
    business_name: string | null;
    address: string | null;
  }>("SELECT name, email, business_name, address FROM public.users WHERE id = (SELECT auth.uid())");
  const me = rows[0];
  if (!client || !me) return undefined;
  const legal = await getLegalFacts(db);
  const details = await getClientDetails(db, client.id);
  const citation = pickCitation({
    lateFeeClause: null,
    country: client.country,
    facts: {
      clientRegion: client.region,
      clientIsBusiness: client.isBusiness,
      freelancerHasUdyam: legal.udyamNumber !== null,
      amountCents: project.totalCents,
      currency: project.currency,
    },
    laws,
  });
  return {
    freelancer: {
      legalName: legal.legalName ?? me.name,
      businessName: me.business_name,
      address: me.address,
      email: me.email,
      udyamNumber: legal.udyamNumber,
    },
    client: {
      name: client.name,
      company: details?.company ?? null,
      address: details?.address ?? null,
      email: client.email,
      country: client.country,
      region: client.region,
    },
    project: {
      title: project.title,
      scope: project.contractTerms,
      totalCents: project.totalCents,
      currency: project.currency,
      deadline: project.deadline || null,
    },
    milestones: (await listMilestones(db, project)).map((m) => ({
      name: m.name,
      amountCents: m.cents,
      deadline: m.deadline,
      paymentMode: m.paymentMode,
    })),
    ongoing: await ongoingServices(db, projectId),
    effectiveDate: todayIn(now, await getOwnTimeZone(db)),
    lawCitation: citation?.kind === "statute" ? citation.text : null,
  };
};

const UDYAM_MAX_PAYMENT_DAYS = 45;

/** The options as the document needs them, or what to fix. */
export const checkOptions = (
  raw: unknown,
  facts: AgreementFacts,
  defaultCountry: string | null,
): { ok: true; options: AgreementOptions } | { ok: false; errors: FieldIssue[] } => {
  const given = raw && typeof raw === "object" ? raw : {};
  const withCountry =
    defaultCountry && !("governingLawCountry" in given)
      ? { governingLawCountry: defaultCountry, ...given }
      : given;
  const parsed = AGREEMENT_OPTIONS_SCHEMA.safeParse(withCountry);
  if (!parsed.success)
    return { ok: false, errors: toFieldIssues(parsed.error, { noun: "option" }) };
  const { options } = { options: parsed.data };
  // The MSMED Act: a buyer must pay a registered supplier within 45 days at most.
  if (
    facts.client.country === "IN" &&
    facts.freelancer.udyamNumber !== null &&
    options.paymentDays > UDYAM_MAX_PAYMENT_DAYS
  ) {
    return {
      ok: false,
      errors: [
        {
          field: "paymentDays",
          message: `can be at most ${String(UDYAM_MAX_PAYMENT_DAYS)} days for a client in India when you have a Udyam number`,
        },
      ],
    };
  }
  return { ok: true, options };
};

type Prepared = {
  ok: true;
  facts: AgreementFacts;
  options: AgreementOptions;
  html: string;
};

const prepare = async (
  db: Db,
  projectId: string,
  raw: unknown,
  ctx: Context,
): Promise<Prepared | Failure> => {
  const facts = await buildFacts(db, projectId, ctx);
  if (!facts) return { ok: false, notFound: true };
  const checked = checkOptions(raw, facts, (await getLegalFacts(db)).governingLawCountry);
  if (!checked.ok) return checked;
  return {
    ok: true,
    facts,
    options: checked.options,
    html: renderAgreement(facts, checked.options).html,
  };
};

/** The document for these options, nothing saved. */
export const previewAgreement = async (
  db: Db,
  projectId: string,
  raw: unknown,
  ctx: Context,
): Promise<Preview> => {
  const prepared = await prepare(db, projectId, raw, ctx);
  return prepared.ok ? { ok: true, html: prepared.html, options: prepared.options } : prepared;
};

export const getAgreement = async (db: Db, id: string): Promise<Agreement | undefined> => {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM public.agreements WHERE id = $1`, [
    id,
  ]);
  return rows[0] ? toAgreement(rows[0]) : undefined;
};

export const listAgreements = async (db: Db, projectId: string): Promise<AgreementSummary[]> => {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM public.agreements WHERE project_id = $1
     ORDER BY number DESC, version DESC`,
    [projectId],
  );
  return rows.map((row) => {
    const { id, number, version, status, createdAt, sentAt, signedAt } = toAgreement(row);
    return { id, number, version, status, createdAt, sentAt, signedAt };
  });
};

const nextNumber = async (db: Db): Promise<string> => {
  const { rows } = await db.query<{ next: number }>(
    "SELECT coalesce(max(substring(number from 5)::int), 0) + 1 AS next FROM public.agreements",
  );
  return `AGR-${String(rows[0]?.next ?? 1).padStart(6, "0")}`;
};

/** An agreement already in progress for the project, other than `except`. */
const liveAgreement = async (
  db: Db,
  projectId: string,
  except?: string,
): Promise<string | undefined> => {
  const { rows } = await db.query<{ number: string }>(
    `SELECT number FROM public.agreements
     WHERE project_id = $1 AND status IN ('draft', 'sent') AND id IS DISTINCT FROM $2`,
    [projectId, except ?? null],
  );
  return rows[0]?.number;
};

const inProgress = (number: string): Failure => ({
  ok: false,
  conflict: `This project already has an agreement in progress (${number}). Open it to edit it, or void it first.`,
});

const insert = async (
  db: Db,
  p: { projectId: string; clientId: string; number: string; version: number } & Prepared,
): Promise<Agreement> => {
  const { rows } = await db.query<Row>(
    `INSERT INTO public.agreements
       (user_id, project_id, client_id, number, version, options, facts, body_html, body_sha256)
     VALUES ((SELECT auth.uid()), $1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [
      p.projectId,
      p.clientId,
      p.number,
      p.version,
      JSON.stringify(p.options),
      JSON.stringify(p.facts),
      p.html,
      sha256Hex(p.html),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("The new agreement could not be read back after saving.");
  return toAgreement(row);
};

/** Saves a new draft (version 1) for a project. */
export const createDraft = async (
  db: Db,
  projectId: string,
  raw: unknown,
  ctx: Context,
): Promise<Saved> => {
  const prepared = await prepare(db, projectId, raw, ctx);
  if (!prepared.ok) return prepared;
  const live = await liveAgreement(db, projectId);
  if (live) return inProgress(live);
  const project = await getProject(db, projectId);
  if (!project) return { ok: false, notFound: true };
  const agreement = await insert(db, {
    ...prepared,
    projectId,
    clientId: project.clientId,
    number: await nextNumber(db),
    version: 1,
  });
  return { ok: true, agreement };
};

/** Changes a draft's options, and re-reads the facts so it shows today's project data. */
export const updateDraft = async (
  db: Db,
  id: string,
  raw: unknown,
  ctx: Context,
): Promise<Saved> => {
  const current = await getAgreement(db, id);
  if (!current) return { ok: false, notFound: true };
  if (current.status !== "draft") {
    return {
      ok: false,
      conflict: `${current.number} is ${current.status}, so its document can't change. Make a new version instead.`,
    };
  }
  const prepared = await prepare(db, current.projectId, raw, ctx);
  if (!prepared.ok) return prepared;
  await db.query(
    `UPDATE public.agreements
     SET options = $2, facts = $3, body_html = $4, body_sha256 = $5
     WHERE id = $1`,
    [
      id,
      JSON.stringify(prepared.options),
      JSON.stringify(prepared.facts),
      prepared.html,
      sha256Hex(prepared.html),
    ],
  );
  const agreement = await getAgreement(db, id);
  return agreement ? { ok: true, agreement } : { ok: false, notFound: true };
};

/** Cancels a draft or an agreement that was sent but not yet signed. Nothing is deleted. */
export const voidAgreement = async (db: Db, id: string): Promise<Saved> => {
  const current = await getAgreement(db, id);
  if (!current) return { ok: false, notFound: true };
  if (current.status !== "draft" && current.status !== "sent") {
    return {
      ok: false,
      conflict: `${current.number} is already ${current.status}, so there is nothing to void.`,
    };
  }
  await db.query(
    "UPDATE public.agreements SET status = 'void', token_sha256 = NULL WHERE id = $1",
    [id],
  );
  const agreement = await getAgreement(db, id);
  return agreement ? { ok: true, agreement } : { ok: false, notFound: true };
};

const REPLACEABLE: readonly AgreementStatus[] = ["sent", "declined", "expired", "void"];

/**
 * A new draft version with the same number and options. A sent one is voided first, so the old
 * signing link stops working. A signed agreement is never replaced here, and a draft is edited.
 */
export const newVersion = async (db: Db, id: string, ctx: Context): Promise<Saved> => {
  const current = await getAgreement(db, id);
  if (!current) return { ok: false, notFound: true };
  if (!REPLACEABLE.includes(current.status)) {
    return {
      ok: false,
      conflict:
        current.status === "draft"
          ? `${current.number} is still a draft. Edit it instead.`
          : `${current.number} is signed and can't be replaced here. Ask the client to agree to any change in writing.`,
    };
  }
  const prepared = await prepare(db, current.projectId, current.options, ctx);
  if (!prepared.ok) return prepared;
  const live = await liveAgreement(db, current.projectId, id);
  if (live) return inProgress(live);
  if (current.status === "sent") await voidAgreement(db, id);
  const { rows } = await db.query<{ next: number }>(
    "SELECT max(version) + 1 AS next FROM public.agreements WHERE number = $1",
    [current.number],
  );
  const agreement = await insert(db, {
    ...prepared,
    projectId: current.projectId,
    clientId: current.clientId,
    number: current.number,
    version: rows[0]?.next ?? current.version + 1,
  });
  return { ok: true, agreement };
};
