import Mustache from "mustache";
import { z } from "zod";
import { isCountryCode, countryName } from "./countries";
import { formatFullDay, formatMoney } from "./format";
import { DOCUMENT_CSP } from "./template-render";

// The project agreement: fixed clause text with options, filled from stored facts. Pure. The
// clauses are written here and nowhere else; no AI writes or edits them (docs/PHASE2-PLAN.md,
// F9), and the owner has a lawyer review this file before real use (docs/NEEDS_YOU.md). Every
// value goes into the page through Mustache's HTML escaping.

export const AGREEMENT_OPTIONS_SCHEMA = z.strictObject({
  depositPercent: z.int({ error: "must be a whole number" }).min(0).max(100).default(30),
  ipTransfer: z
    .enum(["on_full_payment", "on_each_milestone_payment"], {
      error: "must be picked from the list",
    })
    .default("on_full_payment"),
  revisionRounds: z.int({ error: "must be a whole number" }).min(0).max(10).default(2),
  /** Days the client has to accept a deliverable; silence means accepted. */
  acceptanceDays: z.int({ error: "must be a whole number" }).min(1).max(30).default(5),
  killFeePercent: z.int({ error: "must be a whole number" }).min(0).max(100).default(25),
  paymentDays: z.int({ error: "must be a whole number" }).min(1).max(365).default(15),
  lateFee: z
    .discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("statutory") }),
      z
        .strictObject({
          mode: z.literal("contract_rate"),
          /** Basis points a month (150 = 1.5%), so no rate is ever a float. */
          rateBpPerMonth: z
            .int({ error: "must be a whole number of basis points" })
            .min(0)
            .max(300),
          fixedFeeCents: z
            .int({ error: "must be a whole number of cents" })
            .min(0)
            .max(100_000_000),
        })
        .refine((fee) => fee.rateBpPerMonth > 0 || fee.fixedFeeCents > 0, {
          error: "Set a monthly rate, a fixed fee, or both.",
        }),
    ])
    .default({ mode: "statutory" }),
  governingLawCountry: z
    .string({ error: "must be picked from the list" })
    .refine(isCountryCode, "must be picked from the list"),
  disputeStep: z.literal("negotiate_30_days_then_courts").default("negotiate_30_days_then_courts"),
  confidentiality: z.boolean().default(true),
  portfolioUse: z.boolean().default(true),
});

export type AgreementOptions = z.output<typeof AGREEMENT_OPTIONS_SCHEMA>;

export const PAYMENT_MODES = ["pay_on_invoice", "deposit", "hold"] as const;

/** Everything the document is filled from. Snapshotted into the agreement when it is saved. */
export const agreementFactsSchema = z.strictObject({
  freelancer: z.strictObject({
    legalName: z.string(),
    businessName: z.string().nullable(),
    address: z.string().nullable(),
    email: z.string(),
    udyamNumber: z.string().nullable(),
  }),
  client: z.strictObject({
    name: z.string(),
    company: z.string().nullable(),
    address: z.string().nullable(),
    email: z.string(),
    country: z.string(),
    region: z.string().nullable(),
  }),
  project: z.strictObject({
    title: z.string(),
    scope: z.string().nullable(),
    totalCents: z.int().positive(),
    currency: z.string(),
    deadline: z.iso.date().nullable(),
  }),
  milestones: z.array(
    z.strictObject({
      name: z.string(),
      amountCents: z.int().positive(),
      deadline: z.iso.date(),
      paymentMode: z.enum(PAYMENT_MODES),
    }),
  ),
  /** Retainers and maintenance on this project, one plain sentence each. */
  ongoing: z.array(z.string()),
  effectiveDate: z.iso.date(),
  /** The sentence of an approved law that applies to this client and amount, or null. */
  lawCitation: z.string().nullable(),
  /** Set when the agreement is sent: section 4's text, which Tier 3 and the final demand quote. */
  lateFeeClauseText: z.string().optional(),
});

export type AgreementFacts = z.output<typeof agreementFactsSchema>;

/** The deposit in cents: total × percent, rounded half up, in integers. */
export const depositCents = (totalCents: number, percent: number): number =>
  Number((BigInt(totalCents) * BigInt(percent) + 50n) / 100n);

/** 150 → "1.5%", 125 → "1.25%", 300 → "3%". */
const percentFromBp = (bp: number): string => {
  const fraction = String(bp % 100)
    .padStart(2, "0")
    .replace(/0$/, "");
  return `${String(Math.floor(bp / 100))}${fraction ? `.${fraction}` : ""}%`;
};

const plural = (count: number, one: string): string =>
  `${String(count)} ${one}${count === 1 ? "" : "s"}`;

/** Section 4's text. Also stored on the agreement when it is sent. */
export const lateFeeClauseText = (facts: AgreementFacts, options: AgreementOptions): string => {
  if (options.lateFee.mode === "statutory") {
    return facts.lawCitation
      ? `If an invoice is paid late: ${facts.lawCitation}`
      : "If an invoice is paid late, the Freelancer may claim interest and recovery costs as allowed by the law that applies.";
  }
  const { rateBpPerMonth, fixedFeeCents: fee } = options.lateFee;
  const parts = [
    rateBpPerMonth > 0 ? `interest of ${percentFromBp(rateBpPerMonth)} a month` : null,
    fee > 0 ? `a fixed late fee of ${formatMoney(fee, facts.project.currency)}` : null,
  ].filter((part): part is string => part !== null);
  return `If an invoice is not paid by its due date, the Client will pay ${parts.join(" and ")} on the unpaid amount.`;
};

const MODE_LABELS: Record<(typeof PAYMENT_MODES)[number], string> = {
  pay_on_invoice: "Invoice",
  deposit: "Deposit",
  hold: "Held on PayPal, charged on acceptance",
};

const TEMPLATE = `
<h1>Project agreement</h1>
<h2>1. Parties</h2>
<p>This agreement is between <strong>{{freelancer.name}}</strong>{{#freelancer.business}} (trading as {{freelancer.business}}){{/freelancer.business}}{{#freelancer.address}}, {{freelancer.address}}{{/freelancer.address}}, {{freelancer.email}}{{#freelancer.udyam}}, Udyam registration {{freelancer.udyam}}{{/freelancer.udyam}} (the "Freelancer"), and <strong>{{client.name}}</strong>{{#client.company}} of {{client.company}}{{/client.company}}{{#client.address}}, {{client.address}}{{/client.address}}, {{client.email}} (the "Client"). It starts on {{effective}}.</p>
<h2>2. Services and deliverables</h2>
<p class="scope">The Freelancer will carry out the project "{{project.title}}"{{#project.scope}}: {{project.scope}}{{/project.scope}}{{^project.scope}}.{{/project.scope}}</p>
{{#hasMilestones}}
<table><thead><tr><th>Milestone</th><th>Due</th><th>Amount</th><th>How it is paid</th></tr></thead><tbody>
{{#milestones}}<tr><td>{{name}}</td><td>{{due}}</td><td>{{amount}}</td><td>{{how}}</td></tr>{{/milestones}}
</tbody></table>
{{/hasMilestones}}
{{^hasMilestones}}<p>{{#project.deadline}}The whole project is to be delivered by {{project.deadline}}.{{/project.deadline}}{{^project.deadline}}The project is to be delivered on a schedule the parties agree in writing.{{/project.deadline}}</p>{{/hasMilestones}}
<h2>3. Fees and payment</h2>
<p>The total fee is <strong>{{project.total}}</strong>.{{#hasDeposit}} A deposit of {{deposit.percent}} ({{deposit.amount}}) is due before work starts. The balance of {{deposit.balance}} is paid as set out in section 2{{^hasMilestones}}, on delivery{{/hasMilestones}}.{{/hasDeposit}}</p>
<p>The Freelancer invoices each payment through PayPal, and the Client pays using the PayPal link on the invoice. Each invoice is due {{paymentDays}} after its date. All amounts are in {{project.currency}}.</p>
{{#ongoing.length}}<p>Ongoing services on this project:</p><ul>{{#ongoing}}<li>{{.}}</li>{{/ongoing}}</ul>{{/ongoing.length}}
<h2>4. Late payment</h2>
<p>{{lateFee}}</p>
<h2>5. Changes to the work</h2>
<p>Work outside what is described in section 2 is a change. The Freelancer quotes any change in writing before starting it, and starts only after the Client agrees to the quote in writing. Email is enough.</p>
<h2>6. Revisions and acceptance</h2>
<p>{{revisions}} The Client has {{acceptance}} after a deliverable is delivered to accept it or ask for revisions. If the Client says nothing in that time, the deliverable is treated as accepted.</p>
<h2>7. Ownership</h2>
<p>{{ownership}} Until then the Client may use the deliverables only to review them, and not publicly or commercially. The Freelancer keeps ownership of its tools, methods and know-how.</p>
<h2>8. Cancellation</h2>
<p>Either party may cancel this agreement by written notice. If the Client cancels, the Client pays for the work done up to the notice{{#killFee}}, plus a cancellation fee of {{killFee}} of the fee for the work not yet done{{/killFee}}.</p>
<h2>9. Confidentiality and portfolio</h2>
<p>{{confidentiality}} {{portfolio}}</p>
<h2>10. Governing law and disputes</h2>
<p>This agreement is governed by the law of {{governingLaw}}. If a disagreement comes up, the parties first try to settle it by talking, for up to 30 days after one of them writes to the other about it. If they cannot settle it, either may take it to the courts of {{governingLaw}}.</p>
<h2>11. Electronic signature</h2>
<p>Both parties agree to sign this agreement electronically. A typed full name together with the ticked agreement box counts as a signature. Each party keeps a copy of the signed agreement and the record of when and how it was signed.</p>
<h2>12. Signatures</h2>
<p>The signatures, with their dates and times, are recorded on the certificate page that comes with the signed copy.</p>
`;

const STYLE =
  "body{font-family:Georgia,serif;font-size:11pt;line-height:1.5;color:#111;max-width:46rem;margin:2rem auto;padding:0 1rem}" +
  "h1{font-size:20pt}h2{font-size:12.5pt;margin:1.4em 0 .3em}.scope{white-space:pre-line}" +
  "table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:.3em .5em;text-align:left;vertical-align:top}";

const view = (facts: AgreementFacts, options: AgreementOptions): Record<string, unknown> => {
  const { project, freelancer, client } = facts;
  const money = (cents: number): string => formatMoney(cents, project.currency);
  const deposit = depositCents(project.totalCents, options.depositPercent);
  const rounds = options.revisionRounds;
  const perMilestone = options.ipTransfer === "on_each_milestone_payment";
  return {
    freelancer: {
      name: freelancer.legalName,
      business: freelancer.businessName,
      address: freelancer.address,
      email: freelancer.email,
      udyam: freelancer.udyamNumber,
    },
    client,
    effective: formatFullDay(facts.effectiveDate),
    project: {
      title: project.title,
      scope: project.scope,
      total: money(project.totalCents),
      currency: project.currency,
      deadline: project.deadline ? formatFullDay(project.deadline) : "",
    },
    hasMilestones: facts.milestones.length > 0,
    milestones: facts.milestones.map((m) => ({
      name: m.name,
      due: formatFullDay(m.deadline),
      amount: money(m.amountCents),
      how: MODE_LABELS[m.paymentMode],
    })),
    hasDeposit: deposit > 0,
    deposit: {
      percent: `${String(options.depositPercent)}%`,
      amount: money(deposit),
      balance: money(project.totalCents - deposit),
    },
    paymentDays: plural(options.paymentDays, "day"),
    ongoing: facts.ongoing,
    lateFee: facts.lateFeeClauseText ?? lateFeeClauseText(facts, options),
    revisions:
      rounds === 0
        ? "No rounds of revisions are included; any revision is a change (section 5)."
        : `Each deliverable includes ${plural(rounds, "round")} of revisions. Further rounds are a change (section 5).`,
    acceptance: plural(options.acceptanceDays, "day"),
    ownership: perMilestone
      ? "The Client owns the deliverables of each milestone once the invoice for that milestone has been paid in full."
      : "The Client owns the final deliverables once the Freelancer has been paid in full.",
    killFee: options.killFeePercent > 0 ? `${String(options.killFeePercent)}%` : "",
    confidentiality: options.confidentiality
      ? "Each party keeps the other's non-public business information confidential and uses it only for this project."
      : "This agreement adds no confidentiality terms.",
    portfolio: options.portfolioUse
      ? "The Freelancer may show the finished work in their portfolio and name the Client as a client, unless the Client asks in writing not to."
      : "The Freelancer will not show the work in their portfolio without the Client's written consent.",
    governingLaw: countryName(options.governingLawCountry),
  };
};

/** The full document. The Content-Security-Policy lets it load nothing, like invoice documents. */
export const renderAgreement = (
  facts: AgreementFacts,
  options: AgreementOptions,
): { html: string } => {
  const body = Mustache.render(TEMPLATE, view(facts, options), {}, { escape: Mustache.escape });
  return {
    html: [
      "<!DOCTYPE html>",
      '<html lang="en"><head><meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">`,
      `<title>Project agreement</title><style>${STYLE}</style>`,
      `</head><body>${body}</body></html>`,
    ].join(""),
  };
};
