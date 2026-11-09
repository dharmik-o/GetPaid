import { z } from "zod";
import type { ChatMessage } from "./ai-client";
import { routeTask } from "./ai-router";
import { draftSchema, type Draft } from "./ai-schemas";
import { loadAiConnections } from "./ai-settings";
import type { SecretBox } from "./crypto";
import type { Db, UserDbRunner } from "./db";
import { toCents } from "./db-values";
import { moneyIn } from "./draft-checks";
import { unknownDates } from "./draft-dates";
import { toFieldIssues, type FieldIssue } from "./field-issues";
import { formatFullDay, formatMoney } from "./format";
import { lawApplies, legalProblem, type Law } from "./legal";
import { logEvent } from "./log";
import { PROMPT_TEXT } from "./prompt-text";
import type { ReferenceRates } from "./reference-rates";
import { addCalendarDays, daysOverdue, todayIn } from "./schedule";
import { statutoryClaim, type Claim } from "./statutory-interest";
import type { StoredDraft } from "./stored-draft";

// Server-only: the final demand letter, an upgraded Tier 3. It is drafted from the facts and from
// statements the CODE builds (the signed agreement's clause, an approved law's own sentence, the
// calculated interest and compensation, the one next step from a fixed list). The model writes only
// the connecting words, and `demandProblems` checks that every statement is there word for word and
// that nothing else legal, financial or dated crept in. A draft that fails the checks is replaced by
// the fixed template. It is always an Outbox draft: nothing here can send.

const MSMED_LAW_ID = "in-msmed-2006";
export const DEADLINE_DAYS = { min: 7, max: 14, default: 7 } as const;

const NBSP = String.fromCharCode(160);
const plain = (text: string): string => text.replaceAll(NBSP, " ");
const squash = (text: string): string => plain(text).replace(/\s+/g, " ").trim();

export type DemandStatements = {
  /** The signed agreement's late-payment clause, or the project's own, quoted. */
  agreement: string | null;
  /** An approved law's own citation sentence, when the clause doesn't already carry it. */
  law: string | null;
  /** The calculated interest and compensation, and the total. */
  claim: string | null;
  /** The one next step, from a fixed list. */
  nextStep: string;
  /** Only when the Indian MSMED Act is the law that applies. */
  udyam: string | null;
};

export type DemandFacts = {
  freelancerName: string;
  clientName: string;
  projectTitle: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  /** What's still owed on the invoice itself. */
  amountDue: string;
  amountPaid: string | null;
  daysOverdue: number;
  /** The date by which to pay, in the letter's words. */
  deadline: string;
  /** The invoice's total with interest and compensation, or just `amountDue` with no claim. */
  totalToPay: string;
  payLink: string;
  statements: DemandStatements;
};

export type DemandMeta = {
  citation: "contract" | "statute" | null;
  lawId: string | null;
  claim: Claim | null;
  /** The details a letter's PDF needs: not shown to a model. */
  invoiceId: string;
  clientId: string;
};

export type DemandContext = { now: Date; laws: readonly Law[]; rates: ReferenceRates };

export type DemandFailure =
  | { ok: false; notFound: true }
  | { ok: false; conflict: string }
  | { ok: false; errors: FieldIssue[] };

type Row = {
  invoice_number: string;
  status: string;
  amount_cents: unknown;
  amount_paid_cents: unknown;
  currency: string;
  due_date: string | null;
  link: string | null;
  created_at: Date | string;
  held: boolean;
  project_id: string | null;
  project_title: string;
  late_fee_clause: string | null;
  client_id: string;
  client_name: string;
  country: string;
  region: string | null;
  is_business: boolean;
  time_zone: string;
  freelancer_name: string;
  udyam_number: string | null;
};

const SELECT = `
  SELECT i.invoice_number, i.status, i.amount_cents::text, i.amount_paid_cents::text, i.currency,
    i.due_date::text, i.link, i.created_at, i.reminders_held_at IS NOT NULL AS held,
    p.id::text AS project_id, coalesce(p.title, rt.name) AS project_title,
    p.late_fee_clause, c.id::text AS client_id, c.name AS client_name, c.country, c.region,
    c.is_business, c.time_zone, u.name AS freelancer_name, u.udyam_number
  FROM public.invoices i
  LEFT JOIN public.milestones m ON m.id = i.milestone_id
  LEFT JOIN public.retainers rt ON rt.id = i.retainer_id
  LEFT JOIN public.projects p ON p.id = coalesce(m.project_id, rt.project_id)
  JOIN public.clients c ON c.id = coalesce(p.client_id, rt.client_id)
  JOIN public.users u ON u.id = i.user_id
  WHERE i.id = $1`;

const money = (cents: number, currency: string): string => plain(formatMoney(cents, currency));

/** "Statutory interest of X (how it was worked out) and fixed compensation of Y are also due under LAW, bringing the total to Z." */
const claimStatement = (claim: Claim, law: Law, currency: string): string | null => {
  const parts = [
    claim.interestCents === null
      ? null
      : `statutory interest of ${money(claim.interestCents, currency)} (${claim.explanation.replace(/\.$/, "")})`,
    claim.compensationCents > 0
      ? `fixed compensation of ${money(claim.compensationCents, currency)}`
      : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const first = parts.join(" and ");
  return `${first.charAt(0).toUpperCase()}${first.slice(1)} ${parts.length > 1 ? "are" : "is"} also due under ${law.name}, bringing the total to ${money(claim.totalCents, currency)}.`;
};

const NEXT_STEPS = {
  msme: "refer the matter to the MSME Facilitation Council",
  courts: "pursue recovery through the courts or a collection agency",
} as const;

export type ClaimBasis = {
  country: string;
  region: string | null;
  isBusiness: boolean;
  hasUdyam: boolean;
  outstandingCents: number;
  currency: string;
  dueOn: string;
  asOf: string;
  hasAgreement: boolean;
};

/** The approved law that applies to this debt and the claim under it, or null when none does. */
export const lawClaim = (
  basis: ClaimBasis,
  laws: readonly Law[],
  rates: ReferenceRates,
): { law: Law; claim: Claim } | null => {
  const law = laws.find((candidate) =>
    lawApplies(candidate, basis.country, {
      clientRegion: basis.region,
      clientIsBusiness: basis.isBusiness,
      freelancerHasUdyam: basis.hasUdyam,
      amountCents: basis.outstandingCents,
      currency: basis.currency,
    }),
  );
  if (!law) return null;
  return {
    law,
    claim: statutoryClaim({
      law,
      principalCents: basis.outstandingCents,
      currency: basis.currency,
      dueOn: basis.dueOn,
      asOf: basis.asOf,
      rates,
      hasAgreement: basis.hasAgreement,
    }),
  };
};

/** The facts for one invoice, or why a final demand can't be made for it. */
export const demandFacts = async (
  db: Db,
  invoiceId: string,
  { now, laws, rates }: DemandContext,
  deadlineDays: number = DEADLINE_DAYS.default,
): Promise<{ ok: true; facts: DemandFacts; meta: DemandMeta } | DemandFailure> => {
  const { rows } = await db.query<Row>(SELECT, [invoiceId]);
  const row = rows[0];
  if (!row) return { ok: false, notFound: true };
  const outstanding = toCents(row.amount_cents) - toCents(row.amount_paid_cents);
  const asOf = todayIn(now, row.time_zone);
  if (row.status !== "sent" && row.status !== "partially_paid") {
    return {
      ok: false,
      conflict: `This invoice is ${row.status.replace("_", " ")}, so there is nothing to demand.`,
    };
  }
  if (outstanding <= 0 || !row.link || !row.due_date) {
    return {
      ok: false,
      conflict:
        "This invoice has nothing owing, no pay link or no due date, so a final demand can't be made.",
    };
  }
  const overdue = daysOverdue(row.due_date, now, row.time_zone);
  if (overdue < 1)
    return {
      ok: false,
      conflict:
        "This invoice isn't overdue yet. A final demand is for an invoice past its due date.",
    };
  if (row.held) {
    return {
      ok: false,
      conflict:
        "A reply from this client is waiting for your decision. Decide on it first, then make the final demand.",
    };
  }
  const agreement = row.project_id
    ? (
        await db.query<{ number: string; clause: string | null }>(
          `SELECT number, facts ->> 'lateFeeClauseText' AS clause FROM public.agreements
           WHERE project_id = $1 AND status = 'signed' ORDER BY version DESC LIMIT 1`,
          [row.project_id],
        )
      ).rows[0]
    : undefined;
  const clause = agreement?.clause ?? row.late_fee_clause;
  const currency = row.currency;
  const applied = lawClaim(
    {
      country: row.country,
      region: row.region,
      isBusiness: row.is_business,
      hasUdyam: row.udyam_number !== null,
      outstandingCents: outstanding,
      currency,
      dueOn: row.due_date,
      asOf,
      hasAgreement: agreement !== undefined,
    },
    laws,
    rates,
  );
  const law = applied?.law ?? null;
  const claim = applied?.claim ?? null;
  const deadline = formatFullDay(addCalendarDays(asOf, deadlineDays));
  const clauseText = clause ? squash(clause) : null;
  const msmed = law?.id === MSMED_LAW_ID;
  const statements: DemandStatements = {
    agreement: clauseText
      ? agreement
        ? `Under our signed agreement ${agreement.number}, the late-payment clause says: "${clauseText}"`
        : `Our contract's late-payment clause says: "${clauseText}"`
      : null,
    law: law && !(clauseText ?? "").includes(squash(law.citation)) ? squash(law.citation) : null,
    claim: law && claim ? claimStatement(claim, law, currency) : null,
    nextStep: `If payment isn't received by ${deadline}, I will ${msmed ? NEXT_STEPS.msme : NEXT_STEPS.courts}.`,
    udyam:
      msmed && row.udyam_number ? `My Udyam registration number is ${row.udyam_number}.` : null,
  };
  const paid = toCents(row.amount_paid_cents);
  const facts: DemandFacts = {
    freelancerName: row.freelancer_name,
    clientName: row.client_name,
    projectTitle: row.project_title,
    invoiceNumber: row.invoice_number,
    issueDate: formatFullDay(todayIn(new Date(row.created_at), row.time_zone)),
    dueDate: formatFullDay(row.due_date),
    amountDue: money(outstanding, currency),
    amountPaid: paid > 0 ? money(paid, currency) : null,
    daysOverdue: overdue,
    deadline,
    totalToPay: money(claim && statements.claim ? claim.totalCents : outstanding, currency),
    payLink: row.link,
    statements,
  };
  return {
    ok: true,
    facts,
    meta: {
      citation: (statements.law ?? statements.claim) ? "statute" : clauseText ? "contract" : null,
      lawId: statements.law !== null || statements.claim !== null ? (law?.id ?? null) : null,
      claim: statements.claim === null ? null : claim,
      invoiceId,
      clientId: row.client_id,
    },
  };
};

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

const factStrings = (facts: DemandFacts): string[] => [
  ...Object.values(facts).flatMap((value) =>
    typeof value === "string" || typeof value === "number" ? [String(value)] : [],
  ),
  ...Object.values(facts.statements).filter((statement): statement is string => statement !== null),
];

/** Problems with a schema-valid draft of the letter, in words a log and a test can show. Empty = fine. */
export const demandProblems = (
  draft: Draft,
  facts: DemandFacts,
  laws: readonly Law[] = [],
): string[] => {
  const problems = new Set<string>();
  const text = `${draft.subject}\n${draft.body}`;
  if (/[\r\n]/.test(draft.subject)) problems.add("the subject has a line break");
  const links = [...text.matchAll(URL_PATTERN)].map(([url]) => url.replace(/[.,;:!?]+$/, ""));
  if (!draft.body.includes(facts.payLink)) problems.add("the body doesn't include the pay link");
  if (links.some((url) => url !== facts.payLink))
    problems.add("it has a link other than the pay link");
  const statements = Object.values(facts.statements).filter(
    (statement): statement is string => statement !== null,
  );
  const body = squash(draft.body);
  for (const statement of statements) {
    if (!body.includes(squash(statement)))
      problems.add("it leaves out or changes a required statement");
  }
  if (!body.includes(facts.deadline)) problems.add("it doesn't give the payment deadline");
  const known = factStrings(facts).flatMap((fact) => moneyIn(plain(fact)));
  for (const money of moneyIn(plain(text))) {
    const match = known.find((fact) => fact.amount === money.amount);
    if (!match) problems.add("it mentions an amount that isn't in the facts");
    else if (match.unit !== money.unit)
      problems.add(`it gives an amount in the wrong currency: ${money.written}`);
  }
  for (const date of unknownDates(text, {
    facts: factStrings(facts),
    quoted: [
      facts.freelancerName,
      facts.clientName,
      facts.projectTitle,
      facts.invoiceNumber,
      ...statements,
    ],
  })) {
    problems.add(`it mentions a date that isn't in the facts: ${date}`);
  }
  // Everything legal or about fees must sit inside a given statement: take those out and look again.
  const rest = statements.reduce(
    (left, statement) => left.split(squash(statement)).join(" "),
    squash(text),
  );
  const legal = legalProblem(rest, { citation: null, contractTerms: null, laws });
  if (legal)
    problems.add("it makes a legal or fee reference that isn't one of the given statements");
  return [...problems];
};

const days = (n: number): string => `${String(n)} ${n === 1 ? "day" : "days"}`;

/** The fixed letter, used when no model gives a valid one. Built only from the facts. */
export const demandTemplate = (facts: DemandFacts): Draft => {
  const { statements: s } = facts;
  const paid = facts.amountPaid ? ` I have received ${facts.amountPaid} so far.` : "";
  const paragraphs = [
    `Invoice ${facts.invoiceNumber} for ${facts.projectTitle} was due on ${facts.dueDate}. ${facts.amountDue} is still unpaid, and it is now ${days(facts.daysOverdue)} overdue.${paid} My earlier reminders have not been answered with payment.`,
    ...[s.agreement, s.law, s.claim].filter((part): part is string => part !== null),
    `Please pay ${facts.totalToPay} by ${facts.deadline}. You can pay here:\n${facts.payLink}`,
    s.nextStep,
    ...(s.udyam ? [s.udyam] : []),
  ];
  return {
    subject: `Final demand for payment: invoice ${facts.invoiceNumber}`.slice(0, 200),
    body: [`Dear ${facts.clientName},`, ...paragraphs, `Regards,\n${facts.freelancerName}`].join(
      "\n\n",
    ),
  };
};

const quoted = (value: object): string =>
  JSON.stringify(value).replace(/</g, `${String.fromCharCode(92)}u003c`);

export const demandMessages = (facts: DemandFacts): ChatMessage[] => [
  { role: "system", content: PROMPT_TEXT.final_demand },
  { role: "user", content: `<facts>${quoted(facts)}</facts>` },
];

export type DemandDeps = {
  runAsUser: UserDbRunner;
  box: () => SecretBox;
  context: () => DemandContext;
};

const inputSchema = z.strictObject({
  deadlineDays: z
    .int({ error: "must be a whole number of days" })
    .min(DEADLINE_DAYS.min, `must be at least ${String(DEADLINE_DAYS.min)} days`)
    .max(DEADLINE_DAYS.max, `must be at most ${String(DEADLINE_DAYS.max)} days`)
    .default(DEADLINE_DAYS.default),
});

export type DemandResult = { ok: true; reminderId: string; draft: StoredDraft } | DemandFailure;

/** Makes the letter and leaves it in the Outbox, waiting for approval. Nothing is sent. */
export const draftFinalDemand = async (
  deps: DemandDeps,
  invoiceId: string,
  rawInput: unknown,
): Promise<DemandResult> => {
  const input = inputSchema.safeParse(rawInput ?? {});
  if (!input.success) return { ok: false, errors: toFieldIssues(input.error, { noun: "field" }) };
  const context = deps.context();
  const prepared = await deps.runAsUser(async (db) => {
    const made = await demandFacts(db, invoiceId, context, input.data.deadlineDays);
    if (!made.ok) return made;
    return { ...made, connections: await loadAiConnections(db, "tier3", deps.box()) };
  });
  if (!prepared.ok) return prepared;
  const { facts, meta } = prepared;
  // The model call runs outside any transaction: it can take a minute on a local model.
  const result = await routeTask(prepared.connections, {
    messages: demandMessages(facts),
    schema: draftSchema.superRefine((draft, ctx) => {
      for (const message of demandProblems(draft, facts, context.laws)) {
        ctx.addIssue({ code: "custom", message });
      }
    }),
    template: demandTemplate(facts),
  });
  if (!result.ok)
    throw new Error("The router gave no letter even with a template. Check demandTemplate.");
  const draft: StoredDraft = {
    ...result.output,
    kind: "final_demand",
    via: result.via,
    model: result.via === "model" ? result.model : null,
    isLocal: result.via === "model" ? result.isLocal : null,
    citation: meta.citation,
    lawId: meta.lawId,
    notLegalAdvice: true,
    draftedAt: context.now.toISOString(),
  };
  const saved = await deps.runAsUser(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO public.reminders (user_id, invoice_id, tier, scheduled_at, draft)
       VALUES ((SELECT auth.uid()), $1, 'final_demand', $2, $3)
       ON CONFLICT (invoice_id) WHERE sent_at IS NULL AND approval_status IN ('waiting', 'approved')
       DO NOTHING RETURNING id::text`,
      [invoiceId, context.now.toISOString(), JSON.stringify(draft)],
    );
    const id = rows[0]?.id;
    if (!id) return undefined;
    await db.query(
      `INSERT INTO public.events (user_id, entity, entity_id, type, payload)
       VALUES ((SELECT auth.uid()), 'reminder', $1, 'reminder.drafted', $2)`,
      [
        id,
        JSON.stringify({
          tier: "final_demand",
          via: draft.via,
          model: draft.model,
          citation: draft.citation,
        }),
      ],
    );
    return id;
  });
  if (!saved) {
    return {
      ok: false,
      conflict:
        "This invoice already has a reminder waiting in the Outbox. Approve or skip it first, then make the final demand.",
    };
  }
  logEvent("final_demand.drafted", { reminderId: saved, via: draft.via });
  return { ok: true, reminderId: saved, draft };
};
